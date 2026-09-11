import {instrumentTypeFor} from './instruments.js';
import {historyError} from './history-contract.js';

// HTTP 200 is not a successful history response if every bar is unusable.
export function usableHistory(data,symbol,query){
 if(!data||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])return false;
 if(data.meta?.symbol&&String(data.meta.symbol).toUpperCase()!==symbol)return false;
 const daily=new URLSearchParams(query).get('interval')==='1d',q=data.indicators.quote[0];
 if(daily&&data.meta?.dataGranularity!=='1d')return false;
 return data.timestamp.some((t,i)=>Number.isFinite(t)&&Number.isFinite(q.close?.[i])&&q.close[i]>0&&(!daily||[q.open?.[i],q.high?.[i],q.low?.[i]].every(n=>Number.isFinite(n)&&n>0)&&q.high[i]>=Math.max(q.open[i],q.close[i])&&q.low[i]<=Math.min(q.open[i],q.close[i])));
}
export function createHistorySource({primary,sina,naver,alternative,now=Date.now}={}) {
 const preferred=new Map();
 return async function fetchHistory(symbol,query,options={}) {
  const daily=new URLSearchParams(query).get('interval')==='1d',key=symbol+':'+daily;
  const backup=alternative&&(!alternative.supports||alternative.supports(symbol))?alternative:null;
  const functions=[];
  if(naver&&/^\d{6}\.(KS|KQ)$/.test(symbol))functions.push(naver);
  // Sticky success for five minutes: a good fallback is not preceded by another
  // failed Yahoo probe on every tab. Never rotate IPs to evade rate limiting.
  const sticky=preferred.get(key);
  if(sticky&&sticky.until>now()&&backup)functions.push(backup);
  if(primary)functions.push(primary);
  if(backup&&!functions.includes(backup))functions.push(backup);
  if(daily&&sina&&/^\d{6}\.(SS|SZ)$/.test(symbol))functions.push(async()=>{
   const bars=await sina(symbol);return {source:'sina',retrievalLimited:true,meta:{symbol,exchangeName:symbol.endsWith('.SS')?'SHH':'SHZ',exchangeTimezoneName:'Asia/Shanghai',currency:'CNY',instrumentType:instrumentTypeFor(symbol),dataGranularity:'1d'},timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}};
  });
  const errors=[];
  for(const fn of functions){
   try{
    options.signal?.throwIfAborted();
    const opts=fn===primary&&backup?{...options,deadlineMs:Math.min(options.deadlineMs||3500,3500)}:options;
    const data=await fn(symbol,query,opts);
    if(!usableHistory(data,symbol,query))throw historyError('HISTORY_BAD_RESPONSE','历史来源未返回有效数据',502);
    if(fn===backup){preferred.delete(key);preferred.set(key,{until:now()+300000});while(preferred.size>48)preferred.delete(preferred.keys().next().value);}
    return data;
   }catch(error){if(options.signal?.aborted||error.code==='STOPPED')throw error;errors.push(error);}
  }
  if(errors.length===1)throw errors[0];
  const waits=errors.map(e=>e.retryAt).filter(t=>t>now());
  throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','历史来源暂不可用',503),{retryAt:waits.length?Math.min(...waits):now()+60000});
 };
}
