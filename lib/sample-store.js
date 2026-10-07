import {MAX_WATCHLIST_SYMBOLS,MAX_SAMPLE_SYMBOLS,DEFAULT_SAMPLE_BYTES} from './watchlist-limits.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicWriteFile} from './atomic-file.js';
import {symbolValid} from './symbol-validation.js';
import {sampleTradingDays,sampleTradingDay} from './sample-calendar.js';

const MINUTE=60000,MAX_POINTS=1500;
const filename=(symbol,date)=>Buffer.from(symbol).toString('hex')+'--'+date+'.json';
const sizeOf=point=>Buffer.byteLength(JSON.stringify(point))+1;
const usablePoint=p=>p&&Number.isFinite(p.t)&&p.t>0&&Number.isFinite(p.c)&&p.c>0&&
  Number.isFinite(p.observedAt)&&p.observedAt>0&&Number.isFinite(p.sourceCheckedAt)&&p.sourceCheckedAt>0&&
  typeof p.source==='string'&&p.source.length>0&&p.source.length<=80&&/^(?:[A-Z]{3}|GBp|ZAc)$/.test(p.currency)&&
  typeof p.priceSession==='string'&&p.priceSession.length<=24&&/^\d{4}-\d{2}-\d{2}$/.test(p.tradingDate)&&
  (p.feedDelayMinutes==null||Number.isFinite(p.feedDelayMinutes)&&p.feedDelayMinutes>=0&&p.feedDelayMinutes<=1440);

