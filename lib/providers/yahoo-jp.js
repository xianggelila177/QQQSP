import {historyError,localDateAt,validDate,addDays} from '../history-contract.js';
import {createSharedTasks} from '../shared-task.js';
import {createTaskQueue} from '../task-queue.js';
import {tradingDayInfo} from '../market-calendar-api.js';
import {marketStateFor} from '../../mkt.mjs';
import {instrumentTypeFor} from '../instruments.js';
import {publishQuote} from '../quote-contract.js';
import {providerRetryAt} from './provider-retry.js';

const ZONE='Asia/Tokyo',DAY=86400000;
const supports=symbol=>/^\d[A-Z0-9]{3}\.T$/.test(symbol);
const number=value=>typeof value==='string'&&/^[+-]?[\d,]+(?:\.\d+)?$/.test(value)?Number(value.replaceAll(',','')):null;
const failure=(code='HISTORY_BAD_RESPONSE')=>historyError(code,'Yahoo 日本站数据暂不可用',503);

// Next.js Flight embeds JSON strings. Decode data only; never evaluate scripts
// or retain the page's unrelated tokens, account fields, or executable content.
export function parseYahooJapanPage(html,symbol){
 if(!supports(symbol)||typeof html!=='string'||Buffer.byteLength(html)>2*1024*1024)throw failure();
 const chunks=[];
 for(const match of html.matchAll(/self\.__next_f\.push\((\[1,.*?\])\)<\/script>/g)){
  try{const data=JSON.parse(match[1]);if(typeof data[1]==='string')chunks.push(data[1]);}catch{}
 }
 const candidates=[];let visited=0;
 const visit=(value,depth=0)=>{
  if(++visited>50000||depth>40||!value||typeof value!=='object')return;
  if(value.priceBoard&&value.pageInfo){
   if(value.pageInfo.code===symbol)candidates.push({board:value.priceBoard.board,history:value.history});return;
  }
  for(const child of Object.values(value))visit(child,depth+1);
 };
 for(const line of chunks.join('').split('\n')){try{visit(JSON.parse(line.slice(line.indexOf(':')+1)));}catch{}}
 if(candidates.length!==1)throw failure('HISTORY_IDENTITY_CONFLICT');
 const {board,history}=candidates[0];
 if(board?.codeWithMarketExtension!==symbol||board.code!==symbol.slice(0,-2)||
   !/^T[0-9A-Z]*$/.test(board.marketDetailCode||'')||!['STOCK','ETF','REIT'].includes(board.stockType)||
   history?.isApiError||history?.filtered?.timeFrameId!=='d'||!Array.isArray(history.history?.histories))throw failure('HISTORY_IDENTITY_CONFLICT');
 const rows=[],corporateActions=[];
 for(const row of history.history.histories){
  // Split announcements are separate table rows, without prices. Preserve
  // the annotation; never turn it into a candle or adjust prices ourselves.
  if(validDate(row.date)&&row.values==null&&typeof row.splitText==='string'){
   corporateActions.push({date:row.date,note:row.splitText.slice(0,200)});continue;
  }
  if(!validDate(row.date)||!Array.isArray(row.values))throw failure();
  const [o,h,l,c,v]=row.values.slice(0,5).map(item=>number(item.value));
  if(![o,h,l,c].every(n=>Number.isFinite(n)&&n>0)||h<Math.max(o,c)||l>Math.min(o,c)||v!=null&&v<0)throw failure();
  rows.push({date:row.date,o,h,l,c,v});
 }
 if(rows.some((row,i)=>i&&row.date>=rows[i-1].date))throw failure('HISTORY_CONFLICT');
 return {board:{symbol,code:board.code,name:board.name,type:board.stockType,price:number(board.price?.value),
   change:number(board.priceChange?.value),time:board.japanUpdateTime,delay:board.delayMinutes},
  rows,corporateActions,hasNext:history.pager?.hasNext===true,page:history.pager?.page};
}

