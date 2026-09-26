import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import fs from 'node:fs/promises';
import {atomicWriteFile} from './atomic-file.js';
import {contentHash,validSymbol} from './history-contract.js';
// One low-frequency worker for durable membership plus live connection leases. No per-period upstream jobs,
// no database, no work on the quote clock. HTTP/SSE read already prepared bundles.
export function createHistoryPrewarm({history,now=Date.now,enabled=true,statePath='',refreshMs=60000,tickMs=1000,maxSymbols=MAX_WATCHLIST_SYMBOLS,expandAfterMs=5000,canExpand=()=>true,log={warn(){}}}={}){
 const entries=new Map(),listeners=new Set(),owners=new Map();
 let running=false,timer=null,init=null,task=null,saveTimer=null,saveChain=Promise.resolve(),restored=false,initialized=false,loadError=null,saveError=null;
 let watchlist=[],persistentWatchlist=[],overflow=[],membershipVersion=0;
 const initial=symbol=>({symbol,status:'queued',tier:'near',expandAt:null,periods:null,revision:'0',nextAt:0,checkedAt:null,retryAt:null,error:null});
 function snapshot(symbols=watchlist){return {schemaVersion:1,enabled,running,refreshMs,serverNow:now(),entries:symbols.map(s=>entries.get(s)||initial(s))};}
 function emit(symbol){for(const fn of listeners)fn([symbol]);}
 function checkpoint(){return {schemaVersion:1,savedAt:now(),watchlist:persistentWatchlist,history:history.exportState(watchlist)};}
 function persist(saved=checkpoint()){
  clearTimeout(saveTimer);saveTimer=null;if(!statePath)return Promise.resolve();
  const body=JSON.stringify(saved);saveChain=saveChain.then(async()=>{
   try{await atomicWriteFile(statePath,body);saveError=null;}
   catch(e){saveError=e.code||e.message;log.warn('[history checkpoint]',{code:saveError});}
  });return saveChain;
 }
 function saveSoon(){if(!running||!statePath||saveTimer)return;saveTimer=setTimeout(()=>{void persist();},5000);saveTimer.unref?.();}
 const clean=symbols=>[...new Set(symbols.filter(validSymbol))].slice(0,MAX_WATCHLIST_SYMBOLS);
 function reconcile(){
  const requested=[...new Set([...persistentWatchlist,...[...owners.values()].flat()])];
  overflow=requested.slice(maxSymbols);const list=requested.slice(0,maxSymbols);
  if(list.join(',')===watchlist.join(','))return;
  watchlist=list;
  for(const symbol of entries.keys())if(!list.includes(symbol))entries.delete(symbol);
  for(const symbol of list)if(!entries.has(symbol))entries.set(symbol,initial(symbol));
  saveSoon();if(running)queueMicrotask(runDue);
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
  entries.set(symbol,{...old,symbol,periods,tier:'near',expandAt:null,revision:changed,status:stale?'stale':'ready',checkedAt:now(),nextAt:Math.max(now()+refreshMs,Number(error?.retryAt)||0),retryAt:error?.retryAt||null,error:error?.errorCode||null});
  emit(symbol);saveSoon();
 }
 function runDue(){
  if(!enabled||!running||task)return task;
  const values=[...entries.values()];
  const entry=values.filter(e=>e.nextAt<=now()).sort((a,b)=>Number(!!a.periods)-Number(!!b.periods)||a.nextAt-b.nextAt)[0],tier='near';
  if(!entry)return;
  // Wide weekly/monthly/yearly ranges are fetched by explicit history readers.
  // Expanding every background member to 39 years evicts the active cache.
  const symbol=entry.symbol;entry.status=entry.periods?'refreshing':'warming';entry.nextAt=now()+refreshMs;emit(symbol);
  task=(async()=>{
   try{const periods=await history.prepare(symbol,{tier});if(running&&entries.has(symbol))commit(symbol,periods,tier);}
   catch(e){if(running&&entries.has(symbol)){
    const current=entries.get(symbol);entries.set(symbol,{...current,status:current.periods?'stale':'error',error:e.code||'HISTORY_SOURCE_UNAVAILABLE',retryAt:Math.max(now()+60000,Number(e.retryAt)||0),nextAt:Math.max(now()+60000,Number(e.retryAt)||0)});emit(symbol);
   }}finally{task=null;saveSoon();}
  })();return task;
 }
 async function restore(){
  if(!statePath)return;const version=membershipVersion;
  try{
   const stat=await fs.stat(statePath);if(stat.size>32*1024*1024)throw Error('历史缓存文件超过32MiB');
   const value=JSON.parse(await fs.readFile(statePath,'utf8'));if(value.schemaVersion!==1||!Number.isFinite(value.savedAt)||value.savedAt<=0||value.savedAt>now()+60000)throw Error('历史缓存版本或时间无效');
   history.restore(value.history);
   if(version===membershipVersion&&Array.isArray(value.watchlist))retain(value.watchlist);
   for(const s of watchlist)if(history.cache.has(s)){commit(s,await cachedPeriods(s));entries.get(s).nextAt=0;}
   restored=true;
  }catch(e){if(e.code!=='ENOENT'){loadError=e.code||e.message;log.warn('[history restore]',{error:loadError});}}
 }
 function start(){if(running||!enabled)return init||Promise.resolve();running=true;
  init=restore().then(()=>{initialized=true;if(!running)return;runDue();timer=setInterval(runDue,tickMs);timer.unref?.();});return init;
 }
 async function stop(){if(!running&&!init)return;const saved=initialized?checkpoint():null;running=false;clearInterval(timer);timer=null;clearTimeout(saveTimer);saveTimer=null;await init;await task;if(saved)await persist(saved);await saveChain;}
 return {start,stop,retain,lease,runDue,snapshot,persist,
  async settled(){await init;await task;},
  read(symbol,period,options={}){
   const entry=entries.get(symbol),value=entry?.periods?.[period];
   if(!value||options.before||options.count!=null&&Number(options.count)!==value.requestedCount)return null;
   if(value.prewarmScope==='near'&&period!=='daily')return null;
   if(options.seriesId&&options.seriesId!==value.seriesId)return null;
   const stale=entry.status==='stale'||now()-entry.checkedAt>refreshMs*2;
   return {...value,prewarmed:true,refreshing:entry.status==='refreshing',...(stale?{stale:true,status:'stale',retryAt:entry.retryAt,errorCode:entry.error||null}:{} )};
  },
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  status:()=>({enabled,running,watchlist:[...watchlist],persistentWatchlist:[...persistentWatchlist],owners:owners.size,overflow,maxSymbols,active:!!task,ready:[...entries.values()].filter(e=>e.periods).length,refreshMs,restored,loadError,saveError,entries:[...entries.values()].map(({periods,...rest})=>rest)})};
}
