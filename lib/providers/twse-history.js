import {historyError,localDateAt,validDate} from '../history-contract.js';
import {createTaskQueue} from '../task-queue.js';
import {createSharedTasks} from '../shared-task.js';
import {providerRetryAt} from './provider-retry.js';
import {twseListingFor} from './twse-listings.js';

const MAX_MONTHS=12;
const MIN_FIRST_SCREEN_BARS=130;
const MAX_CACHE_MONTHS=36;
const number=value=>{
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(value.trim()))return null;
  const parsed=Number(value.replaceAll(',',''));
  return Number.isFinite(parsed)?parsed:null;
};
const monthOf=date=>date.slice(0,7);
const previousMonth=month=>new Date(Date.parse(month+'-01T00:00:00Z')-86400000).toISOString().slice(0,7);
const dailyStamp=date=>Date.parse(date+'T12:00:00Z')/1000;

export function parseTwseStockDay(payload,symbol,month){
  const listing=twseListingFor(symbol);
  if(!listing)throw historyError('HISTORY_UNSUPPORTED','未确认的 TWSE 上市证券',422);
  // Official empty months omit identity/columns altogether. Recognize only
  // this verified response; invalid dates, throttling and malformed data fail.
  if(payload?.stat==='很抱歉，沒有符合條件的資料!'&&payload.total===0&&validDate(month+'-01')&&
     Object.keys(payload).every(key=>key==='stat'||key==='total'))return [];
  if(payload?.stat!=='OK'||!Array.isArray(payload.data)||!Array.isArray(payload.fields))
    throw historyError('HISTORY_BAD_RESPONSE','TWSE 日线响应不完整',502);
  const title=String(payload.title||'');
  const titleIdentity=new RegExp('^\\s*(\\d{2,3})年(\\d{1,2})月\\s+'+listing.code+'(?:\\s|$)').exec(title);
  if(!titleIdentity||Number(titleIdentity[1])+1911!==Number(month.slice(0,4))||Number(titleIdentity[2])!==Number(month.slice(5,7))||
     !/^\d{8}$/.test(String(payload.date||''))||payload.date.slice(0,6)!==month.replace('-',''))
    throw historyError('HISTORY_IDENTITY_CONFLICT','TWSE 日线证券或月份不匹配',422);
  const field=name=>payload.fields.indexOf(name);
  const columns=['日期','開盤價','最高價','最低價','收盤價'];
  if(columns.some(name=>field(name)<0))throw historyError('HISTORY_BAD_RESPONSE','TWSE 日线缺少 OHLC 栏位',502);
  const bars=[];
  for(const row of payload.data){
    if(!Array.isArray(row))continue;
    const match=/^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(row[field('日期')]||''));
    if(!match)continue;
    const date=`${Number(match[1])+1911}-${match[2]}-${match[3]}`;
    if(!validDate(date)||monthOf(date)!==month)continue;
    const [o,h,l,c]=columns.slice(1).map(name=>number(row[field(name)]));
    // '-' is missing, not zero. The change column may contain X0.00 when
    // a price is not comparable; OHLC is read from its own columns only.
    if(![o,h,l,c].every(value=>value>0)||h<Math.max(o,c)||l>Math.min(o,c))continue;
    bars.push({date,t:dailyStamp(date),o,h,l,c,sourceVolume:number(row[field('成交股數')])});
  }
  const unique=new Map();
  for(const bar of bars){
    const old=unique.get(bar.date);
    if(old&&JSON.stringify(old)!==JSON.stringify(bar))throw historyError('HISTORY_CONFLICT','TWSE 同一交易日资料冲突',422);
    unique.set(bar.date,bar);
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

export function createTwseHistory({httpsGet,now=Date.now,maxMonths=MAX_MONTHS,minBars=MIN_FIRST_SCREEN_BARS}={}){
  const cache=new Map(),shared=createSharedTasks(),queue=createTaskQueue({maxActive:2,maxQueued:4,now});
  let closed=false;
  const stopped=()=>historyError('STOPPED','TWSE history stopped',503);
  async function monthRows(symbol,month,{signal}={}){
    if(closed)throw stopped();
    signal?.throwIfAborted();
    const listing=twseListingFor(symbol);
    if(!listing)throw historyError('HISTORY_UNSUPPORTED','未确认的 TWSE 上市证券',422);
    const key=symbol+':'+month,old=cache.get(key);
    if(old?.until>now()){if(old.error)throw old.error;return old.rows;}
    return shared.run(key,taskSignal=>queue.run(async queueSignal=>{
      const date=month.replace('-','')+'01';
      const url=`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${listing.code}`;
      const response=await httpsGet(url,{Accept:'application/json',Referer:'https://www.twse.com.tw/'},{timeout:4000,signal:queueSignal});
      queueSignal.throwIfAborted();
      if(response?.status!==200){
        const status=response?.status||503;
        throw Object.assign(historyError(status===429?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE',`TWSE 日线 HTTP ${status}`,status===429?429:503),
          {status,retryAt:providerRetryAt(response?.headers,now(),status===429?60000:30000)});
      }
      let payload;
      try{payload=JSON.parse(response.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','TWSE 日线不是 JSON',502);}
      const rows=parseTwseStockDay(payload,symbol,month);
      const current=month===monthOf(localDateAt(now(),'Asia/Taipei'));
      cache.delete(key);cache.set(key,{rows,until:now()+(current?300000:86400000)});
      while(cache.size>MAX_CACHE_MONTHS)cache.delete(cache.keys().next().value);
      return rows;
    },{signal:taskSignal}).catch(error=>{
      if(!taskSignal.aborted&&error.code!=='STOPPED'){
        cache.delete(key);cache.set(key,{error,until:Math.max(now()+30000,Number(error.retryAt)||0)});
        while(cache.size>MAX_CACHE_MONTHS)cache.delete(cache.keys().next().value);
      }
      throw error;
    }),{signal});
  }
  async function quoteContext(symbol,date,{signal}={}){
    if(!validDate(date)||!twseListingFor(symbol))return {previous:null,bars:[]};
    const month=monthOf(date),recent=(await monthRows(symbol,month,{signal})).filter(row=>row.date<=date);
    let bars=recent;
    if(recent.filter(row=>row.date<date).length===0){
      try{bars=[...(await monthRows(symbol,previousMonth(month),{signal})),...recent];}
      catch(error){if(signal?.aborted)throw error;}
    }
    return {previous:bars.filter(row=>row.date<date).at(-1)||null,bars};
  }
  const fetch=async(symbol,query,options={})=>{
    if(closed)throw stopped();
    if(!twseListingFor(symbol))throw historyError('HISTORY_UNSUPPORTED','未确认的 TWSE 上市证券',422);
    const params=new URLSearchParams(query),interval=params.get('interval')||'1d';
    if(interval!=='1d')throw historyError('HISTORY_UNSUPPORTED','TWSE 尚无经核验的分钟历史',422);
    const endNumber=Number(params.get('period2')),startNumber=Number(params.get('period1'));
    const today=localDateAt(now(),'Asia/Taipei');
    const pageBefore=options.pageBefore??null;
    if(pageBefore!==null&&!validDate(pageBefore))throw historyError('BAD_HISTORY_QUERY','TWSE 历史翻页日期无效',400);
    const queriedThrough=Number.isFinite(endNumber)&&endNumber>0?localDateAt(Math.min(now(),endNumber*1000-1000),'Asia/Taipei'):today;
    const exclusiveThrough=pageBefore?new Date(Date.parse(pageBefore+'T00:00:00Z')-86400000).toISOString().slice(0,10):null;
    const through=exclusiveThrough&&exclusiveThrough<queriedThrough?exclusiveThrough:queriedThrough;
    const from=Number.isFinite(startNumber)&&startNumber>0?new Date(startNumber*1000).toISOString().slice(0,10):'1900-01-01';
    if(from>through)throw historyError('HISTORY_EMPTY','TWSE 翻页范围内没有交易日',502);
    const requested=Number(options.requestedCount),rowsPerPeriod={daily:1,weekly:5,monthly:21,yearly:252}[options.requestedPeriod]||1;
    const targetBars=Number.isInteger(requested)&&requested>0?Math.min(maxMonths*23,Math.max(minBars,requested*rowsPerPeriod+22)):
      Math.min(maxMonths*23,Math.max(minBars,Math.ceil((Date.parse(through+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000*0.68)));
    let month=monthOf(through),rows=[],pages=0,oldestMonthRead=null,partialError=null;
    const deadline=performance.now()+Math.min(10000,Math.max(1000,Number(options.deadlineMs)||10000));
    while(month>=monthOf(from)&&pages<maxMonths&&performance.now()<deadline){
      options.signal?.throwIfAborted();
      let monthly;
      try{monthly=await monthRows(symbol,month,options);}catch(error){if(!rows.length)throw error;partialError=error;break;}
      rows=[...monthly.filter(row=>row.date>=from&&row.date<=through),...rows];pages++;
      oldestMonthRead=month;
      if(rows.length>=targetBars)break;
      month=previousMonth(month);
    }
    if(!rows.length)throw historyError('HISTORY_EMPTY','TWSE 未返回可用日线',502);
    const oldest=rows[0].date,retrievalLimited=oldestMonthRead>monthOf(from);
    const latest=rows.at(-1);
    const hasMore=partialError?null:retrievalLimited;
    const stopReason=partialError?'source-error':!retrievalLimited?'requested-window-covered':pages>=maxMonths?'month-page-budget':performance.now()>=deadline?'time-budget':'first-screen-target';
    return {source:'twse-stock-day',retrievalLimited,hasMore,
      coverage:{requestedFrom:from,pageBefore,windowThrough:through,firstTradingDate:oldest,lastTradingDate:latest.date,pages,hasMore,stopReason,
        scope:'TWSE monthly STOCK_DAY; close and volume include source-defined sessions'},
      meta:{symbol,currency:'TWD',sourceCurrency:'TWD',priceScale:1,exchangeName:'TWSE',exchangeTimezoneName:'Asia/Taipei',gmtoffset:28800,
        instrumentType:twseListingFor(symbol).instrumentType,dataGranularity:'1d',sourceDailyClose:latest.c,
        sourceVolumeUnit:'shares',sourceVolumeCoverage:'ordinary, odd-lot, after-hours fixed-price and block trades; excludes auction/tender; not regular-only',
        adjustmentStatus:'source-unverified'},
      timestamp:rows.map(row=>row.t),indicators:{quote:[{open:rows.map(row=>row.o),high:rows.map(row=>row.h),low:rows.map(row=>row.l),close:rows.map(row=>row.c),volume:rows.map(()=>null)}]}};
  };
  fetch.supports=symbol=>!!twseListingFor(symbol);
  fetch.quoteContext=quoteContext;
  fetch.close=()=>{closed=true;shared.close(stopped());queue.close();cache.clear();};
  fetch.reopen=()=>{closed=false;queue.reopen();};
  fetch.diagnostics=()=>({cachedMonths:cache.size,inflight:shared.size(),queue:queue.diagnostics()});
  return fetch;
}
