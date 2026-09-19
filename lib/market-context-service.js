import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createTaskQueue} from './task-queue.js';
import {symbolValid} from './symbol-validation.js';
import {marketKeyFor} from './instruments.js';
import {buildMarketContext} from './market-context-format.js';

export const CONTEXT_SECTIONS=Object.freeze(['quote','intraday','daily','samples','fundamentals','news','macro']);
export const contextError=(code,statusCode=400)=>Object.assign(new Error(code),{code,statusCode});
export function parseContextQuery(value){
 const keys=['symbol','daily_bar_count','sample_trading_days','include','max_wait_ms','format'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw contextError('BAD_CONTEXT_QUERY');
 const symbol=typeof value.symbol==='string'&&value.symbol.length<=64?value.symbol.trim().toUpperCase():'';
 if(!symbolValid(symbol)||!marketKeyFor(symbol))throw contextError('BAD_CONTEXT_QUERY');
 const query={symbol,daily_bar_count:252,sample_trading_days:3,include:[...CONTEXT_SECTIONS],max_wait_ms:15000,format:'compact',...value};query.symbol=symbol;
 for(const [key,min,max] of [['daily_bar_count',1,500],['sample_trading_days',1,3],['max_wait_ms',0,15000]])if(!Number.isInteger(query[key])||query[key]<min||query[key]>max)throw contextError('BAD_CONTEXT_QUERY');
 if(query.format!=='compact'||!Array.isArray(query.include)||!query.include.length||query.include.length>CONTEXT_SECTIONS.length||query.include.some(s=>!CONTEXT_SECTIONS.includes(s))||new Set(query.include).size!==query.include.length)throw contextError('BAD_CONTEXT_QUERY');
 return query;
}

export function createMarketContextService({engine,history,samples,news,macro,now=Date.now,clock=()=>performance.now()}={}){
 const queue=createTaskQueue({maxActive:1,maxQueued:2,now:clock});
 let lifetime=new AbortController(),closed=false;
 const stats={requests:0,completed:0,partial:0,unavailable:0,cancelled:0};
 function sourceFinished(q,sections){
  if(!q||q.pending)return false;
  if(q.error)return true;
  const cadence=Math.max(0,...[q.checkIntervalMs,q.pollAfterMs].filter(Number.isFinite));
  if(!(q.sourceCheckedAt>0)||q.sourceCheckedAt>now()||now()-q.sourceCheckedAt>Math.max(60000,cadence*2+5000))return false;
  if((q.stale||q.recovery)&&!(q.staleInfo?.retryAt>now()))return false;
  if(sections.includes('intraday')&&!Array.isArray(q.charts?.intraday))return !!q.slowFields?.intraday?.error;
  if(sections.includes('intraday')&&!q.charts?.intraday?.length&&!q.slowFields?.intraday?.error&&!['unsupported','not-applicable','no-history'].includes(q.slowFields?.intraday?.status))return false;
  if(sections.includes('fundamentals')){
   const f=q.fundamentals;
   if(!f||f.loading||f.status==='loading')return false;
  }
  return true;
 }
 async function collect(query,{signal,deadline,requestId}){
  const soft=new AbortController(),combined=AbortSignal.any([signal,soft.signal]);
  const remaining=Math.max(0,deadline-clock());
  const values={},errors={},pending=new Set();let finished=false,release,unlisten,poll;
  const timeout=setTimeout(()=>soft.abort(contextError('CONTEXT_TIMEOUT',503)),remaining);
  const includes=key=>query.include.includes(key);
  const capture=()=>{const q=engine?.read([query.symbol],{lease:false})?.[0];if(q?.symbol===query.symbol)values.quote=q;};
  const task=(name,fn)=>{
   pending.add(name);
   return Promise.resolve().then(()=>{combined.throwIfAborted();return fn();}).then(value=>{if(!finished)values[name]=value;},error=>{if(!finished)errors[name]={code:error?.code||'SOURCE_UNAVAILABLE',retryAt:Number(error?.retryAt)||null};}).finally(()=>pending.delete(name));
  };
  let wake;
  const aborted=new Promise(resolve=>{wake=resolve;combined.addEventListener('abort',wake,{once:true});if(combined.aborted)wake();});
  try{
   const jobs=[];
   if(includes('samples')){try{values.samples=samples?.snapshot(query.symbol);}catch{errors.samples={code:'SOURCE_UNAVAILABLE'};}}
   if(includes('macro')){try{values.macro=macro?.snapshot();}catch{errors.macro={code:'SOURCE_UNAVAILABLE'};}}
   // Related news is an existing-cache section, like macro context. It must
   // not start a producer that outlives this temporary query or subscribe it.
   if(includes('news')){try{values.news=news?.peek(query.symbol);}catch{errors.news={code:'SOURCE_UNAVAILABLE'};}}
   if(['quote','intraday','fundamentals'].some(includes)){
    if(remaining>0){release=engine.watch([query.symbol]);engine.poke(query.symbol);}capture();
    if(remaining>0)jobs.push(task('quote',()=>new Promise(resolve=>{
     let done=false;
     const finish=()=>{if(done)return;done=true;capture();combined.removeEventListener('abort',finish);resolve(values.quote);};
     const inspect=()=>{capture();if(sourceFinished(values.quote,query.include))finish();};
     combined.addEventListener('abort',finish,{once:true});
     unlisten=engine.subscribe(changed=>{if(changed.includes(query.symbol))inspect();});
     poll=setInterval(inspect,100);inspect();if(combined.aborted)finish();
    })));
   }
   if(includes('daily'))jobs.push(task('daily',()=>history.get(query.symbol,'daily',{count:query.daily_bar_count,signal:combined,deadlineAt:now()+Math.max(1,deadline-clock()),...(remaining<=0?{cacheOnly:true}:{})})));
   await Promise.race([Promise.all(jobs),aborted]);
   signal.throwIfAborted();
   if(values.quote||release)capture();
   if(soft.signal.aborted)for(const name of pending)errors[name]={code:'CONTEXT_TIMEOUT'};
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
  try{return await queue.run(taskSignal=>{started=true;clearTimeout(timer);return collect(normalized,{signal:taskSignal,deadline,requestId});},{signal:combined});}
  catch(error){if(error.code==='CAPACITY_EXCEEDED')throw contextError('CONTEXT_BUSY',503);stats.cancelled++;throw error;}
  finally{clearTimeout(timer);}
 }
 return {query,close(){closed=true;lifetime.abort(contextError('STOPPED',503));queue.close();},reopen(){if(closed){closed=false;lifetime=new AbortController();queue.reopen();}},diagnostics:()=>({...stats,...queue.diagnostics()})};
}
