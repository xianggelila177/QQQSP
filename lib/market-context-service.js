import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createTaskQueue} from './task-queue.js';
import {symbolValid} from './symbol-validation.js';
import {marketKeyFor} from './instruments.js';
import {historyQuery} from './history-contract.js';
import {buildMarketContext} from './market-context-format.js';

export {CONTEXT_SECTIONS,parseContextQuery} from './context-query.js';
export {contextError} from './api-error.js';
import {parseContextQuery} from './context-query.js';
import {contextError} from './api-error.js';

export function createMarketContextService({engine,history,samples,news,macro,advanced,now=Date.now,clock=()=>performance.now()}={}){
 const queue=createTaskQueue({maxActive:1,maxQueued:2,now:clock});
 let lifetime=new AbortController(),closed=false;
 const stats={requests:0,completed:0,partial:0,unavailable:0,cancelled:0};
 function sourceFinished(q,section){
  if(!q||q.pending)return false;
  if(q.error)return true;
  if(section==='fundamentals'){
   if(!['EQUITY','ETF','MUTUALFUND'].includes(q.instrumentType||'EQUITY'))return true;
   return !!q.fundamentals&&!q.fundamentals.loading&&q.fundamentals.status!=='loading';
  }
  if(section==='intraday'){
   const info=q.slowFields?.intraday;
   return !!info?.error||['unsupported','not-applicable','no-history'].includes(info?.status)||Array.isArray(q.charts?.intraday)&&q.charts.intraday.length>0&&!info?.stale;
  }
  const cadence=Math.max(0,...[q.checkIntervalMs,q.pollAfterMs].filter(Number.isFinite));
  if(!(q.sourceCheckedAt>0)||q.sourceCheckedAt>now()||now()-q.sourceCheckedAt>Math.max(60000,cadence*2+5000))return false;
  return !(q.stale||q.recovery)||q.staleInfo?.retryAt>now();
 }
 async function collect(query,{signal,deadline,requestId}){
  const soft=new AbortController(),combined=AbortSignal.any([signal,soft.signal]);
  const remaining=Math.max(0,deadline-clock());
  const values={},errors={},pending=new Set();let finished=false,release,unlisten,poll;
  const timeout=setTimeout(()=>soft.abort(contextError('CONTEXT_TIMEOUT',503)),remaining);
  const includes=key=>query.include.includes(key);
  const historicalIntraday=['intraday_before','intraday_month','intraday_date'].some(k=>query[k]!==undefined);
  const needsEngine=key=>includes(key)&&!(key==='intraday'&&historicalIntraday);
  const capture=()=>{try{const q=engine?.read([query.symbol],{lease:false})?.[0];if(q?.symbol===query.symbol)values.quote=q;}catch{for(const name of ['quote','fundamentals','intraday'].filter(needsEngine))errors[name]={code:'SOURCE_UNAVAILABLE'};}};
  const task=(name,fn)=>{
   pending.add(name);
   return Promise.resolve().then(()=>{combined.throwIfAborted();return fn();}).then(value=>{if(!finished)values[name]=value;},error=>{if(!finished)errors[name]={code:error?.code||'SOURCE_UNAVAILABLE',retryAt:Number(error?.retryAt)||null};}).finally(()=>pending.delete(name));
  };
  const waitingSections=new Set();
  let wake;
  const aborted=new Promise(resolve=>{wake=resolve;combined.addEventListener('abort',wake,{once:true});if(combined.aborted)wake();});
  try{
   const jobs=[];
   if(includes('samples')){try{values.samples=samples?.snapshot(query.symbol);}catch{errors.samples={code:'SOURCE_UNAVAILABLE'};}}
   if(includes('macro')){try{values.macro=macro?.snapshot();}catch{errors.macro={code:'SOURCE_UNAVAILABLE'};}}
   // News refresh is a temporary cancellable cache fill, never a watchlist lease.
   // Zero budget retains the cache-only contract; fresh caches avoid extra I/O.
   if(includes('news')){
    try{values.news=news?.peek(query.symbol);}catch{errors.news={code:'SOURCE_UNAVAILABLE'};}
    if(remaining>0&&news?.requestNews&&(!values.news?.updatedAt||values.news.stale))jobs.push(task('news',()=>news.requestNews(query.symbol,{activate:false,signal:combined})));
   }
   if(['quote','intraday','fundamentals'].some(needsEngine)){
    if(remaining>0){release=engine.watch([query.symbol]);engine.poke(query.symbol);}capture();
    if(remaining>0)jobs.push(task('quote',()=>new Promise(resolve=>{
     for(const section of ['quote','intraday','fundamentals'].filter(needsEngine))waitingSections.add(section);
     let done=false;
     const finish=()=>{if(done)return;done=true;capture();combined.removeEventListener('abort',finish);resolve(values.quote);};
     const inspect=()=>{capture();for(const section of waitingSections)if(sourceFinished(values.quote,section))waitingSections.delete(section);if(!waitingSections.size)finish();};
     combined.addEventListener('abort',finish,{once:true});
     unlisten=engine.subscribe(changed=>{if(changed.includes(query.symbol))inspect();});
     poll=setInterval(inspect,1000);inspect();if(combined.aborted)finish();
    })));
   }
   const options={signal:combined,deadlineAt:now()+Math.max(1,deadline-clock()),cacheOnly:remaining<=0};
   if(includes('daily'))jobs.push(task('daily',()=>query.adjustment!==undefined
    ? advanced?.daily?advanced.daily(query,options):Promise.reject(contextError('ADJUSTMENT_SOURCE_NOT_CONFIGURED',503))
    : history.get(query.symbol,query.daily_granularity||'daily',{count:query.daily_bar_count,before:query.daily_before,seriesId:query.daily_series_id,...options})));
   if(includes('intraday')&&historicalIntraday)jobs.push(task('intraday',()=>advanced?.intraday?advanced.intraday(query,options):Promise.reject(contextError('INTRADAY_SOURCE_NOT_CONFIGURED',503))));
   if(includes('corporate_actions'))jobs.push(task('corporate_actions',()=>advanced?.actions?advanced.actions(query,options):Promise.reject(contextError('ACTIONS_SOURCE_NOT_CONFIGURED',503))));
   await Promise.race([Promise.all(jobs),aborted]);
   signal.throwIfAborted();
   if(values.quote||release)capture();
   if(soft.signal.aborted){for(const name of pending)if(name!=='quote')errors[name]={code:'CONTEXT_TIMEOUT'};for(const name of waitingSections)errors[name]={code:'CONTEXT_TIMEOUT'};}
   finished=true;
   const out=buildMarketContext({query,requestId,generatedAt:now(),...values,errors});
   stats.completed++;if(out.status==='partial')stats.partial++;if(out.status==='unavailable')stats.unavailable++;
   return out;
  }finally{
   finished=true;clearTimeout(timeout);clearInterval(poll);unlisten?.();release?.();combined.removeEventListener('abort',wake);
   if(!soft.signal.aborted)soft.abort(contextError('REQUEST_CANCELLED',499));
  }
 }
 async function query(value,{signal,requestId=randomUUID(),startedAt=clock()}={}){
  if(closed)throw contextError('STOPPED',503);
  const normalized=parseContextQuery(value),deadline=startedAt+normalized.max_wait_ms;
  const waiting=new AbortController(),combined=AbortSignal.any([lifetime.signal,waiting.signal,...(signal?[signal]:[])]);
  let started=false;
  const timer=setTimeout(()=>{if(!started)waiting.abort(contextError('CONTEXT_TIMEOUT',503));},Math.max(1,deadline-clock()));
  stats.requests++;
  try{return await queue.run(taskSignal=>{started=true;clearTimeout(timer);if(!normalized.symbols)return collect(normalized,{signal:taskSignal,deadline,requestId});
    const {symbols,...single}=normalized;
    return Promise.all(symbols.map(async symbol=>{try{return await collect({...single,symbol},{signal:taskSignal,deadline,requestId:requestId+':'+symbol});}catch(error){taskSignal.throwIfAborted();return buildMarketContext({query:{...single,symbol},requestId:requestId+':'+symbol,generatedAt:now(),errors:Object.fromEntries(single.include.map(name=>[name,{code:'SOURCE_UNAVAILABLE'}]))});}})).then(results=>({schema_version:1,request_id:requestId,generated_at_ms:now(),status:results.every(r=>r.status==='unavailable')?'unavailable':results.every(r=>r.status==='complete')?'complete':'partial',coverage:{requested_symbols:symbols.length,returned_symbols:results.length,quota_cost:symbols.length},results}));},{signal:combined});}
  catch(error){if(error.code==='CAPACITY_EXCEEDED')throw contextError('CONTEXT_BUSY',503);stats.cancelled++;throw error;}
  finally{clearTimeout(timer);}
 }
 return {query,close(){closed=true;lifetime.abort(contextError('STOPPED',503));queue.close();},reopen(){if(closed){closed=false;lifetime=new AbortController();queue.reopen();}},diagnostics:()=>({...stats,...queue.diagnostics()})};
}
