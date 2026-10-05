import {instrumentTypeFor,instrumentMeta,normalizeInstrumentType} from './instruments.js';
import {historyError} from './history-contract.js';
import {createSourcePolling} from './source-polling.js';
import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {createSourceProbes,broaderHistory} from './source-probes.js';
import {volumeCapability} from './volume-normalizer.js';
import {marketKeyFor} from './instruments.js';
import {chartCloseConflict} from './history-close-consistency.js';
import {validPrice} from './price-values.js';
import {currencyUnitInfo} from './currency.js';

const evidencedType=meta=>meta?.instrumentTypeSource==='inferred'?null:normalizeInstrumentType(meta?.instrumentType);
function compatibleHistory(data,symbol,expected={}){
 const meta=data.meta||{},currency=currencyUnitInfo(meta.currency||'').currency;
 const market=meta.exchangeName?marketKeyFor('',meta.exchangeName):null;
 if(market&&market!==marketKeyFor(symbol))return false;
 if(expected.currency&&currency&&currencyUnitInfo(expected.currency).currency!==currency)return false;
 const actualType=evidencedType(meta),expectedType=evidencedType(expected);
 if(actualType&&expectedType&&actualType!==expectedType)return false;
 return true;
}
function sourceWindow(data,query,at){
 const p=new URLSearchParams(query),from=Number(p.get('period1'))||0,to=Number(p.get('period2'))||Infinity;
 const q=data.indicators.quote[0],step=data.meta?.chartTimeBasis==='price-point'||data.source==='nasdaq-intraday'?0:
  Number(data.meta?.chartIntervalSeconds)||({'1m':60,'5m':300}[data.meta?.dataGranularity])||0;
 const times=data.timestamp.filter((t,i)=>Number.isFinite(t)&&t>=from&&t<to&&t<=at/1000+5&&Number.isFinite(q.close?.[i]));
 return times.length?{first:Math.min(...times)-(data.meta?.chartTimeBasis==='bar-close'?step:0),
  last:Math.min(Math.max(...times)+(data.meta?.chartTimeBasis==='bar-close'?0:step),at/1000+5)}:null;
}

