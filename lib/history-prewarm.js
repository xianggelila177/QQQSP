import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import fs from 'node:fs/promises';
import {atomicWriteFile} from './atomic-file.js';
import {contentHash,validSymbol} from './history-contract.js';
import {createLatestCheckpoint} from './latest-checkpoint.js';
// Bounded workers for durable membership plus live connection leases. No per-period upstream jobs,
// no database, no work on the quote clock. HTTP/SSE read already prepared bundles.
export function createHistoryPrewarm({history,now=Date.now,enabled=true,statePath='',refreshMs=60000,tickMs=1000,maxSymbols=MAX_WATCHLIST_SYMBOLS,maxConcurrent=2,log={warn(){}},writeFile=atomicWriteFile}={}){
 const entries=new Map(),listeners=new Set(),owners=new Map();
 const tasks=new Map(),capacity=Math.max(1,Math.min(4,Math.floor(maxConcurrent)||1));
 let running=false,timer=null,init=null,drainTimer=null,saveTimer=null,restored=false,initialized=false,loadError=null,saveError=null;
 let watchlist=[],persistentWatchlist=[],overflow=[],membershipVersion=0;
 const initial=symbol=>({symbol,status:'queued',tier:'near',expandAt:null,periods:null,revision:'0',nextAt:now(),checkedAt:null,retryAt:null,error:null,refreshFailed:false});
 function snapshot(symbols=watchlist){return {schemaVersion:1,enabled,running,refreshMs,serverNow:now(),entries:symbols.map(s=>entries.get(s)||initial(s))};}
 function emit(symbol){for(const fn of listeners)fn([symbol]);}
 function checkpoint(){return {schemaVersion:1,savedAt:now(),watchlist:persistentWatchlist,history:history.exportState(watchlist)};}
 const saver=createLatestCheckpoint({write:body=>writeFile(statePath,body),capture:checkpoint,
  onSuccess(){saveError=null;},onError(e){saveError=e.code||e.message;log.warn('[history checkpoint]',{code:saveError});}});
 function persist(saved){
  clearTimeout(saveTimer);saveTimer=null;if(!statePath)return Promise.resolve();
  return saver.persist(saved);
 }
 function saveSoon(){if(!running||!statePath||saveTimer)return;saveTimer=setTimeout(()=>{void persist().catch(()=>{});},5000);saveTimer.unref?.();}
 function scheduleDrain(){if(running&&!drainTimer)drainTimer=setImmediate(()=>{drainTimer=null;runDue();});}
 const clean=symbols=>[...new Set(symbols.filter(validSymbol))].slice(0,MAX_WATCHLIST_SYMBOLS);
 function reconcile(){
  const requested=[...new Set([...persistentWatchlist,...[...owners.values()].flat()])];
  overflow=requested.slice(maxSymbols);const list=requested.slice(0,maxSymbols);
  if(list.join(',')===watchlist.join(','))return;
  watchlist=list;
  for(const symbol of entries.keys())if(!list.includes(symbol))entries.delete(symbol);
  for(const symbol of list)if(!entries.has(symbol))entries.set(symbol,initial(symbol));
  saveSoon();scheduleDrain();
 }
 // Only an explicit save replaces durable membership. Readers never call retain.
 function retain(symbols){if(!enabled)return;persistentWatchlist=clean(symbols);membershipVersion++;reconcile();saveSoon();}
 function lease(owner,symbols){if(!enabled)return()=>{};owners.set(owner,clean(symbols));reconcile();return()=>{owners.delete(owner);reconcile();};}
 async function cachedPeriods(symbol){return Object.fromEntries(await Promise.all(['daily','weekly','monthly','yearly'].map(async p=>[p,await history.get(symbol,p,{count:p==='yearly'?39:79,cacheOnly:true})])));}
 function commit(symbol,periods,tier){
  const old=entries.get(symbol);if(!old)return;
  const values=Object.values(periods),stale=values.some(v=>v.stale),error=values.find(v=>v.errorCode);
  const changed=contentHash(values.map(v=>[v.period,v.revision]));
  // Preserve arrays if the candles did not change; timestamps are metadata, not repaint triggers.
  periods=Object.fromEntries(Object.entries(periods).map(([p,value])=>[p,{...value,prewarmScope:'near',
   bars:old.periods?.[p]?.revision===value.revision?old.periods[p].bars:value.bars,
   barsRevision:contentHash([value.seriesId,value.bars])}]));
  entries.set(symbol,{...old,symbol,periods,tier:'near',expandAt:null,revision:changed,status:stale?'stale':'ready',checkedAt:now(),
   nextAt:Math.max(now()+refreshMs,Number(periods.daily?.retryAt)||0),retryAt:error?.retryAt||null,error:error?.errorCode||null,refreshFailed:false});
  emit(symbol);saveSoon();
 }
 function runDue(){
  if(!enabled||!running)return;
  while(tasks.size<capacity){
  let entry;
  for(const value of entries.values())if(!tasks.has(value.symbol)&&value.nextAt<=now()&&
   (!entry||Number(!!value.periods)<Number(!!entry.periods)||!!value.periods===!!entry.periods&&value.nextAt<entry.nextAt))entry=value;
  if(!entry)break;
  const tier='near';
  // Wide weekly/monthly/yearly ranges are fetched by explicit history readers.
  // Expanding every background member to 39 years evicts the active cache.
  const symbol=entry.symbol;entry.status=entry.periods?'refreshing':'warming';entry.nextAt=now()+refreshMs;emit(symbol);
  const controller=new AbortController(),job={controller,promise:null};tasks.set(symbol,job);
  job.promise=(async()=>{
   try{const periods=await history.prepare(symbol,{tier,signal:controller.signal,priority:'background'});if(running&&entries.get(symbol)===entry)commit(symbol,periods,tier);}
   catch(e){if(running&&entries.get(symbol)===entry){
    const current=entries.get(symbol);entries.set(symbol,{...current,status:current.periods?'stale':'error',error:e.code||'HISTORY_SOURCE_UNAVAILABLE',retryAt:Math.max(now()+60000,Number(e.retryAt)||0),nextAt:Math.max(now()+60000,Number(e.retryAt)||0),refreshFailed:true});emit(symbol);
   }}finally{tasks.delete(symbol);saveSoon();scheduleDrain();}
  })();
  }
  return Promise.all([...tasks.values()].map(job=>job.promise));
 }
 async function restore(){
  if(!statePath)return;const version=membershipVersion;
  try{
   const stat=await fs.stat(statePath);if(stat.size>32*1024*1024)throw Error('历史缓存文件超过32MiB');
   const value=JSON.parse(await fs.readFile(statePath,'utf8'));if(value.schemaVersion!==1||!Number.isFinite(value.savedAt)||value.savedAt<=0||value.savedAt>now()+60000)throw Error('历史缓存版本或时间无效');
   if(!running)return;
   history.restore(value.history);
   if(version===membershipVersion&&Array.isArray(value.watchlist))retain(value.watchlist);
   for(const s of watchlist)if(history.cache.has(s)){commit(s,await cachedPeriods(s));entries.get(s).nextAt=now();}
   restored=true;
  }catch(e){if(e.code!=='ENOENT'){loadError=e.code||e.message;log.warn('[history restore]',{error:loadError});}}
 }
 function start(){if(running||!enabled)return init||Promise.resolve();running=true;
  init=restore().then(()=>{initialized=true;if(!running)return;runDue();timer=setInterval(runDue,tickMs);timer.unref?.();});return init;
 }
 async function stop(){const saved=running&&initialized?checkpoint():null;running=false;clearInterval(timer);timer=null;clearImmediate(drainTimer);drainTimer=null;clearTimeout(saveTimer);saveTimer=null;
  for(const job of tasks.values())job.controller.abort(Object.assign(Error('History prewarm stopped'),{code:'STOPPED'}));
  await init;await Promise.all([...tasks.values()].map(job=>job.promise));if(saved)await persist(saved);await saver.settled();}
 return {start,stop,retain,lease,runDue,snapshot,persist,
  async settled(){await init;await Promise.all([...tasks.values()].map(job=>job.promise));},
  read(symbol,period,options={}){
   const entry=entries.get(symbol),value=entry?.periods?.[period];
   if(!value||options.before||options.count!=null&&Number(options.count)!==value.requestedCount)return null;
   if(value.prewarmScope==='near'&&period!=='daily')return null;
   if(options.seriesId&&options.seriesId!==value.seriesId)return null;
   // Near daily and previously loaded long periods have independent clocks.
   // A stale sibling cannot downgrade this period; an entire failed refresh can.
   const stale=value.stale||value.status==='stale'||entry.refreshFailed||
     !Number.isFinite(value.sourceCheckedAt)||now()>Math.max(value.sourceCheckedAt+refreshMs*2,Number(value.sourceFreshUntil)||0);
   return {...value,prewarmed:true,refreshing:entry.status==='refreshing',...(stale?{stale:true,status:'stale'}:{}),
     ...(entry.refreshFailed?{retryAt:entry.retryAt,errorCode:entry.error||null}:{})};
  },
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  status:()=>({enabled,running,watchlist:[...watchlist],persistentWatchlist:[...persistentWatchlist],owners:owners.size,overflow,maxSymbols,active:tasks.size>0,activeCount:tasks.size,maxConcurrent:capacity,
   due:[...entries.values()].filter(e=>!tasks.has(e.symbol)&&e.nextAt<=now()).length,
   oldestDueMs:Math.max(0,...[...entries.values()].filter(e=>!tasks.has(e.symbol)).map(e=>now()-e.nextAt)),
   ready:[...entries.values()].filter(e=>e.periods).length,refreshMs,restored,loadError,saveError,checkpoint:saver.diagnostics(),entries:[...entries.values()].map(({periods,...rest})=>rest)})};
}
