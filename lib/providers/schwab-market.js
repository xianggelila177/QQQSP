import {marketKeyFor,instrumentTypeFor,instrumentMeta,quoteDisplayName} from '../instruments.js';
import {publishQuote} from '../quote-contract.js';
import {priceSessionFor} from '../sessions.js';
import {marketStateFor,timezoneOffsetFor} from '../../mkt.mjs';
import {historyError} from '../history-contract.js';
import {createSharedTasks} from '../shared-task.js';
import {fact} from '../fundamentals.js';

const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export const schwabSupports=s=>marketKeyFor(s)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(s))&&/^[A-Z][A-Z0-9]{0,14}$/.test(s);
function identity(symbol,data){return schwabSupports(symbol)&&data?.symbol===symbol&&data.assetMainType==='EQUITY'&&!data.reference?.isPennyStockForeign;}
export function normalizeSchwabQuote(symbol,data,{now=Date.now(),pollMs=5000}={}){
  if(!identity(symbol,data))return null;
  const q=data.quote||{},r=data.regular||{},at=q.tradeTime,session=priceSessionFor(symbol,at);
  if(!positive(q.lastPrice)||!Number.isSafeInteger(at)||at>now+5000||!session)return null;
  const regularAt=Number.isSafeInteger(r.regularMarketTradeTime)&&r.regularMarketTradeTime<=now+5000?r.regularMarketTradeTime:null;
  const regularPrice=regularAt&&positive(r.regularMarketLastPrice)?r.regularMarketLastPrice:null;
  const meta=instrumentMeta(symbol),name=quoteDisplayName(symbol,data.reference?.description);
  return publishQuote({...meta,symbol,displayName:name,name,price:q.lastPrice,quoteAt:at,ts:at,
    instrumentType:data.assetSubType==='ETF'?'ETF':meta.instrumentType,
    priceSession:session,prevClose:positive(q.closePrice)?q.closePrice:null,providerPrevClose:positive(q.closePrice)?q.closePrice:null,
    regularPrice:regularPrice??(session==='REGULAR'?q.lastPrice:null),regularQuoteAt:regularPrice?regularAt:session==='REGULAR'?at:null,
    open:positive(q.openPrice)?q.openPrice:null,dayHigh:positive(q.highPrice)?q.highPrice:null,dayLow:positive(q.lowPrice)?q.lowPrice:null,
    volume:finite(q.totalVolume)&&q.totalVolume>=0?q.totalVolume:null,volumeUnit:'shares',
    bid:positive(q.bidPrice)?q.bidPrice:null,ask:positive(q.askPrice)?q.askPrice:null,
    bidAskAt:Number.isSafeInteger(q.quoteTime)&&q.quoteTime<=now+5000?q.quoteTime:null,
    currency:'USD',sourceCurrency:'USD',priceScale:1,src:'schwab-quote',priceBasis:'provider-last-trade',
    quoteTimeBasis:'source_time',quoteTimePrecision:'millisecond',
    feedCoverage:'Schwab 账户授权行情；全市场覆盖未独立核验',feedDelayMinutes:data.realtime===true?0:null,
    isDelayed:typeof data.realtime==='boolean'?!data.realtime:null,sourceCheckedAt:now,fetchedAt:now,
    marketState:marketStateFor(symbol,null,now),gmtoff:timezoneOffsetFor(symbol,now),
    ohlcSession:null,ohlcConsistent:false,ext:null,pollAfterMs:pollMs,checkIntervalMs:pollMs});
}
export function parseSchwabCandles(data,symbol,interval,{now=Date.now()}={}){
  if(data?.symbol!==symbol||!Array.isArray(data.candles))throw historyError('HISTORY_IDENTITY_CONFLICT','Schwab K 线证券不匹配',422);
  const bars=new Map();
  for(const row of data.candles){
    const {datetime:t,open:o,high:h,low:l,close:c,volume:v}=row;
    if(!Number.isSafeInteger(t)||t<=0||t>now+5000||![o,h,l,c].every(positive)||h<Math.max(o,c)||l>Math.min(o,c)||!finite(v)||v<0)continue;
    const bar={t:t/1000,o,h,l,c,v};
    if(bars.has(t)&&JSON.stringify(bars.get(t))!==JSON.stringify(bar))throw historyError('HISTORY_CONFLICT','Schwab K 线重复且冲突',502);
    bars.set(t,bar);
  }
  const rows=[...bars.values()].sort((a,b)=>a.t-b.t);
  if(!rows.length)throw historyError('HISTORY_EMPTY','Schwab 没有可用 K 线',502);
  return {source:'schwab-history',adjustment:'source-default-unverified',retrievalLimited:true,
    meta:{symbol,currency:'USD',exchangeName:'US',exchangeTimezoneName:'America/New_York',
      instrumentType:instrumentTypeFor(symbol),instrumentTypeSource:'inferred',dataGranularity:interval,
      chartTimeBasis:'bar-start',chartIntervalSeconds:interval==='1d'?86400:parseInt(interval)*60,
      regularMarketPrice:rows.at(-1).c,regularMarketTime:rows.at(-1).t},
    timestamp:rows.map(b=>b.t),indicators:{quote:[{open:rows.map(b=>b.o),high:rows.map(b=>b.h),low:rows.map(b=>b.l),close:rows.map(b=>b.c),volume:rows.map(b=>b.v)}]}};
}
export function createSchwabMarket({client,now=Date.now,pollMs=5000}={}){
  const quotes=new Map(),cache=new Map(),tasks=createSharedTasks();let closed=false;
  async function fetchQuotes(symbols,{force=false,signal}={}){
    const eligible=[...new Set(symbols.filter(schwabSupports))],due=eligible.filter(s=>force||now()-(quotes.get(s)?.at||0)>=pollMs);
    if(closed)throw historyError('STOPPED','Schwab stopped',503);
    if(due.length)await tasks.run('quotes:'+due.sort().join(','),async taskSignal=>{
      const data=await client.request('/quotes?'+new URLSearchParams({symbols:due.join(','),fields:'quote,reference,regular,fundamental',indicative:'false'}),{signal:taskSignal});
      for(const s of due)quotes.set(s,{at:now(),raw:data[s],quote:normalizeSchwabQuote(s,data[s],{now:now(),pollMs})});
      while(quotes.size>200)quotes.delete(quotes.keys().next().value);
    },{signal});
    return eligible.map(s=>quotes.get(s)?.quote).filter(Boolean);
  }
  async function fetchHistory(symbol,query,{signal}={}){
    const p=new URLSearchParams(query),interval=p.get('interval')||'1d',daily=interval==='1d';
    if(closed)throw historyError('STOPPED','Schwab stopped',503);
    if(!schwabSupports(symbol)||!['1d','1m','5m','15m','30m'].includes(interval))throw historyError('HISTORY_UNSUPPORTED','Schwab 不支持该证券或周期',422);
    const end=Math.min(now(),(Number(p.get('period2'))||Math.floor(now()/1000))*1000);
    const range=/^(\d+)(d|mo|y)$/.exec(p.get('range')||''),days=range?Number(range[1])*({d:1,mo:31,y:366})[range[2]]:daily?732:5;
    const start=(Number(p.get('period1'))||Math.floor(end/1000)-days*86400)*1000;
    if(start>=end)throw historyError('BAD_HISTORY_QUERY','Schwab 时间范围无效');
    const key=[symbol,interval,start,end].join(':'),old=cache.get(key);if(old?.until>now())return old.data;
    return tasks.run(key,async taskSignal=>{
      const params=new URLSearchParams({symbol,periodType:daily?'year':'day',frequencyType:daily?'daily':'minute',frequency:daily?'1':String(parseInt(interval)),
        startDate:String(start),endDate:String(end),needExtendedHoursData:p.get('includePrePost')==='true'?'true':'false',needPreviousClose:'true'});
      const data=parseSchwabCandles(await client.request('/pricehistory?'+params,{signal:taskSignal}),symbol,interval,{now:now()});
      data.sourceCheckedAt=now();data.sourceFreshUntil=now()+(daily?300000:60000);
      cache.set(key,{data,until:data.sourceFreshUntil});while(cache.size>48)cache.delete(cache.keys().next().value);return data;
    },{signal});
  }
  fetchHistory.supports=(symbol,query)=>schwabSupports(symbol)&&['1d','1m','5m','15m','30m'].includes(new URLSearchParams(query).get('interval')||'1d');
  const fields=['week52High','week52Low'];
  const financialSource={id:'schwab-fundamental',priority:-10,ttlMs:300000,fields,match:q=>schwabSupports(q.symbol),load:async(symbol,{signal}={})=>{
    await fetchQuotes([symbol],{signal});const raw=quotes.get(symbol)?.raw;
    if(!identity(symbol,raw))throw historyError('FUNDAMENTALS_IDENTITY','Schwab 证券不匹配',422);
    const out={};for(const [key,sourceKey]of [['week52High','52WeekHigh'],['week52Low','52WeekLow']]){
      const value=raw.quote?.[sourceKey];if(positive(value))out[key]=fact(value,{source:'schwab-fundamental',asOf:null,currency:'USD',unit:'price',basis:'provider-52-week-range'});
    }
    return {symbol,source:'schwab-fundamental',fields:out};
  }};
  const close=()=>{closed=true;tasks.close();cache.clear();quotes.clear();client.close();};
  const reopen=()=>{closed=false;client.reopen();};
  Object.assign(fetchHistory,{close,reopen,invalidate(symbol){for(const key of cache.keys())if(key.startsWith(symbol+':'))cache.delete(key);}});
  return {fetchQuotes,fetchHistory,financialSource,diagnostics:client.diagnostics,close,reopen};
}