export function yahooJapanQuote(page,symbol,checkedAt){
 const b=page.board,today=localDateAt(checkedAt,ZONE),latest=page.rows[0];
 if(b.symbol!==symbol||!(b.price>0))throw failure('QUOTE_BAD_RESPONSE');
 let date,at,precision,basis;
 if(/^\d{1,2}:\d{2}$/.test(b.time||'')){
  date=today;at=Date.parse(date+'T'+b.time.padStart(5,'0')+':00+09:00');precision='minute';basis='provider-published';
 }else{
  const match=/^(\d{1,2})\/(\d{1,2})$/.exec(b.time||'');
  if(!match||!latest||Number(latest.date.slice(5,7))!==+match[1]||Number(latest.date.slice(8))!==+match[2]||latest.c!==b.price)throw failure('QUOTE_TIME_UNVERIFIED');
  date=latest.date;const day=tradingDayInfo(symbol,date);
  if(!day.known||!day.is_open)throw failure('QUOTE_TIME_UNVERIFIED');
  at=day.regular_sessions.at(-1)?.close_at_ms;precision='date';basis='exchange-session-close';
 }
 if(!Number.isFinite(at)||at>checkedAt||date>today||checkedAt-at>10*DAY)throw failure('QUOTE_TIME_UNVERIFIED');
 const row=latest?.date===date?latest:null,prev=b.change!=null?b.price-b.change:null;
 const type=instrumentTypeFor(symbol,b.type==='ETF'?'ETF':b.type==='REIT'?'REIT':'EQUITY');
 return publishQuote({symbol,price:b.price,quoteAt:at,ts:at,regularPrice:b.price,regularMarketPrice:b.price,regularQuoteAt:at,
  priceSession:'REGULAR',quoteTimePrecision:precision,quoteTimeBasis:basis,priceBasis:'website-last-price',
  currency:'JPY',sourceCurrency:'JPY',priceScale:1,gmtoff:32400,exchangeName:'Tokyo Stock Exchange',market:'日股',
  instrumentType:type,instrumentTypeSource:'provider',name:b.name,displayName:b.name,
  prevClose:prev,providerPrevClose:prev,regularPreviousClose:prev,regularPreviousCloseQuoteAt:at,
  change:b.change,changePct:prev>0?b.change/prev*100:null,
  open:row?.o??null,dayHigh:row?.h??null,dayLow:row?.l??null,volume:row?.v??null,volumeUnit:'shares',
  ohlcSession:'REGULAR',ohlcConsistent:!!row&&row.l<=b.price&&b.price<=row.h,
  marketState:marketStateFor(symbol,null,checkedAt),src:'yahoo-jp',sourceCheckedAt:checkedAt,fetchedAt:checkedAt,
  feedDelayMinutes:Number.isFinite(b.delay)?b.delay:null,feedDelaySource:'yahoo-jp-displayed',
  isDelayed:Number.isFinite(b.delay)?b.delay>0:null,pollAfterMs:60000,ext:null});
}

