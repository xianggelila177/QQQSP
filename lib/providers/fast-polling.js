import {createSinaQuotes} from './sina-quotes.js';
import {marketStateFor} from '../../mkt.mjs';
import {mergeTradingStatistics} from '../trading-statistics.js';
import {createSourcePolling} from '../source-polling.js';
import {quoteDisplayName} from '../instruments.js';

// One user, a handful of symbols: source cache + one in-flight batch per source.
// A slow missing sibling is filled in the background, not on the healthy path.
export function createFastPolling({httpsGet,legacy,finnhubQuotes=null,twseQuotes=null,now=Date.now,pollMs=1000,preferred='sina',probeMs=30000}={}) {
  const sources={sina:createSinaQuotes({httpsGet,now,pollMs}),tencent:legacy.tencent,
    naver:async list=>legacy.fetchSnapshotBatch(list,{group:'us'})};
  if(finnhubQuotes)sources.finnhub=finnhubQuotes;
  if(twseQuotes)sources.twse=twseQuotes.fetchQuotes;
  const next=new Map(),cached=new Map(),jobs=new Map(),naverIssues=new Map();
  const rotation=createSourcePolling({now,intervalMs:Math.max(pollMs,probeMs)});
  let epoch=0,requests=0,failures=0;
  const key=(id,s)=>id+':'+s;
  async function read(id,symbols,owner=epoch,force=false) {
    if(owner!==epoch)return [];
    const existing=jobs.get(id);
    if(existing){
      await existing;if(owner!==epoch)return [];
      // Sharing another batch must not silently drop a newly requested symbol.
      // Only uncovered siblings get a follow-up; covered siblings are not
      // re-fetched just because network time crossed their TTL boundary.
      const uncovered=existing.owner===owner?symbols.filter(s=>!existing.symbols.has(s)):symbols;
      if(uncovered.length)await read(id,uncovered,owner,force);
      return symbols.map(s=>cached.get(key(id,s))).filter(Boolean);
    }
    // Compare all siblings at one instant; crossing a millisecond boundary must
    // not turn a coalesced batch into per-card upstream calls.
    const cutoff=now(),due=symbols.filter(s=>force||cutoff>=(next.get(key(id,s))||0));
    if(due.length&&!jobs.has(id)) {
      const started=cutoff;requests++;
      const job=Promise.resolve().then(()=>{
        if(owner!==epoch)throw Object.assign(new Error('Polling reset'),{code:'STOPPED'});
        return sources[id](due,{force});
      }).then(result=>{
        if(owner!==epoch)return;
        const rows=Array.isArray(result)?result:result?.quotes||[];
        const map=new Map(rows.map(q=>[q.symbol,q]));
        for(const s of due){
          const q=map.get(s),k=key(id,s);
          if(id==='naver'){
            const issue=result?.identityIssues?.[s];
            if(['NAVER_NO_DATA','NAVER_IDENTITY_CONFLICT','NAVER_QUOTE_UNUSABLE'].includes(issue))naverIssues.set(s,issue);
            else naverIssues.delete(s);
          }
          next.set(k,started+(q?Math.max(pollMs,q.pollAfterMs||pollMs):id==='finnhub'?5000:60000));
          if(q)cached.set(k,q);else cached.delete(k);
        }
        while(naverIssues.size>200)naverIssues.delete(naverIssues.keys().next().value);
      },error=>{
        if(owner!==epoch)return;failures++;
        const until=Math.max(now()+30000,error.retryAt||0,now()+(error.retryAfterMs||0));
        for(const s of due){next.set(key(id,s),until);cached.delete(key(id,s));if(id==='naver')naverIssues.delete(s);}
      }).finally(()=>{if(jobs.get(id)===job)jobs.delete(id);});
      Object.assign(job,{owner,symbols:new Set(due)});jobs.set(id,job);
    }
    if(jobs.has(id))await jobs.get(id);
    return symbols.map(s=>cached.get(key(id,s))).filter(Boolean);
  }
  const future=q=>Number(q?.quoteAt)>now()+5000;
  function old(q) {
    if(!q||future(q))return true;
    if(!['REGULAR','PRE','POST','AUCTION'].includes(marketStateFor(q.symbol,null,now())))return false;
    return now()-q.quoteAt>Math.max(15000,(q.feedDelayMinutes||0)*60000+10000);
  }
  const rank=q=>q?.src==='finnhub-quote'?0:1;
  function pick(best,rows){for(const q of rows){if(future(q))continue;const prior=best.get(q.symbol),wins=!prior||q.quoteAt>prior.quoteAt||
    q.quoteAt===prior.quoteAt&&(rank(q)<rank(prior)||rank(q)===rank(prior)&&q.sourceCheckedAt>prior.sourceCheckedAt);
    const winner=wins?q:prior,other=wins?prior:q;
    const merged={...mergeTradingStatistics(winner,other,{now:now()})};
    if(merged.displayName===merged.symbol&&other?.displayName)merged.displayName=quoteDisplayName(merged.symbol,other.displayName);
    best.set(q.symbol,merged);}}
  async function backups(order,symbols,best,owner,force=false) {
    if(owner!==epoch||!order.length||!symbols.length)return;
    const [id,...rest]=order;
    const rows=await read(id,symbols,owner,force);if(owner!==epoch)return;pick(best,rows);
    // Poll the selected backup on its own cadence, even when its last quote
    // is still fresh. Freshness is not a reason to freeze a healthy fallback.
    const needed=force?symbols:symbols.filter(s=>old(cached.get(key(id,s))));
    const work=backups(rest,needed,best,owner,force);
    if(!force&&rows.some(q=>!old(q)))void work.catch(()=>{});else await work;
  }
  return {
    async fetchSnapshotBatch(symbols,{group,force=false}={}) {
      const owner=epoch;
      if(group==='kr'||group==='jp'||group==='index')return legacy.fetchSnapshotBatch(symbols,{group});
      if(group==='tw'){
        if(!twseQuotes)return {quotes:[],pollAfterMs:60000};
        const quotes=await read('twse',symbols,owner,force);
        if(owner!==epoch)throw Object.assign(new Error('Polling reset'),{code:'STOPPED'});
        const at=now(),nextPollAtBySymbol={};
        for(const symbol of symbols)nextPollAtBySymbol[symbol]=Math.max(at+pollMs,next.get(key('twse',symbol))||at+60000);
        return {quotes,pollAfterMs:Math.max(pollMs,5000),nextPollAtBySymbol};
      }
      const publicOrder=preferred==='tencent'?['tencent','sina','naver']:['sina','tencent','naver'];
      const order=group==='other'?['tencent','sina']:finnhubQuotes?['finnhub',...publicOrder]:publicOrder;
      const best=new Map();
      // Reuse valid backup results without generating new upstream requests.
      for(const id of order)pick(best,symbols.map(s=>cached.get(key(id,s))).filter(Boolean));
      const primary=await read(order[0],symbols,owner,force);pick(best,primary);
      if(owner!==epoch)throw Object.assign(new Error('Polling reset'),{code:'STOPPED'});
      const needed=force?symbols:symbols.filter(s=>old(cached.get(key(order[0],s))));
      const work=backups(order.slice(1),needed,best,owner,force);
      if(!force&&(finnhubQuotes?primary.length===symbols.length&&primary.every(q=>!old(q)):primary.some(q=>!old(q))))
        void work.catch(()=>{});else await work;
      if(owner!==epoch)throw Object.assign(new Error('Polling reset'),{code:'STOPPED'});
      // Each symbol owns a turn so a fast sibling cannot consume all probes.
      // Coalesce matching turns into at most one batch per backup source;
      // healthy prices never wait for them and each source retains one job.
      const probes=new Map();
      if(!force)for(const symbol of symbols){const id=rotation.take(symbol,order.slice(1));if(id){if(!probes.has(id))probes.set(id,[]);probes.get(id).push(symbol);}}
      for(const [id,list]of probes)void read(id,list,owner).catch(()=>{});
      // A healthy regular close says nothing about the later extended session.
      // Continue to verify that source on closed markets, respecting its own TTL.
      if(group==='us'){
        const closed=symbols.filter(s=>['CLOSED','HOLIDAY'].includes(marketStateFor(s,null,now())));
        if(closed.length)await read('naver',closed);
      }
      if(owner!==epoch)throw Object.assign(new Error('Polling reset'),{code:'STOPPED'});
      best.clear();
      for(const id of order)pick(best,symbols.map(s=>cached.get(key(id,s))).filter(Boolean));
      const quotes=[...best.values()].map(q=>({...q,checkIntervalMs:q.pollAfterMs,pollAfterMs:pollMs}));
      while(next.size>600){const k=next.keys().next().value;next.delete(k);cached.delete(k);}
      // Carry source TTL deadlines to the outer scheduler. Returning only a
      // relative interval lets two clocks differ by 1 ms and skip a full cycle
      // after a cache-only read. Expired, unused backup slots are not deadlines.
      // A slow request may also outlive the selected source's next deadline;
      // another source's long cooldown must not freeze cache evaluation. This
      // outer cadence never changes the per-source TTL/Retry-After in read().
      const nextPollAtBySymbol={},at=now();
      for(const symbol of symbols){
        const deadlines=order.map(id=>next.get(key(id,symbol))).filter(t=>t>at);
        nextPollAtBySymbol[symbol]=Math.min(at+pollMs,...deadlines);
      }
      const identityIssues=Object.fromEntries(symbols.filter(s=>naverIssues.has(s)).map(s=>[s,naverIssues.get(s)]));
      return {quotes,pollAfterMs:pollMs,nextPollAtBySymbol,identityIssues};
    },
    diagnostics:()=>({mode:'batch-polling',primary:finnhubQuotes?'finnhub':preferred,preferred,pollMs,probeMs:Math.max(pollMs,probeMs),requests,failures,slots:next.size,inflight:jobs.size}),
    reset(){epoch++;next.clear();cached.clear();naverIssues.clear();rotation.clear();}
  };
}
