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
export function createSampleStore({directory='',now=Date.now,maxBytes=16*1024*1024,maxSymbols=50,writeFile=atomicWriteFile}={}) {
  const states=new Map(),dirty=new Map(),deleted=new Set(),changed=new Map(),capacityErrors=new Map();
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
  function capacity(symbol){rejected++;if(!capacityErrors.has(symbol)){capacityErrors.set(symbol,'采样存储达到上限，等待旧交易日记录清理');touch(symbol);}while(capacityErrors.size>50)capacityErrors.delete(capacityErrors.keys().next().value);return false;}
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
    if(!state&&states.size>=maxSymbols)return capacity(q.symbol);
    if(!state)state=initial(q.symbol,context);
    const bucket=Math.floor(q.quoteAt/MINUTE),day=state.days.get(date),old=day?.get(bucket);
    const latest=state.lastPoint;
    if(latest&&point.t<latest.t||old&&(point.t<old.t||point.t===old.t&&point.c===old.c&&point.source===old.source&&point.currency===old.currency&&point.priceSession===old.priceSession))return false;
    if(!old&&day?.size>=MAX_POINTS)return capacity(q.symbol);
    const growth=sizeOf(point)-(old?sizeOf(old):0)+(day?0:1024);
    if(bytes+growth>maxBytes)return capacity(q.symbol);
    if(!day)state.days.set(date,new Map());
    capacityErrors.delete(q.symbol);state.context=context;state.lastPoint=Object.freeze(point);state.days.get(date).set(bucket,state.lastPoint);states.set(q.symbol,state);bytes+=growth;note(state,date,bucket);
    return true;
  }
  function prune() {
    for(const [symbol,state] of states) {
      const window=sampleTradingDays(symbol,now(),state.context);if(!window.supported)continue;
      for(const [date,day] of state.days)if(!window.tradingDays.includes(date)){
        bytes-=1024+[...day.values()].reduce((n,p)=>n+sizeOf(p),0);state.days.delete(date);state.revision=++sequence;
        const file=filename(symbol,date);dirty.delete(file);deleted.add(file);if(!changed.has(symbol))changed.set(symbol,new Set());
      }
      // Empty entries can be read without retaining an unbounded symbol registry.
      if(!state.days.size)states.delete(symbol);
    }
  }
  function snapshot(symbol) {
    const state=states.get(symbol),window=sampleTradingDays(symbol,now(),state?.context);
    const points=window.tradingDays.flatMap(date=>[...(state?.days.get(date)?.values()||[])]).sort((a,b)=>a.t-b.t);
    return {schemaVersion:1,symbol,...window,intervalMs:MINUTE,revision:state?.revision||sequence,serverNow:now(),points,
      coveredDays:new Set(points.map(p=>p.tradingDate)).size,firstObservedAt:points.length?Math.min(...points.map(p=>p.observedAt)):null,
      lastQuoteAt:points.at(-1)?.t*1000||null,lastObservedAt:points.at(-1)?.observedAt||null,
      persistenceError:saveError||loadError,capacityError:capacityErrors.get(symbol)||null,retentionDays:3};
  }
  function takeUpdates() {
    const out=[];
    for(const [symbol,keys] of changed){const value=snapshot(symbol);out.push({...value,points:value.points.filter(p=>keys.has(p.tradingDate+':'+Math.floor(p.t/60)))});}
    changed.clear();return out;
  }
  async function restore() {
    if(!directory)return;
    let names;try{names=await fs.readdir(directory);}catch(e){if(e.code!=='ENOENT')loadError=e.code||'READ_FAILED';return;}
    const files=names.filter(name=>/^[a-f0-9]{2,128}--\d{4}-\d{2}-\d{2}\.json$/.test(name));
    if(files.length>maxSymbols*3)loadError='SAMPLE_FILE_LIMIT';
    for(const file of files.sort().slice(0,maxSymbols*3))try{
      const target=path.join(directory,file),stat=await fs.lstat(target);
      if(!stat.isFile()||stat.size>1024*1024)throw Object.assign(Error('invalid sample file'),{code:'SAMPLE_FILE_INVALID'});
      const data=JSON.parse(await fs.readFile(target,'utf8'));
      if(data.schemaVersion!==1||!symbolValid(data.symbol)||file!==filename(data.symbol,data.tradingDate)||!Array.isArray(data.points)||data.points.length>MAX_POINTS)throw Error('invalid sample schema');
      const context=contextOf(data.context||{}),window=sampleTradingDays(data.symbol,now(),context);
      if(window.supported&&!window.tradingDays.includes(data.tradingDate)){deleted.add(file);continue;}
      if(!states.has(data.symbol)&&states.size>=maxSymbols)throw Error('sample symbol limit');
      const points=new Map();let total=1024;
      for(const p of data.points){
        if(!usablePoint(p)||p.t*1000>now()+5000||p.observedAt>now()+5000||p.sourceCheckedAt>p.observedAt+5000||p.tradingDate!==data.tradingDate||sampleTradingDay(data.symbol,p.t*1000,context)!==p.tradingDate)throw Error('invalid sample point');
        const clean=Object.freeze({t:p.t,c:p.c,v:null,_sample:true,observedAt:p.observedAt,sourceCheckedAt:p.sourceCheckedAt,source:p.source,currency:p.currency,tradingDate:p.tradingDate,priceSession:p.priceSession,feedDelayMinutes:p.feedDelayMinutes??null});
        const key=Math.floor(p.t/60);if(points.has(key))throw Error('duplicate sample minute');points.set(key,clean);total+=sizeOf(clean);
      }
      if(bytes+total>maxBytes)throw Object.assign(Error('sample byte limit'),{code:'SAMPLE_BYTE_LIMIT'});
      const state=states.get(data.symbol)||initial(data.symbol,context);state.days.set(data.tradingDate,new Map([...points].sort(([a],[b])=>a-b)));state.revision=++sequence;
      for(const p of points.values())if(!state.lastPoint||p.t>state.lastPoint.t)state.lastPoint=p;
      states.set(data.symbol,state);bytes+=total;
    }catch(e){loadError=e.code||'SAMPLE_FILE_INVALID';}
  }
  async function writePending() {
    if(!directory){dirty.clear();deleted.clear();return;}
    let failure=null;
    for(const file of [...deleted])try{await fs.unlink(path.join(directory,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});deleted.delete(file);}catch(e){failure=e.code||'WRITE_FAILED';}
    for(const [file,job] of [...dirty])try{
      const day=job.state.days.get(job.date);if(!day){dirty.delete(file);continue;}
      const body=JSON.stringify({schemaVersion:1,symbol:job.state.symbol,tradingDate:job.date,context:job.state.context,points:[...day.values()].sort((a,b)=>a.t-b.t)});
      await writeFile(path.join(directory,file),body);
      if(dirty.get(file)===job)dirty.delete(file);
    }catch(e){failure=e.code||'WRITE_FAILED';}
    saveError=failure;
  }
  function flush(){if(!pendingFlush)pendingFlush=writePending().finally(()=>{pendingFlush=null;});return pendingFlush;}
  return {accept,prune,touch,snapshot,takeUpdates,restore,flush,
    diagnostics:()=>({bytes,maxBytes,symbols:states.size,files:[...states.values()].reduce((n,s)=>n+s.days.size,0),dirtyFiles:dirty.size,rejected,loadError,saveError})};
}