export function createYahooJapan({httpsGet,now=Date.now,maxEntries=32}={}){
 const cache=new Map(),shared=createSharedTasks(),queue=createTaskQueue({maxActive:2,maxQueued:16,now});let closed=false,generation=0;
 const stopped=()=>failure('STOPPED');
 async function readPage(symbol,params='',{signal,priority}={}){
  if(closed)throw stopped();signal?.throwIfAborted();
  if(!supports(symbol))throw failure('HISTORY_UNSUPPORTED');
  const key=symbol+':'+params,old=cache.get(key),owner=generation;
  if(old?.until>now()){if(old.error)throw old.error;return old.value;}
  return shared.run(key,taskSignal=>queue.run(async queueSignal=>{
   try{
    const r=await httpsGet('https://finance.yahoo.co.jp/quote/'+encodeURIComponent(symbol)+'/history'+params,
     {Accept:'text/html'},{signal:queueSignal,priority,timeout:6000});queueSignal.throwIfAborted();
    if(r?.status!==200)throw Object.assign(failure('HISTORY_SOURCE_UNAVAILABLE'),{status:r?.status,retryAt:providerRetryAt(r?.headers,now(),60000)});
    const value={...parseYahooJapanPage(r.body,symbol),checkedAt:now()};
    if(closed||owner!==generation)throw stopped();
    cache.set(key,{value,until:value.checkedAt+(params?300000:60000)});return value;
   }catch(error){
    if(!queueSignal.aborted&&!closed&&owner===generation&&error.code!=='STOPPED')cache.set(key,{error,until:Math.max(now()+60000,error.retryAt||0)});
    throw error;
   }finally{while(cache.size>maxEntries)cache.delete(cache.keys().next().value);}
  },{signal:taskSignal,priority}),{signal});
 }
 const fetchHistory=async(symbol,query,options={})=>{
  if(!fetchHistory.supports(symbol,query))throw failure('HISTORY_UNSUPPORTED');
  const p=new URLSearchParams(query),today=localDateAt(now(),ZONE);
  const from=p.has('period1')?new Date(Number(p.get('period1'))*1000).toISOString().slice(0,10):addDays(today,-732);
  let through=p.has('period2')?new Date(Number(p.get('period2'))*1000-1).toISOString().slice(0,10):today;
  through=[through,today,...(options.pageBefore?[addDays(options.pageBefore,-1)]:[])].sort()[0];
  const rows=new Map(),corporateActions=[];let page,checkedAt=Infinity;
  const maxPages=Math.max(1,Math.min(3,Math.ceil((Number(options.requestedCount)||60)/20)));
  for(let index=1;index<=maxPages;index++){
   const params=new URLSearchParams({from:from.replaceAll('-',''),to:through.replaceAll('-',''),timeFrame:'d',page:String(index)});
   page=await readPage(symbol,'?'+params,options);checkedAt=Math.min(checkedAt,page.checkedAt);
   corporateActions.push(...page.corporateActions);
   if(page.page!==index)throw failure('HISTORY_RANGE_CONFLICT');
   for(const row of page.rows){
    if(row.date<from||row.date>through)throw failure('HISTORY_RANGE_CONFLICT');
    const old=rows.get(row.date);if(old&&JSON.stringify(old)!==JSON.stringify(row))throw failure('HISTORY_CONFLICT');rows.set(row.date,row);
   }
   if(!page.hasNext)break;
  }
  const bars=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(!bars.length)throw Object.assign(failure('HISTORY_EMPTY'),{emptyRange:true});
  const hasMore=page.hasNext,kind=instrumentTypeFor(symbol,page.board.type==='ETF'?'ETF':page.board.type==='REIT'?'REIT':'EQUITY');
  return {source:'yahoo-jp-daily',retrievalLimited:hasMore,hasMore,requestedFrom:from,retrievedFrom:bars[0].date,
   sourceCheckedAt:checkedAt,sourceFreshUntil:checkedAt+300000,sourceTimeBasis:'provider-http-checked',adjustment:'source-default-unverified',
   coverage:{status:'unknown',firstTradingDate:bars[0].date,lastTradingDate:bars.at(-1).date,stopReason:hasMore?'page-budget':'requested-window-covered',originProven:false,corporateActions},
   meta:{symbol,currency:'JPY',sourceCurrency:'JPY',priceScale:1,exchangeName:'TOKYO',exchangeTimezoneName:ZONE,
    instrumentType:kind,instrumentTypeSource:'yahoo-jp-page',dataGranularity:'1d',chartTimeBasis:'exchange-session-date',
    sourceVolumeUnit:'source-unit-unverified',adjustmentStatus:'source-unverified'},
   sourceVolumes:bars.map(b=>({sessionDate:b.date,value:b.v})),timestamp:bars.map(b=>Date.parse(b.date+'T12:00:00Z')/1000),
   indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(()=>null)}]}};
 };
 fetchHistory.supports=(symbol,query='')=>supports(symbol)&&new URLSearchParams(query).get('interval')==='1d';
 fetchHistory.close=()=>{closed=true;generation++;shared.close(stopped());queue.close();cache.clear();};
 fetchHistory.reopen=()=>{closed=false;queue.reopen();};
 return {supports,getQuote:async(symbol,options)=>{const page=await readPage(symbol,'',options);return yahooJapanQuote(page,symbol,page.checkedAt);},fetchHistory};
}