// Bounded minute buckets, partitioned by security and exchange trading date.
// Persistence and event batching are separate: a disk failure cannot lose a UI delta.
export function createSampleStore({directory='',now=Date.now,maxBytes=DEFAULT_SAMPLE_BYTES,maxSymbols=MAX_SAMPLE_SYMBOLS,writeFile=atomicWriteFile}={}) {
  const states=new Map(),dirty=new Map(),deleted=new Set(),changed=new Map(),capacityErrors=new Map(),daySummaries=new WeakMap();
  let activeSymbols=new Set(),retiredEvicted=0;
  let bytes=0,rejected=0,loadError=null,saveError=null,pendingFlush=null,sequence=0;
  const initial=(symbol,context={})=>({symbol,context,days:new Map(),revision:0,lastPoint:null});
  const contextOf=q=>({instrumentType:typeof q.instrumentType==='string'?q.instrumentType:undefined,exchangeName:typeof q.exchangeName==='string'?q.exchangeName.slice(0,80):undefined});
  function note(state,date,bucket) {
    state.revision=++sequence;
    const file=filename(state.symbol,date);dirty.set(file,{state,date,revision:state.revision});deleted.delete(file);
    if(!changed.has(state.symbol))changed.set(state.symbol,new Set());
    if(bucket!=null)changed.get(state.symbol).add(date+':'+bucket);
  }
  function touch(symbol){const state=states.get(symbol);sequence++;if(state)state.revision=sequence;if(!changed.has(symbol))changed.set(symbol,new Set());}
  function capacity(symbol){rejected++;if(!capacityErrors.has(symbol)){capacityErrors.set(symbol,'采样存储达到上限，等待旧交易日记录清理');touch(symbol);}while(capacityErrors.size>maxSymbols)capacityErrors.delete(capacityErrors.keys().next().value);return false;}
  function retain(symbols){activeSymbols=new Set(symbols.filter(symbolValid).slice(0,MAX_WATCHLIST_SYMBOLS));}
  function reclaimRetired(symbol,growth,needsSlot){
    if(!activeSymbols.has(symbol)||bytes+growth<=maxBytes&&(!needsSlot||states.size<maxSymbols))return;
    const retired=[...states.values()].filter(state=>!activeSymbols.has(state.symbol)).sort((a,b)=>(a.lastPoint?.observedAt||0)-(b.lastPoint?.observedAt||0));
    while(retired.length&&(bytes+growth>maxBytes||needsSlot&&states.size>=maxSymbols)){
      const state=retired.shift();
      for(const [date,day] of state.days){bytes-=daySummaries.get(day).bytes;const file=filename(state.symbol,date);dirty.delete(file);deleted.add(file);}
      states.delete(state.symbol);retiredEvicted++;
      capacityErrors.set(state.symbol,'已移出自选的采样因存储达到上限而提前清理');touch(state.symbol);
      while(capacityErrors.size>maxSymbols)capacityErrors.delete(capacityErrors.keys().next().value);
    }
  }
  function accept(q) {
    const clock=now(),delay=q?.feedDelayMinutes??0,checked=q?.sourceCheckedAt??q?.fetchedAt;
    if(!q||!symbolValid(q.symbol)||q.symbol!==q.symbol.toUpperCase()||q.error||q.pending||q.stale||q.staleInfo||q.recovery||q.calendarCoverage?.known===false||
      !Number.isFinite(q.price)||q.price<=0||!Number.isFinite(q.quoteAt)||q.quoteAt<=0||q.quoteAt>clock+5000||
      !Number.isFinite(delay)||delay<0||delay>1440||clock-q.quoteAt>Math.max(120000,delay*MINUTE+MINUTE)||
      !Number.isFinite(checked)||checked>clock+5000||clock-checked>Math.max(120000,Math.min(3600000,Number(q.checkIntervalMs||q.pollAfterMs)||0)+5000))return false;
    let state=states.get(q.symbol);
    const last=state?.lastPoint;
    if(last&&(q.quoteAt/1000<last.t||q.quoteAt/1000===last.t&&q.price===last.c&&q.src===last.source&&q.currency===last.currency&&(q.priceSession||'UNKNOWN')===last.priceSession))return false;
    const context=contextOf(q),window=sampleTradingDays(q.symbol,clock,context),date=sampleTradingDay(q.symbol,q.quoteAt,context);
    if(!window.supported||!window.tradingDays.includes(date))return false;
    const point={t:q.quoteAt/1000,c:q.price,v:null,_sample:true,observedAt:clock,sourceCheckedAt:checked,source:q.src,currency:q.currency,
      tradingDate:date,priceSession:q.priceSession||'UNKNOWN',feedDelayMinutes:q.feedDelayMinutes??null};
    if(!usablePoint(point))return false;
    const newState=!state;
    if(!state)state=initial(q.symbol,context);
    const bucket=Math.floor(q.quoteAt/MINUTE),day=state.days.get(date),old=day?.get(bucket);
    const latest=state.lastPoint;
    if(latest&&point.t<latest.t||old&&(point.t<old.t||point.t===old.t&&point.c===old.c&&point.source===old.source&&point.currency===old.currency&&point.priceSession===old.priceSession))return false;
    if(!old&&day?.size>=MAX_POINTS)return capacity(q.symbol);
    const pointGrowth=sizeOf(point)-(old?sizeOf(old):0),growth=pointGrowth+(day?0:1024);
    reclaimRetired(q.symbol,growth,newState);
    if(newState&&states.size>=maxSymbols||bytes+growth>maxBytes)return capacity(q.symbol);
    const points=day||new Map(),summary=daySummaries.get(points)||{bytes:1024,firstObservedAt:null,lastPoint:null};
    capacityErrors.delete(q.symbol);state.context=context;state.lastPoint=Object.freeze(point);points.set(bucket,state.lastPoint);
    summary.bytes+=pointGrowth;summary.lastPoint=state.lastPoint;
    // Normally the earliest observation is in an immutable older bucket. A
    // restored/corrected minimum can move forward; only that mutation needs a
    // bounded day scan. Clock reversals may introduce a new minimum immediately.
    if(points.size===1||summary.firstObservedAt==null||point.observedAt<summary.firstObservedAt)summary.firstObservedAt=point.observedAt;
    else if(old&&old.observedAt===summary.firstObservedAt&&point.observedAt>old.observedAt){
      summary.firstObservedAt=null;
      for(const p of points.values())if(summary.firstObservedAt==null||p.observedAt<summary.firstObservedAt)summary.firstObservedAt=p.observedAt;
    }
    daySummaries.set(points,summary);state.days.set(date,points);states.set(q.symbol,state);bytes+=growth;note(state,date,bucket);
    return true;
  }
  function prune() {
    for(const [symbol,state] of states) {
      const window=sampleTradingDays(symbol,now(),state.context);if(!window.supported)continue;
      for(const [date,day] of state.days)if(!window.tradingDays.includes(date)){
        bytes-=daySummaries.get(day).bytes;state.days.delete(date);state.revision=++sequence;
        const file=filename(symbol,date);dirty.delete(file);deleted.add(file);if(!changed.has(symbol))changed.set(symbol,new Set());
      }
      // Empty entries can be read without retaining an unbounded symbol registry.
      if(!state.days.size)states.delete(symbol);
    }
  }
  function describe(symbol) {
    const clock=now(),state=states.get(symbol),window=sampleTradingDays(symbol,clock,state?.context);
    let coveredDays=0,firstObservedAt=null,lastPoint=null;
    for(const date of window.tradingDays){
      const day=state?.days.get(date);if(!day?.size)continue;
      const summary=daySummaries.get(day);coveredDays++;
      if(firstObservedAt==null||summary.firstObservedAt<firstObservedAt)firstObservedAt=summary.firstObservedAt;
      if(!lastPoint||summary.lastPoint.t>lastPoint.t)lastPoint=summary.lastPoint;
    }
    return {state,metadata:{schemaVersion:1,symbol,...window,intervalMs:MINUTE,revision:state?.revision||sequence,serverNow:clock,
      coveredDays,firstObservedAt,lastQuoteAt:lastPoint?.t*1000||null,lastObservedAt:lastPoint?.observedAt||null,
      persistenceError:saveError||loadError,capacityError:capacityErrors.get(symbol)||null,retentionDays:3}};
  }
  function snapshot(symbol) {
    const {state,metadata}=describe(symbol);
    // Restore sorts minute Maps once; admission only appends or replaces the
    // latest bucket. Trading dates are ascending, so no read-time sort is needed.
    return {...metadata,points:metadata.tradingDays.flatMap(date=>[...(state?.days.get(date)?.values()||[])])};
  }
  function takeUpdates() {
    const out=[];
    for(const [symbol,keys] of changed){
      const {state,metadata}=describe(symbol),points=[];let ordered=true;
      // Changed keys inherit the same monotonic insertion order as the minute
      // Maps. Resolve only those keys, excluding dates that expired meanwhile.
      for(const key of keys){
        const date=key.slice(0,10);if(!metadata.tradingDays.includes(date))continue;
        const point=state?.days.get(date)?.get(Number(key.slice(11)));
        if(point){if(points.length&&point.t<points.at(-1).t)ordered=false;points.push(point);}
      }
      // Eviction/recreation plus a clock reversal can leave older changed keys
      // in a different order. Sort only that delta, never unchanged history.
      if(!ordered)points.sort((a,b)=>a.t-b.t);
      out.push({...metadata,points});
    }
    changed.clear();return out;
  }
  async function restore() {
    if(!directory)return;
    let names;try{names=await fs.readdir(directory);}catch(e){if(e.code!=='ENOENT')loadError=e.code||'READ_FAILED';return;}
    const files=names.filter(name=>/^[a-f0-9]{2,128}--\d{4}-\d{2}-\d{2}\.json$/.test(name));
    if(files.length>maxSymbols*3)loadError='SAMPLE_FILE_LIMIT';
    for(const file of files.sort((a,b)=>Number(activeSymbols.has(Buffer.from(b.split('--')[0],'hex').toString()))-Number(activeSymbols.has(Buffer.from(a.split('--')[0],'hex').toString()))||b.localeCompare(a)).slice(0,maxSymbols*3))try{
      const target=path.join(directory,file),stat=await fs.lstat(target);
      if(!stat.isFile()||stat.size>1024*1024)throw Object.assign(Error('invalid sample file'),{code:'SAMPLE_FILE_INVALID'});
      const data=JSON.parse(await fs.readFile(target,'utf8'));
      if(data.schemaVersion!==1||!symbolValid(data.symbol)||file!==filename(data.symbol,data.tradingDate)||!Array.isArray(data.points)||data.points.length>MAX_POINTS)throw Error('invalid sample schema');
      const context=contextOf(data.context||{}),window=sampleTradingDays(data.symbol,now(),context);
      if(window.supported&&!window.tradingDays.includes(data.tradingDate)){deleted.add(file);continue;}
      if(!states.has(data.symbol)&&states.size>=maxSymbols)throw Error('sample symbol limit');
      const points=new Map();let total=1024,firstObservedAt=null,lastPoint=null;
      for(const p of data.points){
        if(!usablePoint(p)||p.t*1000>now()+5000||p.observedAt>now()+5000||p.sourceCheckedAt>p.observedAt+5000||p.tradingDate!==data.tradingDate||sampleTradingDay(data.symbol,p.t*1000,context)!==p.tradingDate)throw Error('invalid sample point');
        const clean=Object.freeze({t:p.t,c:p.c,v:null,_sample:true,observedAt:p.observedAt,sourceCheckedAt:p.sourceCheckedAt,source:p.source,currency:p.currency,tradingDate:p.tradingDate,priceSession:p.priceSession,feedDelayMinutes:p.feedDelayMinutes??null});
        const key=Math.floor(p.t/60);if(points.has(key))throw Error('duplicate sample minute');points.set(key,clean);total+=sizeOf(clean);
        if(firstObservedAt==null||clean.observedAt<firstObservedAt)firstObservedAt=clean.observedAt;
        if(!lastPoint||clean.t>lastPoint.t)lastPoint=clean;
      }
      if(bytes+total>maxBytes)throw Object.assign(Error('sample byte limit'),{code:'SAMPLE_BYTE_LIMIT'});
      const state=states.get(data.symbol)||initial(data.symbol,context),ordered=new Map([...points].sort(([a],[b])=>a-b));
      state.days.set(data.tradingDate,ordered);daySummaries.set(ordered,{bytes:total,firstObservedAt,lastPoint});state.revision=++sequence;
      if(lastPoint&&(!state.lastPoint||lastPoint.t>state.lastPoint.t))state.lastPoint=lastPoint;
      states.set(data.symbol,state);bytes+=total;
    }catch(e){loadError=e.code||'SAMPLE_FILE_INVALID';}
  }
  async function writePending() {
    if(!directory){dirty.clear();deleted.clear();return;}
    let failure=null;
    for(const file of [...deleted])try{await fs.unlink(path.join(directory,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});deleted.delete(file);}catch(e){failure=e.code||'WRITE_FAILED';}
    for(const [file,job] of [...dirty])try{
      const day=job.state.days.get(job.date);if(!day){dirty.delete(file);continue;}
      const body=JSON.stringify({schemaVersion:1,symbol:job.state.symbol,tradingDate:job.date,context:job.state.context,points:[...day.values()]});
      await writeFile(path.join(directory,file),body);
      if(dirty.get(file)===job)dirty.delete(file);
    }catch(e){failure=e.code||'WRITE_FAILED';}
    saveError=failure;
  }
  function flush(){if(!pendingFlush)pendingFlush=writePending().finally(()=>{pendingFlush=null;});return pendingFlush;}
  return {accept,retain,prune,touch,snapshot,takeUpdates,restore,flush,
    diagnostics:()=>({bytes,maxBytes,maxSymbols,retiredEvicted,symbols:states.size,files:[...states.values()].reduce((n,s)=>n+s.days.size,0),dirtyFiles:dirty.size,rejected,loadError,saveError})};
}