// HTTP 200 is not a successful history response if every bar is unusable.
export function usableHistory(data,symbol,query){
 if(!data||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])return false;
 if(data.meta?.symbol&&String(data.meta.symbol).toUpperCase()!==symbol)return false;
 const daily=new URLSearchParams(query).get('interval')==='1d',q=data.indicators.quote[0];
 if(daily&&data.meta?.dataGranularity!=='1d')return false;
 const type=instrumentTypeFor(symbol);
 return data.timestamp.some((t,i)=>Number.isFinite(t)&&validPrice(q.close?.[i],type)&&(!daily||[q.open?.[i],q.high?.[i],q.low?.[i]].every(n=>validPrice(n,type))&&q.high[i]>=Math.max(q.open[i],q.close[i])&&q.low[i]<=Math.min(q.open[i],q.close[i])));
}
export function createHistorySource({primary,sina,naver,index,alternative,finnhub,world,worldDaily,twse,taiwan,getQuote=()=>null,resolveInstrument,now=Date.now,probeTimeoutMs=3500}={}) {
 const preferred=new Map(),failures=new Map();
 const rotation=createSourcePolling({now,intervalMs:300000,maxEntries:MAX_WATCHLIST_SYMBOLS*2});
 const probes=createSourceProbes({now,timeoutMs:probeTimeoutMs,maxEntries:MAX_WATCHLIST_SYMBOLS*2});let closed=false;
 const fetchHistory=async function(symbol,query,options={}) {
  if(closed)throw historyError('STOPPED','History sources stopped',503);
  if(resolveInstrument){const identity=await resolveInstrument(symbol,options);options={...options,instrumentType:identity.type,instrumentTypeSource:identity.status==='unknown'?'inferred':identity.source||'resolved'};}
  const daily=new URLSearchParams(query).get('interval')==='1d',key=symbol+':'+daily+':'+(options.instrumentType||getQuote(symbol)?.instrumentType||'');
  const backup=alternative&&(!alternative.supports||alternative.supports(symbol))?alternative:null;
  const functions=[];
  const twseDaily=daily&&twse?.supports?.(symbol);
  if(twseDaily)functions.push(twse);
  if(daily&&worldDaily?.supports?.(symbol,query))functions.push(worldDaily);
  const taiwanMinute=!daily&&taiwan?.supports?.(symbol,query);
  if(taiwanMinute)functions.push(taiwan);
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
  if(daily&&sina&&/^\d{6}\.(SS|SZ)$/.test(symbol))functions.push(async(_symbol,_query,opts)=>{
   const bars=await sina(symbol,opts);return {source:'sina',retrievalLimited:true,meta:{symbol,exchangeName:symbol.endsWith('.SS')?'SHH':'SHZ',exchangeTimezoneName:'Asia/Shanghai',currency:'CNY',instrumentType:instrumentTypeFor(symbol),instrumentTypeSource:instrumentMeta(symbol).instrumentTypeSource,dataGranularity:'1d'},timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}};
  });
  if(!twseDaily&&!taiwanMinute&&sticky?.fn&&sticky.until>now()&&functions.includes(sticky.fn)){functions.splice(functions.indexOf(sticky.fn),1);functions.unshift(sticky.fn);}
  const probe=rotation.take(key,functions.slice(1));
  const errors=[];let selected=null,selectedFn=null;
  const wantsVolume=!daily&&marketKeyFor(symbol)==='us'&&instrumentTypeFor(symbol,options.instrumentType)!=='INDEX';
  const hasIntervalVolume=data=>{
    if(!data||volumeCapability({source:data.source,market:'us',instrumentType:instrumentTypeFor(symbol)}).status!=='verified')return false;
    return data.indicators?.quote?.[0]?.volume?.some(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)===true;
  };
  const needsFallback=()=>wantsVolume&&!hasIntervalVolume(selected);
  // Keep one complete source sequence. A verification turn must not replace
  // an available full history with a shorter public fallback window.
  const better=data=>{
   if(!selected)return true;
   if(!compatibleHistory(data,symbol,selected.meta)||data.adjustment&&selected.adjustment&&data.adjustment!==selected.adjustment)return false;
   const next=sourceWindow(data,query,now()),prior=sourceWindow(selected,query,now());
   if(!next)return false;if(!prior)return true;
   if(next.last!==prior.last)return next.last>prior.last;
   if(next.first!==prior.first)return next.first<prior.first;
   return wantsVolume&&hasIntervalVolume(data)!==hasIntervalVolume(selected)?hasIntervalVolume(data):
    !!selected.retrievalLimited&&!data.retrievalLimited||
    !!selected.retrievalLimited===!!data.retrievalLimited&&data.timestamp.length>selected.timestamp.length;
  };
  for(const fn of functions){
   if(selected&&!needsFallback()&&fn!==probe)continue;
   const failureKey=(fn===taiwan?'taiwan':fn===twse?'twse':fn===finnhub?'finnhub':fn===world?'world':fn===worldDaily?'world-daily':fn===primary?'primary':fn===backup?'backup':fn===index?'index':fn===naver?'naver':'sina')+':'+key;
   const failure=failures.get(failureKey);if(failure?.retryAt>now()){errors.push(failure);continue;}
   if(selected&&!needsFallback()){
    const baseline=selected;
    const launched=probes.launch(failureKey+':'+query,async signal=>{
     const data=await fn(symbol,query,{...options,signal,priority:'background',deadlineMs:Math.min(options.deadlineMs||3500,3500)});
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
    let data=await fn(symbol,query,opts);
    const expected={...getQuote(symbol),...(options.instrumentType?{instrumentType:options.instrumentType,instrumentTypeSource:options.instrumentTypeSource}:{} )};
    if(!compatibleHistory(data,symbol,expected))
     throw historyError('HISTORY_IDENTITY_CONFLICT','History source identity does not match the listing',422);
    // Generic adapters use an inferred EQUITY only for numeric validation. It
    // is not contrary listing evidence and must not overwrite a resolved fund.
    if(data?.meta?.instrumentTypeSource==='inferred'&&evidencedType(expected))
     data={...data,meta:{...data.meta,instrumentType:evidencedType(expected),instrumentTypeSource:expected.instrumentTypeSource||'resolved'}};
    if(!usableHistory(data,symbol,query)){
     const empty=data?.meta?.symbol===symbol&&Array.isArray(data.timestamp)&&!data.timestamp.length&&(!daily||data.meta.dataGranularity==='1d');
     throw historyError(empty?'HISTORY_EMPTY':'HISTORY_BAD_RESPONSE','历史来源未返回有效数据',502);
    }
    if(daily&&chartCloseConflict(symbol,data,getQuote(symbol),now()))
     throw historyError('HISTORY_CLOSE_CONFLICT','同日历史收盘与已确认常规收盘冲突',502);
    failures.delete(failureKey);
    if(better(data)){selected=data;selectedFn=fn;}
    if(fn===twse||fn===taiwan)break; // Native Taiwan sources precede optional chart-API fallback.
    if(!probe&&!needsFallback())break;
   }catch(error){if(options.signal?.aborted||error.code==='STOPPED')throw error;errors.push(error);if(error.retryAt>now()&&!error.emptyRange&&error.code!=='HISTORY_EMPTY')failures.set(failureKey,error);while(failures.size>128)failures.delete(failures.keys().next().value);}
  }
  if(selected){
   options.signal?.throwIfAborted();
  if(selectedFn===backup&&(!sticky||sticky.until<=now())){preferred.delete(key);preferred.set(key,{until:now()+300000});while(preferred.size>MAX_WATCHLIST_SYMBOLS*2)preferred.delete(preferred.keys().next().value);}
   else if(selectedFn===primary)preferred.delete(key);
   return selected;
  }
  if(errors.length===1)throw errors[0];
  const waits=errors.map(e=>e.retryAt).filter(t=>t>now());
  const conflict=errors.some(e=>e.code==='HISTORY_CLOSE_CONFLICT');
  throw Object.assign(historyError(conflict?'HISTORY_CLOSE_CONFLICT':'HISTORY_SOURCE_UNAVAILABLE',conflict?'同日历史收盘冲突，等待独立来源确认':'历史来源暂不可用',503),{retryAt:waits.length?Math.min(...waits):now()+60000,emptyRange:!conflict&&errors.some(e=>e.emptyRange||e.code==='HISTORY_EMPTY')});
 };
 fetchHistory.close=()=>{closed=true;probes.close();rotation.clear();preferred.clear();alternative?.close?.();finnhub?.close?.();world?.close?.();worldDaily?.close?.();twse?.close?.();taiwan?.close?.();};
 fetchHistory.reopen=()=>{closed=false;probes.reopen();alternative?.reopen?.();finnhub?.reopen?.();world?.reopen?.();worldDaily?.reopen?.();twse?.reopen?.();taiwan?.reopen?.();};
 fetchHistory.invalidate=symbol=>{
  for(const key of [...failures.keys()])if(key.split(':')[1]===symbol)failures.delete(key);
  for(const key of [...preferred.keys()])if(key.startsWith(symbol+':'))preferred.delete(key);
  for(const source of [alternative,finnhub,world,worldDaily,twse,taiwan,index,naver,primary])source?.invalidate?.(symbol);
 };
 fetchHistory.diagnostics=()=>({probes:probes.diagnostics(),
  failures:[...failures.entries()].map(([key,error])=>({key,code:error.code||'HISTORY_SOURCE_UNAVAILABLE',
   status:error.status||error.statusCode||null,retryAt:Number(error.retryAt)||null})),
  alternative:alternative?.diagnostics?.()||null,worldDaily:worldDaily?.diagnostics?.()||null});
 return fetchHistory;
}
