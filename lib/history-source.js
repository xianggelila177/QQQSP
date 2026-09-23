import {instrumentTypeFor} from './instruments.js';
import {historyError} from './history-contract.js';
import {createSourcePolling} from './source-polling.js';
import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {createSourceProbes,broaderHistory} from './source-probes.js';
import {volumeCapability} from './volume-normalizer.js';
import {marketKeyFor} from './instruments.js';

// HTTP 200 is not a successful history response if every bar is unusable.
export function usableHistory(data,symbol,query){
 if(!data||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])return false;
 if(data.meta?.symbol&&String(data.meta.symbol).toUpperCase()!==symbol)return false;
 const daily=new URLSearchParams(query).get('interval')==='1d',q=data.indicators.quote[0];
 if(daily&&data.meta?.dataGranularity!=='1d')return false;
 return data.timestamp.some((t,i)=>Number.isFinite(t)&&Number.isFinite(q.close?.[i])&&q.close[i]>0&&(!daily||[q.open?.[i],q.high?.[i],q.low?.[i]].every(n=>Number.isFinite(n)&&n>0)&&q.high[i]>=Math.max(q.open[i],q.close[i])&&q.low[i]<=Math.min(q.open[i],q.close[i])));
}
export function createHistorySource({primary,sina,naver,index,alternative,finnhub,world,now=Date.now,probeTimeoutMs=3500}={}) {
 const preferred=new Map(),failures=new Map();
 const rotation=createSourcePolling({now,intervalMs:300000,maxEntries:MAX_WATCHLIST_SYMBOLS*2});
 const probes=createSourceProbes({now,timeoutMs:probeTimeoutMs,maxEntries:MAX_WATCHLIST_SYMBOLS*2});let closed=false;
 const fetchHistory=async function(symbol,query,options={}) {
  if(closed)throw historyError('STOPPED','History sources stopped',503);
  const daily=new URLSearchParams(query).get('interval')==='1d',key=symbol+':'+daily;
  const backup=alternative&&(!alternative.supports||alternative.supports(symbol))?alternative:null;
  const functions=[];
  const preferredUs=!!(finnhub?.supports?.(symbol)||world?.supports?.(symbol));
  if(finnhub?.supports?.(symbol))functions.push(finnhub);
  if(index?.supports?.(symbol))functions.push(index);
  if(naver&&/^\d{6}\.(KS|KQ)$/.test(symbol))functions.push(naver);
  // Sticky success for five minutes: a good fallback is not preceded by another
  // failed Yahoo probe on every tab. Never rotate IPs to evade rate limiting.
  const sticky=preferred.get(key);
  if(sticky&&sticky.until>now()&&backup)functions.push(backup);
  if(preferredUs&&backup&&!functions.includes(backup))functions.push(backup);
  if(world?.supports?.(symbol)&&!daily)functions.push(world);
  if(primary&&!symbol.endsWith('.FUT'))functions.push(primary); // Eastmoney namespace is not a Yahoo ticker.
  if(backup&&!functions.includes(backup))functions.push(backup);
  if(daily&&sina&&/^\d{6}\.(SS|SZ)$/.test(symbol))functions.push(async()=>{
   const bars=await sina(symbol);return {source:'sina',retrievalLimited:true,meta:{symbol,exchangeName:symbol.endsWith('.SS')?'SHH':'SHZ',exchangeTimezoneName:'Asia/Shanghai',currency:'CNY',instrumentType:instrumentTypeFor(symbol),dataGranularity:'1d'},timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}};
  });
  if(sticky?.fn&&sticky.until>now()&&functions.includes(sticky.fn)){functions.splice(functions.indexOf(sticky.fn),1);functions.unshift(sticky.fn);}
  const probe=rotation.take(key,functions.slice(1));
  const errors=[];let selected=null,selectedFn=null;
  const wantsVolume=!daily&&marketKeyFor(symbol)==='us';
  const hasIntervalVolume=data=>{
    if(!data||volumeCapability({source:data.source,market:'us',instrumentType:instrumentTypeFor(symbol)}).status!=='verified')return false;
    return data.indicators?.quote?.[0]?.volume?.some(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)===true;
  };
  const needsFallback=()=>wantsVolume&&!hasIntervalVolume(selected);
  // Keep one complete source sequence. A verification turn must not replace
  // an available full history with a shorter public fallback window.
  const better=data=>!selected||(wantsVolume&&hasIntervalVolume(data)!==hasIntervalVolume(selected)?hasIntervalVolume(data):
   !!selected.retrievalLimited&&!data.retrievalLimited||
   !!selected.retrievalLimited===!!data.retrievalLimited&&data.timestamp.length>selected.timestamp.length);
  for(const fn of functions){
   if(selected&&!needsFallback()&&fn!==probe)continue;
   const failureKey=(fn===finnhub?'finnhub':fn===world?'world':fn===primary?'primary':fn===backup?'backup':fn===index?'index':fn===naver?'naver':'sina')+':'+key;
   const failure=failures.get(failureKey);if(failure?.retryAt>now()){errors.push(failure);continue;}
   if(selected&&!needsFallback()){
    const baseline=selected;
    const launched=probes.launch(failureKey+':'+query,async signal=>{
     const data=await fn(symbol,query,{...options,signal,deadlineMs:Math.min(options.deadlineMs||3500,3500)});
     if(!usableHistory(data,symbol,query))throw historyError('HISTORY_BAD_RESPONSE','历史探测未返回有效数据',502);
     return data;
    },{signal:options.signal,onSuccess(data){failures.delete(failureKey);if((!wantsVolume||hasIntervalVolume(data))&&broaderHistory(data,baseline)){preferred.delete(key);preferred.set(key,{fn,until:now()+300000});while(preferred.size>MAX_WATCHLIST_SYMBOLS*2)preferred.delete(preferred.keys().next().value);}},
     onFailure(error){if(error.retryAt>now())failures.set(failureKey,error);while(failures.size>128)failures.delete(failures.keys().next().value);}});
    if(!launched)rotation.retry(key);
    continue;
   }
   try{
    options.signal?.throwIfAborted();
    const opts=fn===primary&&backup?{...options,deadlineMs:Math.min(options.deadlineMs||3500,3500)}:options;
    const data=await fn(symbol,query,opts);
    if(!usableHistory(data,symbol,query))throw historyError('HISTORY_BAD_RESPONSE','历史来源未返回有效数据',502);
    failures.delete(failureKey);
    if(better(data)){selected=data;selectedFn=fn;}
    if(!probe&&!needsFallback())break;
   }catch(error){if(options.signal?.aborted||error.code==='STOPPED')throw error;errors.push(error);if(error.retryAt>now())failures.set(failureKey,error);while(failures.size>128)failures.delete(failures.keys().next().value);}
  }
  if(selected){
   options.signal?.throwIfAborted();
  if(selectedFn===backup&&(!sticky||sticky.until<=now())){preferred.delete(key);preferred.set(key,{until:now()+300000});while(preferred.size>MAX_WATCHLIST_SYMBOLS*2)preferred.delete(preferred.keys().next().value);}
   else if(selectedFn===primary)preferred.delete(key);
   return selected;
  }
  if(errors.length===1)throw errors[0];
  const waits=errors.map(e=>e.retryAt).filter(t=>t>now());
  throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','历史来源暂不可用',503),{retryAt:waits.length?Math.min(...waits):now()+60000});
 };
 fetchHistory.close=()=>{closed=true;probes.close();rotation.clear();preferred.clear();alternative?.close?.();finnhub?.close?.();world?.close?.();};
 fetchHistory.reopen=()=>{closed=false;probes.reopen();alternative?.reopen?.();finnhub?.reopen?.();world?.reopen?.();};
 fetchHistory.diagnostics=()=>({probes:probes.diagnostics()});
 return fetchHistory;
}
