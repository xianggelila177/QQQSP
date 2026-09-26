// Futures have their own quote path. Never request a stock/CFD feed as a
// substitute for a named futures series. Public endpoints are best effort.
import {createCachedResource} from '../cached-resource.js';
import {futureInstrumentFor,futuresProducts,isFutureSymbol} from '../futures-instruments.js';
import {providerRetryAt} from './provider-retry.js';
import {publishQuote} from '../quote-contract.js';
import {timezoneOffsetFor} from '../../mkt.mjs';
import {validPrice} from '../price-values.js';
// Public website request identifier published in AKShare futures_hf_em.py; not a user credential.
const PUBLIC_DIRECTORY_ID='58b2fa8f54638b60b87d69b31969089c';
const number=v=>v==null||v===''||v==='-'?null:(n=>Number.isFinite(n)?n:null)(Number(v));
const fail=(code,message)=>Object.assign(new Error(message),{code});
function tradeTime(v,now){const n=number(v),ms=n&&n<1e12?n*1000:n;return ms>0&&ms<=now+5000?ms:null;}
function base(symbol,now){
 const p=futureInstrumentFor(symbol);
 return {symbol,name:p?.name||symbol,displayName:p?.name||symbol,instrumentType:'FUTURE',instrumentTypeSource:p?'catalog':'provider',
  gmtoff:timezoneOffsetFor(symbol,now),market:'国际期货',exchangeName:p?.exchange||'交易所依来源',currency:p?.currency||'USD',priceUnit:p?.priceUnit||'USD',
  marketState:'UNKNOWN',priceSession:'UNKNOWN',ohlcSession:'UNKNOWN',calendarCoverage:{known:false,reason:'futures-calendar-unverified'},
  feedDelayMinutes:null,feedCoverage:'供应商期货序列；实时权限、延迟及换月规则未核验',
  instrumentNote:(p?.seriesNote||'供应商期货代码；合约月份以来源为准')+'；交易时段未核验，不按美股收盘停止读取。',
  sourceCheckedAt:now,fetchedAt:now,pollAfterMs:5000,checkIntervalMs:5000,fxStale:false,
  quoteAt:null,ts:null,volume:null,week52High:null,week52Low:null,ext:null,charts:{intraday:[]}};
}
export function parseEastmoneyFuture(payload,symbol,now=Date.now()){
 const p=futureInstrumentFor(symbol),d=payload?.data;
 if(!p?.secid||!d||String(d.f57).toUpperCase()!==p.sourceSymbol)throw fail('FUTURE_IDENTITY','期货响应代码缺失或不一致');
 const price=number(d.f43);if(!validPrice(price,'FUTURE'))throw fail('FUTURE_EMPTY','期货来源没有有效价格');
 const reference=number(d.f60),change=number(d.f169)??(reference!==null?price-reference:null),at=tradeTime(d.f86,now);
 return publishQuote({...base(symbol,now),src:'eastmoney-futures',price,prevClose:reference,
  change,changePct:reference===0?null:number(d.f170)??(reference!==null&&change!=null?change/reference*100:null),changeBasis:'source-reference',
  open:number(d.f46),dayHigh:number(d.f44),dayLow:number(d.f45),volume:number(d.f47),quoteAt:at,ts:at,
  quoteTimePrecision:at?'second':'unknown',priceBasis:'期货来源最新价；fltt=2原始报价单位，非合约名义金额'});
}
export function parseYahooFuture(data,symbol,now=Date.now()){
 const m=data?.meta;
 if(!m||String(m.symbol).toUpperCase()!==symbol||String(m.instrumentType).toUpperCase()!=='FUTURE')throw fail('FUTURE_IDENTITY','来源未确认该代码为同一期货');
 const price=number(m.regularMarketPrice);if(!validPrice(price,'FUTURE'))throw fail('FUTURE_EMPTY','期货来源没有有效价格');
 const p=futureInstrumentFor(symbol),previous=number(m.previousClose)??number(m.chartPreviousClose),at=tradeTime(m.regularMarketTime,now);
 const quote=data.indicators?.quote?.[0],bars=(data.timestamp||[]).map((t,i)=>({t,c:number(quote?.close?.[i]),v:number(quote?.volume?.[i])})).filter(b=>b.t>0&&b.t*1000<=now&&validPrice(b.c,'FUTURE'));
 return publishQuote({...base(symbol,now),currency:m.currency||p?.currency||'USD',exchangeName:m.fullExchangeName||m.exchangeName||p?.exchange||'交易所依来源',
  src:'yahoo-futures',price,prevClose:previous,change:previous!==null?price-previous:null,changePct:previous!==null&&previous!==0?(price-previous)/previous*100:null,changeBasis:'source-reference',
  open:number(m.regularMarketOpen),dayHigh:number(m.regularMarketDayHigh),dayLow:number(m.regularMarketDayLow),volume:number(m.regularMarketVolume),
  quoteAt:at,ts:at,quoteTimePrecision:at?'second':'unknown',feedDelayMinutes:Number.isFinite(m.exchangeDataDelayedBy)?m.exchangeDataDelayedBy:null,
  priceBasis:'Yahoo期货报价；滚动合约以来源为准',charts:{intraday:bars},slowFields:{intraday:{source:'yahoo-futures',updatedAt:now,stale:!bars.length}}});
}
const listMarket=p=>p.eastmoneyMarket===103?'COBOT':p.eastmoneyMarket===101?'COMEX':'NYMEX';
export function createFuturesProvider({httpsGet,fetchChart,now=Date.now,pollMs=5000}={}){
 const cataloguePreferred=new Map();
 const restricted=error=>error.status===429||error.status===403||error.code==='SOURCE_COOLDOWN';
 async function json(url,timeout=5000){
  const r=await httpsGet(url,{Referer:'https://quote.eastmoney.com/'},{family:4,timeout});
  if(!(r.status>=200&&r.status<300))throw Object.assign(fail('FUTURE_SOURCE','期货来源 HTTP '+r.status),{status:r.status,retryAt:providerRetryAt(r.headers,now())});
  return JSON.parse(r.body);
 }
 // A bounded, lazy catalogue request also serves as a slower quote backup.
 // Never scrape every page and never perform this request on every age tick.
 const lists=createCachedResource({now,ttlMs:30000,retryMs:60000,maxEntries:15,loader:async key=>{
  const [market,page='0']=key.split('|');
  const q=new URLSearchParams({orderBy:'dm',sort:'asc',pageSize:'200',pageIndex:page,token:PUBLIC_DIRECTORY_ID,field:'dm,sc,name,p,zsjd,zde,zdf,f152,o,h,l,zjsj,vol,wp,np,ccl',blockName:'callback'});
  const data=await json('https://futsseapi.eastmoney.com/list/'+market+'?'+q);
  if(!Array.isArray(data.list))throw fail('FUTURE_BAD_RESPONSE','期货目录格式变化');
  return {rows:data.list.slice(0,200),total:number(data.total),checkedAt:now()};
 }});
 async function catalogueQuote(symbol,p){
  const market=listMarket(p);let key=market,list=await lists.get(key),row=list.rows.find(x=>String(x.dm).toUpperCase()===p.sourceSymbol);
  for(let page=1;!row&&page<5&&page*200<(list.total||0);page++){
   key=market+'|'+page;list=await lists.get(key);row=list.rows.find(x=>String(x.dm).toUpperCase()===p.sourceSymbol);
  }
  const failure=lists.failures.get(key);if(failure&&restricted(failure.error))throw failure.error;
  if(!row||!validPrice(number(row.p),'FUTURE'))throw fail('FUTURE_EMPTY','期货目录没有该合约有效报价');
  const previous=number(row.zjsj),price=number(row.p),change=number(row.zde)??(previous!==null?price-previous:null);
  return publishQuote({...base(symbol,list.checkedAt),src:'eastmoney-futures-list',price,prevClose:previous,open:number(row.o),dayHigh:number(row.h),dayLow:number(row.l),volume:number(row.vol),
   change,changePct:previous===0?null:number(row.zdf)??(previous!==null&&change!=null?change/previous*100:null),changeBasis:'previous-settlement',quoteTimePrecision:'unknown',
   priceBasis:'期货目录报价；来源没有成交时间，不按检查时间生成分时',pollAfterMs:30000,checkIntervalMs:30000,...(failure?{stale:true,retryAt:failure.retryAt}:{})});
 }
 async function load(symbol){
  const p=futureInstrumentFor(symbol);
  if(p?.provider==='eastmoney'){
   let triedCatalogue=false;
   if(cataloguePreferred.get(symbol)>now()){
    triedCatalogue=true;
    try{return await catalogueQuote(symbol,p);}catch(error){cataloguePreferred.delete(symbol);if(restricted(error))throw error;}
   }
   try{const result=parseEastmoneyFuture(await json('https://push2.eastmoney.com/api/qt/stock/get?'+new URLSearchParams({secid:p.secid,fields:'f43,f44,f45,f46,f47,f57,f58,f60,f86,f169,f170',fltt:'2',invt:'2'}),2500),symbol,now());cataloguePreferred.delete(symbol);return result;}
   catch(error){
    // Never evade a source rate limit through another endpoint/hostname.
    if(restricted(error)||triedCatalogue)throw error;
    const result=await catalogueQuote(symbol,p);
    if(!result.stale){cataloguePreferred.set(symbol,now()+300000);while(cataloguePreferred.size>24)cataloguePreferred.delete(cataloguePreferred.keys().next().value);}
    return result;
   }
  }
  if(/=F$/.test(symbol))return parseYahooFuture(await fetchChart(symbol,'?interval=1m&range=1d&includePrePost=true'),symbol,now());
  throw fail('FUTURE_UNSUPPORTED','未登记的期货代码');
 }
 const cache=createCachedResource({loader:load,now,ttlMs:pollMs,retryMs:30000,maxEntries:24});
 async function getQuote(symbol){
  const entry=cache.cache.get(symbol),catalogue=entry?.data?.src==='eastmoney-futures-list';
  const maxAgeMs=catalogue?Math.max(0,entry.data.sourceCheckedAt+30000-entry.ts):Math.max(pollMs,entry?.data?.checkIntervalMs||0);
  const data=await cache.get(symbol,{maxAgeMs}),failure=cache.failures.get(symbol);
  const interval=Math.max(pollMs,data.checkIntervalMs||0);
  return {...data,pollAfterMs:interval,checkIntervalMs:interval,nextPollAt:data.src==='eastmoney-futures-list'?data.sourceCheckedAt+30000:(cache.cache.get(symbol)?.ts||now())+interval,
   ...(failure?{stale:true,staleInfo:{reason:failure.error.status===429?'rate-limited':'cooldown',etaMs:Math.max(0,failure.retryAt-now())}}:{})};
 }
 async function search(query){
  const q=String(query||'').toUpperCase().trim(),products=futuresProducts.filter(p=>[p.root,...p.aliases,...p.relatedAliases].some(a=>String(a).toUpperCase()===q)||q.startsWith(p.root)&&/\d/.test(q));
  if(!products.length)return [];
  const found=[];
  for(const market of new Set(products.map(listMarket))){
   try{
    const list=await lists.get(market);
    for(const row of list.rows){const item=futureInstrumentFor(String(row.dm).toUpperCase()+'.FUT');if(!item||!products.some(p=>p.root===item.root))continue;
     found.push({symbol:item.symbol,name:item.name,type:'FUTURE',market:'国际期货',exch:item.exchange,currency:item.currency,source:'eastmoney-futures-directory',seriesNote:item.seriesNote,
      cataloguePartial:list.total==null||list.total>list.rows.length,sourceCheckedAt:list.checkedAt});}
   }catch{} // Local results remain usable while a remote directory is cooling.
  }
  return found.slice(0,40);
 }
 return {supports:isFutureSymbol,getQuote,search,close(){cache.close();lists.close();},reopen(){cache.reopen();lists.reopen();},diagnostics:()=>({quotes:cache.cache.size,failures:cache.failures.size,directoryPages:lists.cache.size,pollMs,cataloguePreferred:Object.fromEntries(cataloguePreferred)})};
}
