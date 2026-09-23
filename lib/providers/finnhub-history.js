import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {historyError} from '../history-contract.js';

const DAY=86400;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const volume=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const supported=symbol=>marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol))&&/^[A-Z][A-Z0-9-]{0,15}$/.test(symbol);

export function parseFinnhubCandles(data,symbol,resolution,{now=Date.now()}={}){
  const keys=['t','o','h','l','c','v'];
  if(data?.s!=='ok'||!keys.every(key=>Array.isArray(data[key]))||keys.some(key=>data[key].length!==data.t.length))
    throw historyError('HISTORY_BAD_RESPONSE','Finnhub K 线响应不完整',502);
  const bars=new Map();
  for(let i=0;i<data.t.length;i++){
    const t=data.t[i],o=data.o[i],h=data.h[i],l=data.l[i],c=data.c[i],v=data.v[i];
    if(!Number.isSafeInteger(t)||t<=0||t*1000>now+5000||!positive(o)||!positive(h)||!positive(l)||!positive(c)||
      h<Math.max(o,c)||l>Math.min(o,c)||!volume(v))continue;
    const bar={t,o,h,l,c,v};
    if(bars.has(t)&&JSON.stringify(bars.get(t))!==JSON.stringify(bar))throw historyError('HISTORY_CONFLICT','Finnhub K 线时间重复且数值冲突',502);
    bars.set(t,bar);
  }
  const rows=[...bars.values()].sort((a,b)=>a.t-b.t);
  if(!rows.length)throw historyError('HISTORY_EMPTY','Finnhub 没有可用 K 线',502);
  return {source:'finnhub-candle',retrievalLimited:false,
    meta:{symbol,currency:'USD',exchangeName:'US',exchangeTimezoneName:'America/New_York',
      instrumentType:instrumentTypeFor(symbol),dataGranularity:resolution==='D'?'1d':resolution+'m',
      chartTimeBasis:'bar-start',regularMarketPrice:rows.at(-1).c,regularMarketTime:rows.at(-1).t},
    timestamp:rows.map(b=>b.t),indicators:{quote:[{
      open:rows.map(b=>b.o),high:rows.map(b=>b.h),low:rows.map(b=>b.l),close:rows.map(b=>b.c),volume:rows.map(b=>b.v)}]}};
}

export function createFinnhubHistory({request,now=Date.now}={}){
  const cache=new Map(),jobs=new Map(),denied=new Map();let closed=false;
  const fetch=async(symbol,query,{signal}={})=>{
    if(closed)throw historyError('STOPPED','Finnhub history stopped',503);
    if(!supported(symbol))throw historyError('HISTORY_UNSUPPORTED','Finnhub 不支持该证券',422);
    const p=new URLSearchParams(query),interval=p.get('interval')||'1d',resolution={'1m':'1','5m':'5','15m':'15','30m':'30','60m':'60','1d':'D'}[interval];
    if(!resolution)throw historyError('HISTORY_UNSUPPORTED','Finnhub 不支持该周期',422);
    const end=Math.min(Math.ceil(now()/1000),Number(p.get('period2'))||Math.floor(now()/60000)*60);
    const range=p.get('range')||'2y',unit=/^(\d+)(d|mo|y)$/.exec(range);
    const days=unit?Number(unit[1])*({d:1,mo:31,y:366})[unit[2]]:resolution==='D'?732:5;
    const start=Number(p.get('period1'))||end-days*DAY;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw historyError('BAD_HISTORY_QUERY','Finnhub 时间范围无效',400);
    const family=resolution==='D'?'daily':'minute',blocked=denied.get(family);
    if(blocked>now())throw Object.assign(historyError('FINNHUB_DATASET_DENIED','Finnhub 账户未授权该 K 线数据',503),{retryAt:blocked});
    const key=[symbol,resolution,start,end].join(':'),old=cache.get(key);
    if(old?.until>now())return old.data;
    if(jobs.has(key))return jobs.get(key);
    const job=(async()=>{
      const path='/stock/candle?'+new URLSearchParams({symbol,resolution,from:String(Math.floor(start)),to:String(Math.ceil(end))});
      const response=await request(path,{signal,timeout:6000});
      if(response.status===403){const retryAt=now()+15*60000;denied.set(family,retryAt);
        throw Object.assign(historyError('FINNHUB_DATASET_DENIED','Finnhub 账户未授权该 K 线数据',503),{retryAt});}
      if(response.status!==200)throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','Finnhub K 线暂不可用',503),{retryAt:now()+60000});
      let payload;try{payload=JSON.parse(response.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','Finnhub K 线不是 JSON',502);}
      const data=parseFinnhubCandles(payload,symbol,resolution,{now:now()});
      cache.set(key,{data,until:now()+(family==='minute'?60000:300000)});
      while(cache.size>80)cache.delete(cache.keys().next().value);
      return data;
    })().finally(()=>jobs.delete(key));
    jobs.set(key,job);return job;
  };
  fetch.supports=supported;
  fetch.close=()=>{closed=true;cache.clear();jobs.clear();denied.clear();};
  fetch.reopen=()=>{closed=false;};
  return fetch;
}
