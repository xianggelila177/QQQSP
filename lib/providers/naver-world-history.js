import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {historyError} from '../history-contract.js';
import {providerRetryAt} from './provider-retry.js';

const DAY=86400,CHUNK=2*DAY;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const validVolume=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const stamp=seconds=>new Date(seconds*1000).toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
const supports=symbol=>marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol))&&/^[A-Z][A-Z0-9-]{0,15}$/.test(symbol);
const exchanges=code=>code.endsWith('.O')?['NASDAQ']:code.endsWith('.N')?['NYSE']:code.endsWith('.K')?['AMEX']:['NASDAQ','NYSE','AMEX'];

export function parseNaverWorldCandles(payload,symbol,code,exchange,resolution,{now=Date.now()}={}){
  if(payload?.reutersCode!==code||payload.stockExchangeType!==exchange||!Array.isArray(payload.candleList))
    throw historyError('HISTORY_IDENTITY_CONFLICT','Naver 图表证券身份不一致',422);
  const bars=new Map();
  for(const row of payload.candleList){
    if(row?.reutersCode!==code||row.stockExchangeType!==exchange||typeof row.tradeAt!=='string'||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(row.tradeAt))continue;
    const t=Date.parse(row.tradeAt)/1000,o=row.openPrice,h=row.highPrice,l=row.lowPrice,c=row.closePrice;
    if(!Number.isSafeInteger(t)||t<=0||t*1000>now+5000||!positive(o)||!positive(h)||!positive(l)||!positive(c)||
      h<Math.max(o,c)||l>Math.min(o,c))continue;
    // tradingVolume is the provider's interval field. The accumulated field is
    // deliberately ignored; subtracting it across session boundaries is unsafe.
    const v=payload.hasVolume===false?null:validVolume(row.tradingVolume)?row.tradingVolume:null;
    const bar={t,o,h,l,c,v};
    if(bars.has(t)&&JSON.stringify(bars.get(t))!==JSON.stringify(bar))
      throw historyError('HISTORY_CONFLICT','Naver 图表时间重复且数值冲突',502);
    bars.set(t,bar);
  }
  return [...bars.values()].sort((a,b)=>a.t-b.t);
}

export function createNaverWorldHistory({httpsGet,resolveCode,now=Date.now}={}){
  const cache=new Map(),jobs=new Map(),failures=new Map();let closed=false;
  const fetch=async(symbol,query,{signal}={})=>{
    if(closed)throw historyError('STOPPED','Naver world history stopped',503);
    if(!supports(symbol))throw historyError('HISTORY_UNSUPPORTED','Naver 无该证券分时',422);
    const p=new URLSearchParams(query),interval=p.get('interval');
    if(!['1m','5m'].includes(interval))throw historyError('HISTORY_UNSUPPORTED','Naver 无该分时周期',422);
    const resolution=Number(interval.slice(0,-1)),end=Math.min(Number(p.get('period2'))||Math.floor(now()/60000)*60,Math.floor(now()/1000));
    const range=p.get('range')||'1d',days=/^(\d+)d$/.exec(range)?.[1]||1;
    const start=Number(p.get('period1'))||end-Number(days)*DAY;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end-start>8*DAY)
      throw historyError('HISTORY_UNSUPPORTED','Naver 分时查询范围超过八天',422);
    const key=[symbol,resolution,start,end].join(':'),failed=failures.get(symbol+':'+resolution),old=cache.get(key);
    if(old?.until>now())return old.data;
    if(failed?.retryAt>now())throw Object.assign(historyError(failed.code,'Naver 分时暂不可用',503),{retryAt:failed.retryAt});
    if(jobs.has(key))return jobs.get(key);
    const job=(async()=>{
      const code=await resolveCode(symbol,{signal});
      if(!code||!/^[A-Z][A-Z0-9-]{0,15}(?:\.[A-Z])?$/.test(code))
        throw historyError('HISTORY_IDENTITY_CONFLICT','无法核验 Naver 证券代码',422);
      let lastError=historyError('HISTORY_EMPTY','Naver 没有可用分时',502);
      for(const exchange of exchanges(code)){
        const rows=new Map();let usable=true;
        for(let from=start;from<end;from+=CHUNK){
          signal?.throwIfAborted();
          const to=Math.min(end,from+CHUNK);
          const path=`https://api.stock.naver.com/chart/foreign/ITEM/${exchange}/${encodeURIComponent(code)}/interval/${resolution}?`+
            new URLSearchParams({startDateTime:stamp(from),endDateTime:stamp(to)});
          const r=await httpsGet(path,{Accept:'application/json',Referer:'https://m.stock.naver.com/fchart/foreign/stock/'+code},
            {signal,timeout:7000});
          if(r.status!==200){
            lastError=Object.assign(historyError(r.status===429?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE','Naver 分时 HTTP '+r.status,503),
              {retryAt:providerRetryAt(r.headers,now(),60000)});
            usable=false;break;
          }
          let payload;try{payload=JSON.parse(r.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','Naver 分时不是 JSON',502);}
          const bars=parseNaverWorldCandles(payload,symbol,code,exchange,resolution,{now:now()});
          for(const bar of bars){if(bar.t<start||bar.t>end)continue;
            if(rows.has(bar.t)&&JSON.stringify(rows.get(bar.t))!==JSON.stringify(bar))
              throw historyError('HISTORY_CONFLICT','Naver 分时分页冲突',502);
            rows.set(bar.t,bar);
          }
        }
        if(!usable)continue;
        const bars=[...rows.values()].sort((a,b)=>a.t-b.t);
        if(!bars.length)continue;
        const data={source:'naver-world-chart',retrievalLimited:true,
          meta:{symbol,currency:'USD',exchangeName:exchange,exchangeTimezoneName:'America/New_York',
            instrumentType:instrumentTypeFor(symbol),dataGranularity:interval,chartTimeBasis:'bar-close',
            regularMarketPrice:bars.at(-1).c,regularMarketTime:bars.at(-1).t},
          timestamp:bars.map(b=>b.t),indicators:{quote:[{
            open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}};
        cache.set(key,{data,until:now()+60000});failures.delete(symbol+':'+resolution);
        while(cache.size>80)cache.delete(cache.keys().next().value);
        return data;
      }
      throw lastError;
    })().catch(error=>{
      if(!signal?.aborted&&error.code!=='STOPPED')failures.set(symbol+':'+resolution,
        {code:error.code||'HISTORY_SOURCE_UNAVAILABLE',retryAt:Math.max(now()+60000,error.retryAt||0)});
      throw error;
    }).finally(()=>jobs.delete(key));
    jobs.set(key,job);return job;
  };
  fetch.supports=supports;
  fetch.close=()=>{closed=true;cache.clear();jobs.clear();failures.clear();};
  fetch.reopen=()=>{closed=false;};
  return fetch;
}
