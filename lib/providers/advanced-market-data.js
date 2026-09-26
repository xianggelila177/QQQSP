import {createCachedResource} from '../cached-resource.js';
import {createTaskQueue} from '../task-queue.js';
import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {timezoneForSymbol} from '../../mkt.mjs';
import {aggregateHistory,periodBounds} from '../history-aggregate.js';
import {localDateAt,validDate,addDays,dateMs,contentHash} from '../history-contract.js';
import {localInstant,previousTradingDate,tradingDayInfo} from '../market-calendar-api.js';
import {contextError} from '../api-error.js';
import {number} from '../context-values.js';
import {symbolValid} from '../symbol-validation.js';
import {volumeCapability} from '../volume-normalizer.js';
import {validPrice} from '../price-values.js';
function nextToken(value){if(value==null)return null;if(typeof value!=='string'||!value.length||value.length>8192)throw contextError('SOURCE_CURSOR_INVALID',502);return value;}
const BASE='https://data.alpaca.markets';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const barValid=(b,type)=>b&&[b.o,b.h,b.l,b.c].every(v=>validPrice(v,type))&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.l<=b.h&&(b.v==null||finite(b.v)&&b.v>=0);
function dateOnly(v){return validDate(v)?v:null;}
export function normalizeAlpacaActions(symbol,payload,{now=Date.now()}={}){
 const root=payload?.corporate_actions;if(!root||typeof root!=='object'||Array.isArray(root))throw contextError('SOURCE_BAD_RESPONSE',502);
 const events=[];let rejected=0;
 for(const [group,kind] of [['forward_splits','split'],['reverse_splits','split'],['cash_dividends','dividend']]){
  if(root[group]!==undefined&&!Array.isArray(root[group]))throw contextError('SOURCE_BAD_RESPONSE',502);
  for(const e of root[group]||[]){
   if(e?.symbol!==symbol||!dateOnly(e.ex_date)){rejected++;continue;}
   const ratio=kind==='split'&&finite(e.new_rate)&&finite(e.old_rate)&&e.new_rate>0&&e.old_rate>0?e.new_rate/e.old_rate:null;
   const amount=kind==='dividend'&&finite(e.rate)&&e.rate>=0?e.rate:null;
   if(kind==='split'&&ratio===null||kind==='dividend'&&amount===null){rejected++;continue;}
   // Alpaca's cash-action schema does not guarantee a currency field. Never assume USD.
   events.push({id:typeof e.id==='string'?e.id:null,type:kind,ex_date:e.ex_date,ratio,amount,currency:/^[A-Z]{3}$/.test(e.currency||'')?e.currency:null,
    payment_date:dateOnly(e.payable_date),process_date:dateOnly(e.process_date),source:'alpaca-corporate-actions',as_of_ms:null,source_checked_at_ms:now,
    amount_basis:kind==='dividend'?'source_reported_per_share':'not_applicable'});
  }
 }
 return {events,rejected};
}
export function createAdvancedMarketData({httpsGet,fetchChart,fetchActionsChart=fetchChart,apiKey='',apiSecret='',feed='iex',now=Date.now}={}){
 const configured=!!(apiKey&&apiSecret),queue=createTaskQueue({maxActive:2,maxQueued:16,now});
 const headers={'APCA-API-KEY-ID':apiKey,'APCA-API-SECRET-KEY':apiSecret,Accept:'application/json'};
 async function request(route,params,signal){
  if(!configured)throw contextError('MARKET_DATA_NOT_CONFIGURED',503);
  const url=BASE+route+'?'+new URLSearchParams(params);
  const r=await httpsGet(url,headers,{signal,timeout:8000});
  if(r.status!==200){const code=r.status===429?'SOURCE_RATE_LIMITED':r.status===401?'SOURCE_UNAUTHORIZED':r.status===403?'SOURCE_PERMISSION_DENIED':r.status===404?'SOURCE_NOT_FOUND':'SOURCE_UNAVAILABLE';
   const retry=Math.max(1,Math.min(900,Number(r.headers?.['retry-after'])||60));throw Object.assign(contextError(code,503),{retryAt:now()+retry*1000});}
  try{return JSON.parse(r.body);}catch{throw contextError('SOURCE_BAD_RESPONSE',502);}
 }
 function supported(symbol){if(marketKeyFor(symbol)!=='us'||!['EQUITY','ETF','MUTUALFUND'].includes(instrumentTypeFor(symbol)))throw contextError('SOURCE_MARKET_UNSUPPORTED',422);}
 async function bars(symbol,params,signal,{maxPages=8,maxRows=20000}={}){
  const rows=[],seenTokens=new Set();let token=null,limited=false,pages=0;
  do{
   signal?.throwIfAborted();const data=await request('/v2/stocks/'+encodeURIComponent(symbol)+'/bars',{...params,limit:'2500',...(token?{page_token:token}:{})},signal);
   if(data.symbol!==symbol||!Array.isArray(data.bars))throw contextError('SOURCE_IDENTITY_MISMATCH',502);
   if(data.bars.length>2500)throw contextError('SOURCE_BAD_RESPONSE',502);
   rows.push(...data.bars);pages++;token=nextToken(data.next_page_token);
   if(token&&(typeof token!=='string'||token.length>8192||seenTokens.has(token)))throw contextError('SOURCE_CURSOR_INVALID',502);
   if(token)seenTokens.add(token);
   if(token&&(pages>=maxPages||rows.length>=maxRows)){limited=true;break;}
  }while(token);
  if(rows.length>maxRows)throw contextError('RESULT_TOO_LARGE',422);
  return {rows,limited,pages};
 }
 async function daily(q,signal){
  supported(q.symbol);if(!configured)throw contextError('ADJUSTMENT_SOURCE_NOT_CONFIGURED',503);
  const period=q.daily_granularity||'daily',zone=timezoneForSymbol(q.symbol),today=localDateAt(now(),zone),end=q.daily_before?addDays(q.daily_before,-1):today;
  const days=Math.min(45*366,q.daily_bar_count*(period==='monthly'?32:period==='weekly'?8:2)+70),start=addDays(end,-days);
  const adjust={raw:'raw',split:'split',split_dividend:'split,dividend'}[q.adjustment];
  const result=await bars(q.symbol,{timeframe:'1Day',start,end,adjustment:adjust,feed,sort:'desc'},signal);
  const identity={symbol:q.symbol,source:'alpaca-'+feed,adjustment:q.adjustment,currency:'USD',...(q.adjustment!=='raw'?{adjustment_anchor_date:today}:{})},seriesId=contentHash(identity);
  if(q.daily_series_id&&q.daily_series_id!==seriesId)throw contextError('HISTORY_SERIES_CHANGED',409);
  let rejected=0;const byDate=new Map();
  for(const b of result.rows){
   const at=Date.parse(b.t),sessionDate=Number.isFinite(at)?localDateAt(at,zone):null;
   if(!sessionDate||sessionDate<start||sessionDate>end||!barValid(b)){rejected++;continue;}
   const old=byDate.get(sessionDate);if(old&&contentHash([old.o,old.h,old.l,old.c,old.v])!==contentHash([b.o,b.h,b.l,b.c,b.v]))throw contextError('SOURCE_BAR_CONFLICT',502);
   byDate.set(sessionDate,{sessionDate,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v??null,source:identity.source,currency:'USD',adjustmentBasis:q.adjustment,volumeUnit:'shares'});
  }
  const sorted=[...byDate.values()].sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate));
  const grouped=aggregateHistory(sorted,period,{symbol:q.symbol,zone,asOf:now(),requestedFrom:start,historyAsOf:sorted.at(-1)?.sessionDate});
  const selected=grouped.filter(b=>!q.daily_before||b.periodStart<q.daily_before).slice(-q.daily_bar_count);
  return {...identity,period,exchangeTimeZone:zone,instrumentType:instrumentTypeFor(q.symbol),seriesId,sourceCheckedAt:now(),volumeUnit:'shares',adjustmentBasis:q.adjustment,
   hasMore:grouped.length>selected.length?true:null,nextBefore:selected[0]?.periodStart||null,
   bars:selected.map(b=>({...b,adjustedClose:q.adjustment==='raw'?null:b.c})),stale:false,
   coverage:{status:result.limited||rejected?'partial':'source-reported',stopReason:result.limited?'retrieval-budget':null,rejectedRows:rejected,requestedFrom:start,requestedThrough:end,providerPages:result.pages,
    adjustment:q.adjustment,adjustment_method:'provider-supplied; split_dividend=split,dividend; spin-offs excluded',feed,volume_basis:'split-adjusted shares for split modes; otherwise raw shares'}};
 }
 function intradayRange(q){
  const today=localDateAt(now(),timezoneForSymbol(q.symbol));let start,end;
  if(q.intraday_month){start=q.intraday_month+'-01';end=addDays(periodBounds(start,'monthly').periodEndExclusive,-1);}
  else {start=q.intraday_date||previousTradingDate(q.symbol,q.intraday_before||addDays(today,1));end=start;}
  if(start>today)throw contextError('INTRADAY_FUTURE_DATE',422);
  if(end>today)end=today;return {start,end};
 }
 async function intraday(q,signal){
  const {start,end}=intradayRange(q),zone=timezoneForSymbol(q.symbol);
  if(start===end){const day=tradingDayInfo(q.symbol,start);if(day.known&&!day.is_open)return {symbol:q.symbol,points:[],start,end,source:null,missing_reason:'NON_TRADING_DAY',sourceCheckedAt:null,mode:'source_ohlcv'};}
  const a=localInstant(q.symbol,start),b=Math.min(now(),localInstant(q.symbol,addDays(end,1))-1);
  let data,source,currency,adjustment='source_default_unverified',volumeUnit=null,limited=false,points=[],rejected=0;
  if(configured&&marketKeyFor(q.symbol)==='us'&&['EQUITY','ETF','MUTUALFUND'].includes(instrumentTypeFor(q.symbol))){
   const result=await bars(q.symbol,{timeframe:'1Min',start:new Date(a).toISOString(),end:new Date(b).toISOString(),adjustment:'raw',feed,sort:'desc'},signal,{maxRows:40000,maxPages:16});
   source='alpaca-'+feed;currency='USD';adjustment='raw';volumeUnit='shares';limited=result.limited;
   points=result.rows.map(r=>({t:Date.parse(r.t)/1000,o:r.o,h:r.h,l:r.l,c:r.c,v:r.v}));
  }else{
   // Seven days is a public-source request budget, not an asserted entitlement.
   if(now()-a>7*86400000)throw contextError('INTRADAY_OUTSIDE_PUBLIC_LOOKBACK',422);
   if(!fetchChart)throw contextError('INTRADAY_SOURCE_NOT_CONFIGURED',503);
   data=await fetchChart(q.symbol,'?interval=1m&period1='+Math.floor(a/1000)+'&period2='+Math.ceil(b/1000)+'&includePrePost=true',{signal});
   if(data.meta?.symbol!==q.symbol||data.meta?.dataGranularity!=='1m'||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])throw contextError('SOURCE_IDENTITY_MISMATCH',502);
   source=data.source||'yahoo';currency=data.meta.currency||null;
   volumeUnit=volumeCapability({source,market:marketKeyFor(q.symbol),instrumentType:instrumentTypeFor(q.symbol)}).unit;
   const v=data.indicators.quote[0];
   points=data.timestamp.map((t,i)=>({t,o:v.open?.[i],h:v.high?.[i],l:v.low?.[i],c:v.close?.[i],v:v.volume?.[i]??null}));
  }
  const byTime=new Map();for(const p of points){
   if(!finite(p.t)||p.t*1000<a||p.t*1000>b||!barValid(p,instrumentTypeFor(q.symbol))){rejected++;continue;}
   const old=byTime.get(p.t);if(old&&contentHash(old)!==contentHash(p))throw contextError('SOURCE_BAR_CONFLICT',502);byTime.set(p.t,p);
  }
  return {symbol:q.symbol,points:[...byTime.values()].sort((a,b)=>a.t-b.t),start,end,source,currency,adjustment,volumeUnit,limited,rejected,sourceCheckedAt:now(),mode:'source_ohlcv',feed:source?.startsWith('alpaca')?feed:null};
 }
 async function actions(q,signal){
  const today=localDateAt(now(),timezoneForSymbol(q.symbol)),start=q.actions_start||addDays(today,-366),end=q.actions_end||today;
  if(start>end||dateMs(end)-dateMs(start)>3660*86400000)throw contextError('BAD_CONTEXT_QUERY');
  let events=[],rejected=0,limited=false,source,filterBasis;
  if(configured&&marketKeyFor(q.symbol)==='us'){
   let token=null,pages=0;const tokens=new Set();source='alpaca-corporate-actions';filterBasis='process_date';
   do{
    const data=await request('/v1/corporate-actions',{symbols:q.symbol,types:'forward_split,reverse_split,cash_dividend',start,end,limit:'1000',sort:'asc',...(token?{page_token:token}:{})},signal);
    const normalized=normalizeAlpacaActions(q.symbol,data,{now:now()});events.push(...normalized.events);rejected+=normalized.rejected;if(normalized.events.length+normalized.rejected>1000)throw contextError('SOURCE_BAD_RESPONSE',502);token=nextToken(data.next_page_token);pages++;
    if(token&&(typeof token!=='string'||token.length>8192||tokens.has(token)))throw contextError('SOURCE_CURSOR_INVALID',502);
    if(token)tokens.add(token);if(token&&pages>=4){limited=true;break;}
   }while(token);
  }else{
   if(!fetchActionsChart)throw contextError('ACTIONS_SOURCE_NOT_CONFIGURED',503);
   const data=await fetchActionsChart(q.symbol,'?interval=1d&period1='+Math.floor(localInstant(q.symbol,start)/1000)+'&period2='+Math.floor(localInstant(q.symbol,addDays(end,1))/1000)+'&events=div%2Csplits',{signal});
   if(data.meta?.symbol!==q.symbol||!Array.isArray(data.timestamp))throw contextError('SOURCE_IDENTITY_MISMATCH',502);
   source='yahoo-corporate-actions';filterBasis='ex_date';
   for(const [group,type] of [['splits','split'],['dividends','dividend']])for(const e of Object.values(data.events?.[group]||{})){
    const ex=finite(e.date)?localDateAt(e.date*1000,timezoneForSymbol(q.symbol)):null;
    const ratio=type==='split'&&finite(e.numerator)&&finite(e.denominator)&&e.numerator>0&&e.denominator>0?e.numerator/e.denominator:null;
    const amount=type==='dividend'&&finite(e.amount)&&e.amount>=0?e.amount:null;
    if(!ex||ex<start||ex>end||type==='split'&&ratio===null||type==='dividend'&&amount===null){rejected++;continue;}
    events.push({id:null,type,ex_date:ex,ratio,amount,currency:type==='dividend'?data.meta.currency||null:null,payment_date:null,process_date:null,source,as_of_ms:null,source_checked_at_ms:now(),amount_basis:type==='dividend'?'source_reported_split_basis_unverified':'not_applicable'});
   }
  }
  const semantic=e=>{const {source_checked_at_ms,...value}=e;return contentHash(value);};
  const unique=new Map();for(const e of events){const key=e.id||[e.type,e.ex_date,e.payment_date].join('|');if(unique.has(key)&&semantic(unique.get(key))!==semantic(e))throw contextError('ACTION_CONFLICT',502);unique.set(key,e);}
  return {symbol:q.symbol,source,events:[...unique.values()].sort((a,b)=>a.ex_date.localeCompare(b.ex_date)||a.type.localeCompare(b.type)),start,end,filterBasis,sourceCheckedAt:now(),limited,rejected,
   paidWindowVerified:false,limitations:['Events may be published late or revised. A complete HTTP response does not prove complete payment-date coverage.','Missing currency/payment date is unknown; paid-dividend TTM must not be inferred from ex-dates.']};
 }
 async function movers(q,signal){
  if(q.market!=='us')throw contextError('SOURCE_MARKET_UNSUPPORTED',422);
  const [move,active]=await Promise.all([request('/v1beta1/screener/stocks/movers',{top:String(q.top)},signal),request('/v1beta1/screener/stocks/most-actives',{top:String(q.top),by:'volume'},signal)]);
  if(!Array.isArray(move.gainers)||!Array.isArray(move.losers)||!Array.isArray(active.most_actives))throw contextError('SOURCE_BAD_RESPONSE',502);
  const clean=(list,kind)=>{if(list.length>q.top)throw contextError('SOURCE_BAD_RESPONSE',502);const seen=new Set();return list.map(r=>{
   if(!symbolValid(r?.symbol)||seen.has(r.symbol)||kind==='price'&&![r.price,r.change,r.percent_change].every(finite)||kind==='price'&&r.price<=0||kind==='active'&&(!finite(r.volume)||r.volume<0||!Number.isSafeInteger(r.trade_count)||r.trade_count<0))throw contextError('SOURCE_BAD_RESPONSE',502);seen.add(r.symbol);
   return {symbol:r.symbol,price:number(r.price),change:number(r.change),change_percent:number(r.percent_change),volume:number(r.volume),trade_count:number(r.trade_count)};
  });};
  return {schema_version:1,status:'complete',market:'us',range:'1d',source:'alpaca-sip-screener',source_checked_at_ms:now(),as_of_ms:Date.parse(move.last_updated)||null,active_as_of_ms:Date.parse(active.last_updated)||null,
   coverage:{scope:'provider exchange-tradable universe, not the local watchlist',price_basis:'split-adjusted; latest close compared with previous close',reset:'at market open; before reset shows previous market day',top:q.top},gainers:clean(move.gainers,'price'),losers:clean(move.losers,'price'),active:clean(active.most_actives,'active')};
 }
 const loaders={daily,intraday,actions,movers};
 const cache=new Map();
 const resource=createCachedResource({cache,ttlMs:60000,retryMs:60000,maxEntries:8,now,staleOnError:false,loader:(key,{signal})=>queue.run(async s=>{
  const {op,q}=JSON.parse(key);const result=await loaders[op](q,s);
  if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)throw contextError('RESULT_TOO_LARGE',422);return result;
 },{signal})});
 const get=(op,q,options={})=>{
  const fields={daily:['symbol','daily_bar_count','daily_before','daily_series_id','daily_granularity','adjustment'],intraday:['symbol','intraday_date','intraday_before','intraday_month'],actions:['symbol','actions_start','actions_end'],movers:['market','range','top']}[op];
  const input=Object.fromEntries(fields.filter(k=>q[k]!==undefined).map(k=>[k,q[k]]));
  const key=JSON.stringify({op,q:input});
  if(options.cacheOnly){const entry=cache.get(key);if(!entry)throw contextError('SOURCE_CACHE_MISS',503);if(now()-entry.ts>=60000)return {...entry.data,stale:true};return entry.data;}
  return resource.get(key,options);
 };
 return {daily:(q,o)=>get('daily',q,o),intraday:(q,o)=>get('intraday',q,o),actions:(q,o)=>get('actions',q,o),movers:(q,o)=>get('movers',q,o),
  close(){resource.close();queue.close();},reopen(){resource.reopen();queue.reopen();},
  capabilities:()=>({verified_adjustments:{configured,markets:['us'],modes:['raw','split','split_dividend'],source:'alpaca',feed},intraday:{authenticated:configured,public_lookback_budget_days:7},movers:{configured,market:'us',source:'alpaca-sip-screener'},corporate_actions:{source:configured?'alpaca':'yahoo',payment_coverage:'not guaranteed'}}),
  diagnostics:()=>({cacheEntries:cache.size,cacheMaxEntries:8,maxEntryBytes:2097152,queue:queue.diagnostics()})};
}
