import {createSinaQuotes} from './sina-quotes.js';
import {marketStateFor} from '../../mkt.mjs';
import {mergeTradingStatistics} from '../trading-statistics.js';

// One user, a handful of symbols: source cache + one in-flight batch per source.
// A slow missing sibling is filled in the background, not on the healthy path.
export function createFastPolling({httpsGet,legacy,now=Date.now,pollMs=1000,preferred='sina'}={}) {
  const sources={sina:createSinaQuotes({httpsGet,now,pollMs}),tencent:legacy.tencent,
    naver:async list=>(await legacy.fetchSnapshotBatch(list,{group:'us'})).quotes};
  const next=new Map(),cached=new Map(),jobs=new Map();
  const key=(id,s)=>id+':'+s;
  async function read(id,symbols) {
    const due=symbols.filter(s=>now()>=(next.get(key(id,s))||0));
    if(due.length&&!jobs.has(id)) {
      const started=now();
      const job=Promise.resolve().then(()=>sources[id](due)).then(rows=>{
        const map=new Map(rows.map(q=>[q.symbol,q]));
        for(const s of due){
          const q=map.get(s),k=key(id,s);
          next.set(k,started+(q?Math.max(pollMs,q.pollAfterMs||pollMs):60000));
          if(q)cached.set(k,q);else cached.delete(k);
        }
      },error=>{
        const until=Math.max(now()+30000,error.retryAt||0,now()+(error.retryAfterMs||0));
        for(const s of due){next.set(key(id,s),until);cached.delete(key(id,s));}
      }).finally(()=>jobs.delete(id));
      jobs.set(id,job);
    }
    if(jobs.has(id))await jobs.get(id);
    return symbols.map(s=>cached.get(key(id,s))).filter(Boolean);
  }
  function old(q) {
    if(!q)return true;
    if(!['REGULAR','PRE','POST','AUCTION'].includes(marketStateFor(q.symbol,null,now())))return false;
    return now()-q.quoteAt>Math.max(15000,(q.feedDelayMinutes||0)*60000+10000);
  }
  function pick(best,rows){for(const q of rows){const prior=best.get(q.symbol),wins=!prior||q.quoteAt>prior.quoteAt||q.quoteAt===prior.quoteAt&&q.sourceCheckedAt>prior.sourceCheckedAt;best.set(q.symbol,mergeTradingStatistics(wins?q:prior,wins?prior:q,{now:now()}));}}
  async function backups(order,symbols,best) {
    if(!order.length||!symbols.length)return;
    const [id,...rest]=order;
    const rows=await read(id,symbols);pick(best,rows);
    // Poll the selected backup on its own cadence, even when its last quote
    // is still fresh. Freshness is not a reason to freeze a healthy fallback.
    const needed=symbols.filter(s=>old(cached.get(key(id,s))));
    const work=backups(rest,needed,best);
    if(rows.some(q=>!old(q)))void work.catch(()=>{});else await work;
  }
  return {
    async fetchSnapshotBatch(symbols,{group}={}) {
      if(group==='kr')return legacy.fetchSnapshotBatch(symbols,{group});
      const order=group==='other'?['tencent','sina']:preferred==='tencent'?['tencent','sina','naver']:['sina','tencent','naver'];
      const best=new Map();
      // Reuse valid backup results without generating new upstream requests.
      for(const id of order)pick(best,symbols.map(s=>cached.get(key(id,s))).filter(Boolean));
      const primary=await read(order[0],symbols);pick(best,primary);
      const needed=symbols.filter(s=>old(cached.get(key(order[0],s))));
      const work=backups(order.slice(1),needed,best);
      if(primary.some(q=>!old(q)))void work.catch(()=>{});else await work;
      // A healthy regular close says nothing about the later extended session.
      // Continue to verify that source on closed markets, respecting its own TTL.
      if(group==='us'){
        const closed=symbols.filter(s=>['CLOSED','HOLIDAY'].includes(marketStateFor(s,null,now())));
        if(closed.length)await read('naver',closed);
      }
      best.clear();
      for(const id of order)pick(best,symbols.map(s=>cached.get(key(id,s))).filter(Boolean));
      const quotes=[...best.values()].map(q=>({...q,checkIntervalMs:q.pollAfterMs,pollAfterMs:pollMs}));
      while(next.size>600){const k=next.keys().next().value;next.delete(k);cached.delete(k);}
      // Carry source TTL deadlines to the outer scheduler. Returning only a
      // relative interval lets two clocks differ by 1 ms and skip a full cycle
      // after a cache-only read. Expired, unused backup slots are not deadlines.
      const nextPollAtBySymbol={},at=now();
      for(const symbol of symbols){
        const deadlines=order.map(id=>next.get(key(id,symbol))).filter(t=>t>at);
        if(deadlines.length)nextPollAtBySymbol[symbol]=Math.min(...deadlines);
      }
      return {quotes,pollAfterMs:pollMs,nextPollAtBySymbol};
    },
    diagnostics:()=>({mode:'batch-polling',preferred,pollMs,slots:next.size,inflight:jobs.size}),
    reset(){next.clear();cached.clear();}
  };
}
