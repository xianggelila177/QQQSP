import {MAX_WATCHLIST_SYMBOLS} from '../watchlist-limits.js';
// Public website history adapters. No credentials, no synthetic candles, no
// cross-provider splicing. Endpoint formats are documented in docs/SOURCES-2.2.
import {normalizeNasdaqTime,NASDAQ_TIME_CONTRACT} from './nasdaq-time.js';
import {futureInstrumentFor} from '../futures-instruments.js';
import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {historyError,validDate,localDateAt} from '../history-contract.js';
import {providerRetryAt} from './provider-retry.js';
import {createSourcePolling} from '../source-polling.js';
import {createSourceProbes,broaderHistory} from '../source-probes.js';
import {chartCloseConflict} from '../history-close-consistency.js';
import {tradingDayInfo} from '../market-calendar-api.js';
import {validPrice} from '../price-values.js';
const DAY=86400000;
const NASDAQ_DAILY_WINDOW_DAYS=366;
const NASDAQ_DAILY_LIMIT=300;
const NASDAQ_DAILY_MAX_PAGES=2;
const NASDAQ_DAILY_BUDGET_MS=10000;
const number=value=>value==null||String(value).trim()===''?null:(n=>Number.isFinite(n)?n:null)(Number(String(value).replace(/[,$]/g,'')));
const usable=(b,type)=>b&&Number.isFinite(b.t)&&[b.o,b.h,b.l,b.c].every(n=>validPrice(n,type))&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.h>=b.l;
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
 const bars=sorted(data.klines.map(line=>{const a=String(line).split(',');return {t:a[0]<=today?stamp(a[0]):null,o:number(a[1]),c:number(a[2]),h:number(a[3]),l:number(a[4]),v:number(a[5])};}).filter(bar=>usable(bar,future?'FUTURE':'EQUITY')));
 return toChart(symbol,bars,{source:future?'eastmoney-futures-history':'eastmoney-history',zone,currency:market==='cn'?'CNY':market==='hk'?'HKD':'USD',exchange:future?.exchange || (market==='cn'?(symbol.endsWith('.SS')?'SHH':'SHZ'):market==='hk'?'HKG':'US')});
}
function requestedFrom(query,now){
 const p=new URLSearchParams(query),start=Number(p.get('period1'));
 if(p.has('period1')&&Number.isFinite(start))return new Date(start*1000).toISOString().slice(0,10);
 const years=/^(\d+)y$/.exec(p.get('range')||'')?.[1]||2;
 return new Date(now-Number(years)*366*DAY).toISOString().slice(0,10);
}
function confirmedCloseDate(symbol,quote,now){
 if(quote?.symbol!==symbol||quote.currency!=='USD'||quote.stale||quote.recovery||
  !(Number.isFinite(quote.regularPrice)&&quote.regularPrice>0)||
  !(Number.isFinite(quote.regularQuoteAt)&&quote.regularQuoteAt>0))return null;
 const date=localDateAt(quote.regularQuoteAt,'America/New_York'),day=tradingDayInfo(symbol,date);
 const close=day.regular_sessions?.at(-1)?.close_at_ms;
 return day.known&&day.is_open&&close&&now>=close&&quote.regularQuoteAt>=close&&quote.regularQuoteAt<=close+60000?date:null;
}
export function createPublicHistory({httpsGet,getQuote=()=>null,now=Date.now,maxEntries=MAX_WATCHLIST_SYMBOLS*2,probeTimeoutMs=3500}={}){
 const cache=new Map(),inflight=new Map(),resolvedIds=new Map(),recentFailures=new Map();
 const rotation=createSourcePolling({now,intervalMs:300000,maxEntries});
 const probes=createSourceProbes({now,timeoutMs:probeTimeoutMs,maxEntries}),preferred=new Map();let closed=false;
 async function request(url,headers,signal,timeout=5000){
  const r=await httpsGet(url,{Accept:'application/json,text/plain,*/*',...headers},{timeout,signal});
  if(r?.status!==200)throw Object.assign(historyError(r?.status===429?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE','历史来源 HTTP '+(r?.status||'不可达'),r?.status===429?429:503),{status:r?.status,retryAt:providerRetryAt(r?.headers,now(),60000)});
  try{return JSON.parse(r.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','历史来源不是 JSON',502);}
 }
 async function nasdaqDaily(symbol,base,assetclass,requestedFrom,signal,previous=null,{query='',deadlineMs=NASDAQ_DAILY_BUDGET_MS}={}){
  const rows=new Map(),through=new Date(now()).toISOString().slice(0,10);
  if(previous?.timestamp&&previous.indicators?.quote?.[0]){
   const q=previous.indicators.quote[0];
   for(let i=0;i<previous.timestamp.length;i++)rows.set(previous.timestamp[i],
    {t:previous.timestamp[i],o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]});
  }
  const pageLimit=requestedFrom<new Date(now()-3*NASDAQ_DAILY_WINDOW_DAYS*DAY).toISOString().slice(0,10)?NASDAQ_DAILY_MAX_PAGES:1;
  // An expired cache must refresh its recent tail before extending the past.
  // Otherwise repeated wider requests only backfill old years and freeze the close.
  const expanding=previous?.retrievedFrom&&requestedFrom<previous.retrievedFrom&&
   now()-(previous.sourceCheckedAt||0)<300000;
  let end=expanding?new Date(Date.parse(previous.retrievedFrom+'T00:00:00Z')-DAY).toISOString().slice(0,10):through;
  let pages=0,coveredFrom=previous?.retrievedFrom||null,pageError=null;
  const started=Date.now(),budget=Math.min(NASDAQ_DAILY_BUDGET_MS,Number(deadlineMs)>0?Number(deadlineMs):NASDAQ_DAILY_BUDGET_MS);
  while(pages<pageLimit){
   signal?.throwIfAborted();
   if(pages&&Date.now()-started>=budget-1000)break;
   const start=new Date(Math.max(Date.parse(requestedFrom+'T00:00:00Z'),Date.parse(end+'T00:00:00Z')-NASDAQ_DAILY_WINDOW_DAYS*DAY)).toISOString().slice(0,10);
   const p=new URLSearchParams({assetclass,fromdate:start,todate:end,limit:String(NASDAQ_DAILY_LIMIT)});
   let chart;
   const began=Date.now();
   try{
    const timeout=Math.min(7000,Math.max(1000,budget-(Date.now()-started)));
    const payload=await request(base+'/historical?'+p,{Referer:'https://www.nasdaq.com/'},signal,timeout);
    chart=parseNasdaqHistory(payload,symbol,{now:now()});
   }catch(error){
    error.provider='nasdaq';error.range={from:start,through:end};error.elapsedMs=Date.now()-began;
    if(!error.code)error.code=/timeout/i.test(error.message||'')?'HISTORY_TIMEOUT':'HISTORY_SOURCE_UNAVAILABLE';
    recentFailures.delete(symbol);recentFailures.set(symbol,{provider:'nasdaq',status:error.status||error.statusCode||null,
     code:error.code,elapsedMs:error.elapsedMs,range:error.range});
    while(recentFailures.size>maxEntries)recentFailures.delete(recentFailures.keys().next().value);
    if(!pages||signal?.aborted)throw error;
    pageError=error;break;
   }
   const q=chart.indicators.quote[0];
   if(chart.timestamp.some(t=>{
    const date=localDateAt(t*1000,'America/New_York');return date<start||date>end;
   })){
    const error=historyError('HISTORY_RANGE_CONFLICT','Nasdaq 返回了请求范围之外的日线',422);
    if(!pages)throw error;
    pageError=error;break;
   }
   for(let i=0;i<chart.timestamp.length;i++)rows.set(chart.timestamp[i],{t:chart.timestamp[i],o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]});
   pages++;
   coveredFrom=start;
   if(start<=requestedFrom)break;
   // Advance by calendar window, rather than by the oldest trade date: holidays
   // and sparse listings cannot make us reread the same page forever.
   end=new Date(Date.parse(start+'T00:00:00Z')-DAY).toISOString().slice(0,10);
  }
  // The website's wide window can lag its small recent window. Confirm only
  // a missing, completed session with this same provider; never copy quote OHLC.
  signal?.throwIfAborted();
  const expected=confirmedCloseDate(symbol,getQuote(symbol),now());
  const params=new URLSearchParams(query),period2=Number(params.get('period2'));
  const queryThrough=params.has('period2')&&Number.isFinite(period2)&&period2>0?
   new Date(period2*1000-1).toISOString().slice(0,10):through;
  const latest=rows.size?localDateAt(Math.max(...rows.keys())*1000,'America/New_York'):null;
  let recentTail=null;
  if(expected&&latest&&latest<expected&&expected>=requestedFrom&&expected<=queryThrough){
   const remaining=Math.floor(budget-(Date.now()-started));
   recentTail={expectedTradeDate:expected,status:'skipped',reason:'BUDGET_EXHAUSTED'};
   if(remaining>=1000){
    const start=new Date(Math.max(Date.parse(requestedFrom+'T00:00:00Z'),Date.parse(expected+'T00:00:00Z')-2*DAY)).toISOString().slice(0,10);
    const end=[through,queryThrough,new Date(Date.parse(expected+'T00:00:00Z')+DAY).toISOString().slice(0,10)].sort()[0];
    const p=new URLSearchParams({assetclass,fromdate:start,todate:end,limit:'10'}),began=Date.now();
    const tailDeadline=AbortSignal.timeout(remaining),tailSignal=signal?AbortSignal.any([signal,tailDeadline]):tailDeadline;
    try{
     const payload=await request(base+'/historical?'+p,{Referer:'https://www.nasdaq.com/'},tailSignal,Math.min(3500,remaining));
     signal?.throwIfAborted();tailSignal.throwIfAborted();
     const tail=parseNasdaqHistory(payload,symbol,{now:now()});
     if(tail.timestamp.some(t=>{const date=localDateAt(t*1000,'America/New_York');return date<start||date>end;}))
      throw historyError('HISTORY_RANGE_CONFLICT','Nasdaq 近期日线超出确认范围',422);
     const q=tail.indicators.quote[0];
     for(let i=0;i<tail.timestamp.length;i++)rows.set(tail.timestamp[i],{t:tail.timestamp[i],o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]});
     const confirmed=tail.timestamp.some(t=>localDateAt(t*1000,'America/New_York')===expected);
     recentTail={expectedTradeDate:expected,status:confirmed?'confirmed':'unavailable',reason:confirmed?null:'HISTORY_EMPTY'};
    }catch(error){
     signal?.throwIfAborted();
     const code=tailDeadline.aborted?'HISTORY_TIMEOUT':error.code||'HISTORY_SOURCE_UNAVAILABLE';
     recentTail={expectedTradeDate:expected,status:'unavailable',reason:code};
     recentFailures.delete(symbol);recentFailures.set(symbol,{provider:'nasdaq',stage:'recent-tail',status:error.status||error.statusCode||null,
      code,elapsedMs:Date.now()-began,range:{from:start,through:end}});
     while(recentFailures.size>maxEntries)recentFailures.delete(recentFailures.keys().next().value);
     if(error.retryAt>now())pageError ||= error;
    }
   }
  }
  const bars=sorted([...rows.values()]);
  const data=toChart(symbol,bars,{source:'nasdaq-history',retrievalLimited:coveredFrom>requestedFrom});
  data.retrievedFrom=bars.length?localDateAt(bars[0].t*1000,'America/New_York'):null;
  data.requestedFrom=requestedFrom;
  data.sourceCheckedAt=now();
  data.coverage={requestedFrom,firstTradingDate:data.retrievedFrom,lastTradingDate:bars.length?localDateAt(bars.at(-1).t*1000,'America/New_York'):null,
   retrievalLimited:data.retrievalLimited,stopReason:recentTail&&recentTail.status!=='confirmed'?'recent-tail-unavailable':pageError?'page-error':data.retrievalLimited?'bounded-pages':null,pages,
   ...(recentTail?{recentTail}:{})};
  if(pageError)data.expansionRetryAt=Math.max(now()+60000,Number(pageError.retryAt)||0);
  return data;
 }
 async function load(source,symbol,query,options){
  const minute=new URLSearchParams(query).get('interval')!=='1d',from=requestedFrom(query,now()),key=source+':'+symbol+':'+minute;
  let old=cache.get(key);
  if(old&&old.until>now()&&(old.error||minute||old.from<=from||old.requestedFrom<=from)){
   if(old.error)throw old.error;
   return old.data;
  }
  if(old?.expansionRetryAt>now()&&old.data){
   throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','历史扩展读取正在冷却',503),{retryAt:old.expansionRetryAt});
  }
  if(inflight.has(key)){
   const shared=inflight.get(key);
   try{await shared;}catch(error){
    // A short optional probe (or another cancelled reader) does not own this
    // foreground reader's budget. Retry only cancellation, never a 429/fault.
    if(closed||options.signal?.aborted||!shared.signal?.aborted)throw error;
   }
   options.signal?.throwIfAborted();
   // A yearly tab may require a wider window than an in-flight daily request.
   return load(source,symbol,query,options);
  }
  const task=(async()=>{
   try{
    let data;
    if(source==='nasdaq'){
     const ac=instrumentTypeFor(symbol)==='ETF'?'etf':'stocks',base='https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol);
     const p=new URLSearchParams({assetclass:ac});
     if(minute){
      const j=await request(base+'/chart?'+p,{Referer:'https://www.nasdaq.com/'},options.signal);
      data=parseNasdaqIntraday(j,symbol,{now:now()});
     }else data=await nasdaqDaily(symbol,base,ac,from,options.signal,old?.data,{query,deadlineMs:options.deadlineMs});
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
    cache.set(key,{data,from:data.retrievedFrom||from,requestedFrom:from,expansionRetryAt:data.expansionRetryAt||0,until:now()+(minute?60000:300000)});return data;
   }catch(error){
    if(!options.signal?.aborted){
     if(old?.data){
      cache.set(key,{...old,expansionRetryAt:Math.max(now()+60000,Number(error.retryAt)||0)});
      // Let the history service retain stale data with its original check time;
      // returning it as a new successful source read would conceal the failure.
     }else{
      cache.set(key,{error,from,until:Math.max(now()+60000,error.retryAt||0)});
     }
    }
    throw error;
   }
   finally{inflight.delete(key);while(cache.size>maxEntries)cache.delete(cache.keys().next().value);while(resolvedIds.size>maxEntries)resolvedIds.delete(resolvedIds.keys().next().value);}
  })();task.signal=options.signal;inflight.set(key,task);return task;
 }
 const fetch=async(symbol,query,options={})=>{
  if(closed)throw historyError('STOPPED','Public history sources stopped',503);
  const minute=new URLSearchParams(query).get('interval')!=='1d',us=marketKeyFor(symbol)==='us'&&instrumentTypeFor(symbol)!=='INDEX';
  const candidates=[...(us?['nasdaq']:[]),...(!minute&&eastmoneyIds(symbol).length?['eastmoney']:[])];
  if(!candidates.length)throw historyError('HISTORY_UNSUPPORTED','暂无适用的独立历史来源',422);
  const key=symbol+':'+minute,choice=preferred.get(key);if(!(us&&!minute)&&choice?.until>now()&&candidates.includes(choice.source)){candidates.splice(candidates.indexOf(choice.source),1);candidates.unshift(choice.source);}
  const errors=[],probe=rotation.take(key,candidates.slice(1));let selected=null;
  for(const source of candidates){
   if(selected&&source!==probe)continue;
   if(selected){const baseline=selected;const launched=probes.launch(source+':'+key+':'+query,signal=>load(source,symbol,query,{...options,signal}),{signal:options.signal,
    onSuccess(data){if(!(us&&!minute)&&broaderHistory(data,baseline)){preferred.delete(key);preferred.set(key,{source,until:now()+300000});while(preferred.size>maxEntries)preferred.delete(preferred.keys().next().value);}}});if(!launched)rotation.retry(key);continue;}
   try{
    const data=await load(source,symbol,query,options);
    if(!minute&&chartCloseConflict(symbol,data,getQuote(symbol),now()))
     throw historyError('HISTORY_CLOSE_CONFLICT','同日历史收盘与已确认常规收盘冲突',502);
    if(!selected||data.timestamp.length>selected.timestamp.length)selected=data;
    if(!probe)break;
   }catch(error){if(options.signal?.aborted||error.code==='STOPPED')throw error;errors.push(error);}
  }
  if(selected){options.signal?.throwIfAborted();return selected;}
  const waits=errors.map(e=>e.retryAt).filter(t=>t>now());
  const conflict=errors.some(e=>e.code==='HISTORY_CLOSE_CONFLICT');
  throw Object.assign(historyError(conflict?'HISTORY_CLOSE_CONFLICT':'HISTORY_SOURCE_UNAVAILABLE',conflict?'同日历史收盘冲突，等待独立来源确认':'独立历史来源暂不可用',503),{retryAt:waits.length?Math.min(...waits):now()+60000});
 };
 fetch.supports=symbol=>eastmoneyIds(symbol).length>0||marketKeyFor(symbol)==='us'&&instrumentTypeFor(symbol)!=='INDEX';
 fetch.invalidate=symbol=>{
  for(const key of cache.keys())if(key.split(':')[1]===symbol)cache.delete(key);
  resolvedIds.delete(symbol);
  recentFailures.delete(symbol);
  for(const key of preferred.keys())if(key.startsWith(symbol+':'))preferred.delete(key);
 };
 fetch.close=()=>{closed=true;probes.close();rotation.clear();preferred.clear();};fetch.reopen=()=>{closed=false;probes.reopen();};
 fetch.diagnostics=()=>({probes:probes.diagnostics(),recentFailures:[...recentFailures.entries()].map(([symbol,failure])=>({symbol,...failure}))});
 return fetch;
}
