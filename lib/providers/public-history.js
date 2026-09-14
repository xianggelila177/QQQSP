// Public website history adapters. No credentials, no synthetic candles, no
// cross-provider splicing. Endpoint formats are documented in docs/SOURCES-2.2.
import {normalizeNasdaqTime,NASDAQ_TIME_CONTRACT} from './nasdaq-time.js';
import {futureInstrumentFor} from '../futures-instruments.js';
import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {historyError,validDate,localDateAt} from '../history-contract.js';
import {providerRetryAt} from './provider-retry.js';
const DAY=86400000;
const number=value=>value==null||String(value).trim()===''?null:(n=>Number.isFinite(n)?n:null)(Number(String(value).replace(/[,$]/g,'')));
const usable=b=>b&&Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(n=>Number.isFinite(n)&&n>0)&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.h>=b.l;
const stamp=date=>validDate(date)?Date.parse(date+'T12:00:00Z')/1000:null;
const missing=()=>historyError('HISTORY_EMPTY','来源没有可用历史数据',502);
const limited=e=>e?.status===429||e?.status===403||e?.code==='SOURCE_COOLDOWN';
function toChart(symbol,bars,{source,currency='USD',exchange='US',zone='America/New_York',minute=false,retrievalLimited=true}={}){
 const latest=bars.at(-1);if(!latest)throw missing();
 return {source,retrievalLimited,meta:{symbol,currency,exchangeName:exchange,exchangeTimezoneName:zone,instrumentType:instrumentTypeFor(symbol),dataGranularity:minute?'1m':'1d',regularMarketPrice:latest.c,regularMarketTime:latest.t},timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o??null),high:bars.map(b=>b.h??null),low:bars.map(b=>b.l??null),close:bars.map(b=>b.c),volume:bars.map(b=>b.v??null)}]}};
}
function sorted(rows){return [...new Map(rows.map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t);}
export function parseNasdaqHistory(payload,symbol,{now=Date.now()}={}){
 const data=payload?.data;
 if(data?.symbol&&String(data.symbol).toUpperCase()!==symbol)throw historyError('HISTORY_IDENTITY_CONFLICT','Nasdaq 返回了其他证券',422);
 const rows=data?.tradesTable?.rows;
 if(!Array.isArray(rows))throw missing();
 const today=localDateAt(now,'America/New_York');
 const bars=sorted(rows.map(row=>{
  const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(row.date));
  const date=m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:String(row.date);
  return {t:date<=today?stamp(date):null,o:number(row.open),h:number(row.high),l:number(row.low),c:number(row.close),v:number(row.volume)};
 }).filter(usable));
 return toChart(symbol,bars,{source:'nasdaq-history'});
}
export function parseNasdaqIntraday(payload,symbol,{now=Date.now()}={}){
 const data=payload?.data;
 if(data?.symbol&&String(data.symbol).toUpperCase()!==symbol)throw historyError('HISTORY_IDENTITY_CONFLICT','Nasdaq 返回了其他证券',422);
 if(!Array.isArray(data?.chart))throw missing();
 const normalized=data.chart.map(row=>{const time=normalizeNasdaqTime(row);return {t:time?.at/1000,c:number(row.y),v:null,basis:time?.basis};});
 let bars=sorted(normalized.filter(b=>Number.isFinite(b.t)&&b.t>0&&b.t*1000<=now&&b.c>0));
 const day=bars.length?localDateAt(bars.at(-1).t*1000,'America/New_York'):null;
 bars=bars.filter(b=>localDateAt(b.t*1000,'America/New_York')===day);
 const chart=toChart(symbol,bars,{source:'nasdaq-intraday',minute:true});
 chart.meta.chartTimeContract=NASDAQ_TIME_CONTRACT;
 chart.meta.chartTimeZone='America/New_York';
 chart.meta.chartTimeBasis=bars.every(b=>b.basis==='source-label')?'source-label':'epoch-unverified';
 return chart;
}
const indexIds=Object.freeze({'^IXIC':'100.IXIC','^GSPC':'100.SPX','^DJI':'100.DJIA','^NDX':'100.NDX','^HSI':'100.HSI'});
export function eastmoneyIds(symbol){
 const future=futureInstrumentFor(symbol);if(future)return future.secid?[future.secid]:[];
 if(indexIds[symbol])return [indexIds[symbol]];
 const cn=/^(\d{6})\.(SS|SZ)$/.exec(symbol);if(cn)return [(cn[2]==='SS'?'1.':'0.')+cn[1]];
 const hk=/^(\d{4,5})\.HK$/.exec(symbol);if(hk)return ['116.'+hk[1].padStart(5,'0')];
 return marketKeyFor(symbol)==='us'&&/^[A-Z][A-Z0-9-]{0,14}$/.test(symbol)?['105.','106.','107.'].map(x=>x+symbol):[];
}
export function parseEastmoneyHistory(payload,symbol,secid,{now=Date.now()}={}){
 const data=payload?.data,code=secid.slice(secid.indexOf('.')+1);
 if(!data||!Array.isArray(data.klines))throw missing();
 if(String(data.code).toUpperCase()!==code.toUpperCase()||data.market!=null&&String(data.market)!==secid.split('.')[0])throw historyError('HISTORY_IDENTITY_CONFLICT','东方财富返回了其他证券',422);
 const future=futureInstrumentFor(symbol);
 const market=marketKeyFor(symbol),zone=future?.timezone || (market==='cn'?'Asia/Shanghai':market==='hk'?'Asia/Hong_Kong':'America/New_York');
 const today=localDateAt(now,zone);
 const bars=sorted(data.klines.map(line=>{const a=String(line).split(',');return {t:a[0]<=today?stamp(a[0]):null,o:number(a[1]),c:number(a[2]),h:number(a[3]),l:number(a[4]),v:number(a[5])};}).filter(usable));
 return toChart(symbol,bars,{source:future?'eastmoney-futures-history':'eastmoney-history',zone,currency:market==='cn'?'CNY':market==='hk'?'HKD':'USD',exchange:future?.exchange || (market==='cn'?(symbol.endsWith('.SS')?'SHH':'SHZ'):market==='hk'?'HKG':'US')});
}
function requestedFrom(query,now){
 const p=new URLSearchParams(query),start=Number(p.get('period1'));
 if(p.has('period1')&&Number.isFinite(start))return new Date(start*1000).toISOString().slice(0,10);
 const years=/^(\d+)y$/.exec(p.get('range')||'')?.[1]||2;
 return new Date(now-Number(years)*366*DAY).toISOString().slice(0,10);
}
export function createPublicHistory({httpsGet,now=Date.now,maxEntries=48}={}){
 const cache=new Map(),inflight=new Map(),resolvedIds=new Map();
 async function request(url,headers,signal){
  const r=await httpsGet(url,{Accept:'application/json,text/plain,*/*',...headers},{timeout:5000,signal});
  if(r?.status!==200)throw Object.assign(historyError(r?.status===429?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE','历史来源 HTTP '+(r?.status||'不可达'),r?.status===429?429:503),{status:r?.status,retryAt:providerRetryAt(r?.headers,now(),60000)});
  try{return JSON.parse(r.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','历史来源不是 JSON',502);}
 }
 async function load(source,symbol,query,options){
  const minute=new URLSearchParams(query).get('interval')!=='1d',from=requestedFrom(query,now()),key=source+':'+symbol+':'+minute;
  let old=cache.get(key);
  if(old&&old.until>now()&&(old.error||minute||old.from<=from)){if(old.error)throw old.error;return old.data;}
  if(inflight.has(key)){
   await inflight.get(key);options.signal?.throwIfAborted();
   // A yearly tab may require a wider window than an in-flight daily request.
   return load(source,symbol,query,options);
  }
  const task=(async()=>{
   try{
    let data;
    if(source==='nasdaq'){
     const ac=instrumentTypeFor(symbol)==='ETF'?'etf':'stocks',base='https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol);
     const p=new URLSearchParams({assetclass:ac});
     if(!minute){p.set('fromdate',from);p.set('todate',new Date(now()).toISOString().slice(0,10));p.set('limit','16000');}
     const j=await request(base+(minute?'/chart?':'/historical?')+p,{Referer:'https://www.nasdaq.com/'},options.signal);
     data=minute?parseNasdaqIntraday(j,symbol,{now:now()}):parseNasdaqHistory(j,symbol,{now:now()});
    }else{
     const ids=eastmoneyIds(symbol),known=resolvedIds.get(symbol),candidates=known?[known]:ids;
     let error=missing();
     for(const secid of candidates){
      options.signal?.throwIfAborted();
      try{
       const p=new URLSearchParams({secid,klt:'101',fqt:'0',beg:from.replaceAll('-',''),end:'20500101',lmt:'16000',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
       if(futureInstrumentFor(symbol)){p.set('iscca','1');p.set('forcect','1');p.set('fields1','f1,f2,f3,f4,f5,f6,f7,f8');p.set('fields2','f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64');}
       const j=await request('https://push2his.eastmoney.com/api/qt/stock/kline/get?'+p,{Referer:'https://quote.eastmoney.com/'},options.signal);
       data=parseEastmoneyHistory(j,symbol,secid,{now:now()});resolvedIds.set(symbol,secid);break;
      }catch(e){error=e;if(limited(e)||options.signal?.aborted)throw e;}
     }
     if(!data)throw error;
    }
    options.signal?.throwIfAborted();
    cache.set(key,{data,from,until:now()+(minute?60000:300000)});return data;
   }catch(error){if(!options.signal?.aborted)cache.set(key,{error,from,until:Math.max(now()+60000,error.retryAt||0)});throw error;}
   finally{inflight.delete(key);while(cache.size>maxEntries)cache.delete(cache.keys().next().value);while(resolvedIds.size>maxEntries)resolvedIds.delete(resolvedIds.keys().next().value);}
  })();inflight.set(key,task);return task;
 }
 const fetch=async(symbol,query,options={})=>{
  const minute=new URLSearchParams(query).get('interval')!=='1d',us=marketKeyFor(symbol)==='us'&&instrumentTypeFor(symbol)!=='INDEX';
  const candidates=[...(us?['nasdaq']:[]),...(!minute&&eastmoneyIds(symbol).length?['eastmoney']:[])];
  if(!candidates.length)throw historyError('HISTORY_UNSUPPORTED','暂无适用的独立历史来源',422);
  const errors=[];
  for(const source of candidates){try{return await load(source,symbol,query,options);}catch(error){if(options.signal?.aborted||error.code==='STOPPED')throw error;errors.push(error);}}
  const waits=errors.map(e=>e.retryAt).filter(t=>t>now());
  throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','独立历史来源暂不可用',503),{retryAt:waits.length?Math.min(...waits):now()+60000});
 };
 fetch.supports=symbol=>eastmoneyIds(symbol).length>0||marketKeyFor(symbol)==='us'&&instrumentTypeFor(symbol)!=='INDEX';
 return fetch;
}
