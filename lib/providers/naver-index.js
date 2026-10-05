import {providerRetryAt} from './provider-retry.js';
import {publishQuote} from '../quote-contract.js';
import {marketStateFor,marketCalendarCoverage,timezoneOffsetFor} from '../../mkt.mjs';
import {localDateAt} from '../history-contract.js';
import {indexPublicationSession} from '../session-policy.js';
import {regularChartTarget} from '../regular-chart-service.js';
import {localInstant} from '../market-calendar-api.js';
import {parseNaverWorldCandles} from './naver-world-history.js';

// Verified cash index identity, not an ETF or futures proxy. Keep this route
// bounded until other provider identifiers and units have been verified.
const indexes=Object.freeze({
 '^IXIC':{code:'.IXIC',symbolCode:'IXIC',exchange:'NSQ',providerZone:'EST5EDT',zone:'America/New_York',nation:'USA',chartExchange:'NASDAQ',currency:'USD',name:'纳斯达克综合指数',english:'NASDAQ Composite',market:'美股指数',exchangeName:'NASDAQ',pollMs:7000,minuteCandles:true},
 '^NDX':{code:'.NDX',symbolCode:'NDX',exchange:'NSQ',providerZone:'EST5EDT',zone:'America/New_York',nation:'USA',chartExchange:'NASDAQ',currency:'USD',name:'纳斯达克100指数',english:'NASDAQ 100',market:'美股指数',exchangeName:'NASDAQ',pollMs:7000,minuteCandles:true},
 '^N225':{code:'.N225',symbolCode:'N225',exchange:'TYO',providerZone:'Asia/Tokyo',zone:'Asia/Tokyo',nation:'JPN',chartExchange:'TOKYO',currency:'JPY',name:'日经225',english:'Nikkei 225',market:'日股指数',exchangeName:'Tokyo Stock Exchange',pollMs:70000},
 '^SOX':{code:'.SOX',symbolCode:'SOX',exchange:'NSQ',providerZone:'EST5EDT',zone:'America/New_York',nation:'USA',chartExchange:'NASDAQ',currency:'USD',name:'费城半导体指数',english:'PHLX Semiconductor Index',market:'美股指数',exchangeName:'NASDAQ',pollMs:7000,minuteCandles:true},
 '^GSPC':{code:'.INX',symbolCode:'SPX',exchange:'NYS',providerZone:'EST5EDT',zone:'America/New_York',nation:'USA',chartExchange:'NYSE',currency:'USD',name:'标普500指数',english:'S&P 500',market:'美股指数',exchangeName:'New York Stock Exchange',pollMs:7000}
});
const supported=symbol=>Object.hasOwn(indexes,symbol);
const invalid=message=>Object.assign(new Error('Naver index '+message),{code:'SOURCE_BAD_RESPONSE'});
const number=value=>value==null||String(value).trim()===''?null:
  Number.isFinite(Number(String(value).replaceAll(',','')))?Number(String(value).replaceAll(',','')):null;
function identity(row,symbol,{basic=false}={}) {
  const spec=indexes[symbol];if(!spec)throw invalid('unsupported symbol');
  const exchange=row?.stockExchangeType;
  if(row?.reutersCode!==spec.code||(basic?row.indexType?.symbolCode:row.symbolCode)!==spec.symbolCode||
     exchange?.code!==spec.exchange||exchange.zoneId!==spec.providerZone||exchange.nationCode!==spec.nation||
     basic&&(row.stockEndType!=='index'||(spec.currency==='JPY'||row.indexType?.currencyType!=null)&&row.indexType?.currencyType?.code!==spec.currency))throw invalid('identity mismatch');
}
function exchangeTime(raw,symbol,{daily=false}={}) {
  const digits=String(raw||'');
  if(!new RegExp(daily?'^\\d{8}$':'^\\d{14}$').test(digits))throw invalid('invalid time');
  const wall=digits.slice(0,4)+'-'+digits.slice(4,6)+'-'+digits.slice(6,8)+'T'+
    (daily?'09:00:00':digits.slice(8,10)+':'+digits.slice(10,12)+':'+digits.slice(12,14));
  const naive=Date.parse(wall+'Z');
  if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,19)!==wall)throw invalid('invalid time');
  let at=naive;
  for(let i=0;i<3;i++)at=naive-timezoneOffsetFor(symbol,at)*1000;
  if(new Date(at+timezoneOffsetFor(symbol,at)*1000).toISOString().slice(0,19)!==wall)throw invalid('invalid time');
  return at;
}
function quoteTime(raw,symbol,now) {
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(raw||''))throw invalid('invalid quote time');
  const at=exchangeTime(raw.slice(0,19).replace(/[-:T]/g,''),symbol);
  if(Date.parse(raw)!==at)throw invalid('quote time zone mismatch');
  if(at>now+5000||at<now-14*86400000)throw invalid('stale or future quote time');
  return at;
}
export function parseNaverIndexQuote(row,symbol,{now=Date.now(),pollAfterMs=70000}={}) {
  if(!supported(symbol))throw invalid('unsupported symbol');
  identity(row,symbol);const spec=indexes[symbol];
  const price=number(row.closePrice),quoteAt=quoteTime(row.localTradedAt,symbol,now);
  if(!(price>0))throw invalid('invalid quote');
  let change=number(row.compareToPreviousClosePriceRaw??row.compareToPreviousClosePrice);
  if(row.compareToPreviousPrice?.name==='FALLING'&&change!=null)change=-Math.abs(change);
  const prevClose=change==null?null:price-change;
  if(prevClose!=null&&!(prevClose>0))throw invalid('invalid previous close');
  const open=number(row.openPrice),dayHigh=number(row.highPrice),dayLow=number(row.lowPrice);
  const delay=number(row.stockExchangeType.delayTime);
  if(delay==null||delay<0||delay>1440)throw invalid('missing delay');
  const publicationSession=indexPublicationSession(symbol,now);
  return publishQuote({symbol,price,quoteAt,ts:quoteAt,sourceCheckedAt:now,fetchedAt:now,
    // localTradedAt is the provider's published index timestamp. In particular,
    // a delayed closing publication must not be relabeled as an after-hours trade.
    quoteTimeBasis:'provider-published',priceSession:'REGULAR',regularMarketPrice:price,regularPrice:price,regularQuoteAt:quoteAt,
    prevClose,change,changePct:prevClose?change/prevClose*100:null,open,dayHigh,dayLow,
    currency:spec.currency,currency2cny:null,fxMap:null,fxAsOf:null,fxStale:false,
    volume:null,turnoverAmount:null,volumeUnit:null,ext:null,week52High:null,week52Low:null,
    instrumentType:'INDEX',instrumentTypeSource:'provider',displayName:spec.name,name:spec.english,exchangeName:spec.exchangeName,market:spec.market,
    marketState:marketStateFor(symbol,null,now),providerMarketState:row.marketStatus,gmtoff:timezoneOffsetFor(symbol,now),calendarCoverage:marketCalendarCoverage(symbol,now),
    ...(publicationSession?{publicationSession}:{}),
    ohlcSession:'REGULAR',ohlcConsistent:dayLow>0&&dayHigh>=price&&dayLow<=price,
    src:'naver-index',feedDelayMinutes:delay,pollAfterMs,checkIntervalMs:pollAfterMs});
}
export function parseNaverIndexHistory(data,symbol,{minute=false,now=Date.now(),identity:basic}={}) {
  if(!supported(symbol))throw invalid('unsupported symbol');
  const spec=indexes[symbol];
  if(minute){
    if(data?.code!==spec.code||data.infoType!=='index'||data.periodType!=='day'||data.stockExchangeType!==spec.chartExchange)throw invalid('history identity mismatch');
  }else identity(basic,symbol,{basic:true});
  const rows=minute?data.priceInfos:data;
  if(!Array.isArray(rows)||rows.length>20000)throw invalid('invalid history rows');
  const unique=new Map(),rejectedDates=new Map();let rejectedRows=0;
  for(const row of rows){
    const at=exchangeTime(minute?row.localDateTime:row.localDate,symbol,{daily:!minute});
    if(at>now)continue;
    const c=number(minute?row.currentPrice:row.closePrice);
    const o=minute?null:number(row.openPrice),h=minute?null:number(row.highPrice),l=minute?null:number(row.lowPrice);
    if(!(c>0)||!minute&&(![o,h,l].every(n=>n>0)||h<Math.max(o,c)||l>Math.min(o,c))){
      if(minute)throw invalid('invalid history OHLC');
      // A source error on one old date must not discard decades of valid bars.
      // Never invent a replacement high/low; preserve the omitted date so the
      // corresponding aggregate remains explicitly partial, including on cache reads.
      rejectedDates.set(at,localDateAt(at,spec.zone));rejectedRows++;continue;
    }
    unique.set(at,{t:at/1000,c,o,h,l});
  }
  for(const at of rejectedDates.keys())unique.delete(at);
  const bars=[...unique.values()].sort((a,b)=>a.t-b.t);
  if(!bars.length)throw invalid('empty history');
  return {source:'naver-index-history',retrievalLimited:true,
    ...(rejectedRows?{historyQuality:{status:'partial',missingTradingDates:[...rejectedDates.values()].sort(),rejectedRows,reason:'source-invalid-ohlc'}}:{}),
    meta:{symbol,currency:spec.currency,instrumentType:'INDEX',exchangeName:spec.exchange,exchangeTimezoneName:spec.zone,gmtoffset:timezoneOffsetFor(symbol,now),dataGranularity:minute?'1m':'1d',...(minute?{chartTimeBasis:'price-point',chartIntervalSeconds:60}:{}),chartPreviousClose:minute?number(data.lastClosePrice):null},
    timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(()=>null)}]}};
}
export function parseNaverIndexCandles(data,symbol,resolution,{now=Date.now()}={}) {
  const spec=indexes[symbol];
  if(!spec?.minuteCandles||![1,5].includes(resolution))throw invalid('unsupported candle interval');
  if(data?.infoType!=='index'||data.zoneId!==spec.providerZone||data.timeFrame!==(resolution===1?'minute':'minute5'))
    throw invalid('candle time contract mismatch');
  if(!Array.isArray(data.candleList)||data.candleList.length>20000)throw invalid('invalid candle rows');
  for(const row of data.candleList){
    const raw=row?.tradeAt,at=Date.parse(raw);
    if(typeof raw!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z$/.test(raw)||
      !Number.isFinite(at)||new Date(at).toISOString().slice(0,16)!==raw.slice(0,16)||at%(resolution*60000)!==0)
      throw invalid('candle timestamp mismatch');
    if(row.reutersCode!==spec.code||row.stockExchangeType!==spec.chartExchange)throw invalid('candle identity mismatch');
  }
  // The same foreign-chart endpoint uses UTC interval-start timestamps for
  // stocks and indexes. Index volume units are not verified as share counts.
  return parseNaverWorldCandles(data,symbol,spec.code,spec.chartExchange,resolution,{now}).map(bar=>({...bar,v:null}));
}
export function createNaverIndexProvider({httpsGet,now=Date.now}={}) {
  const cache=new Map(),jobs=new Map(),controllers=new Set();
  let stopped=false,generation=0;
  const stoppedError=()=>Object.assign(new Error('Index provider stopped'),{code:'STOPPED'});
  async function read(key,url,ttl,parse,signal,priority) {
    if(stopped)throw stoppedError();
    signal?.throwIfAborted();
    const old=cache.get(key);
    if(old?.until>now()){if(old.error)throw old.error;return old.value;}
    // Each request caller can abort its wait without canceling another consumer.
    if(!jobs.has(key)){
      const controller=new AbortController(),epoch=generation;
      controllers.add(controller);
      const job=Promise.resolve().then(async()=>{
        const timeout=setTimeout(()=>controller.abort(),6000);
        try{
          const response=await httpsGet(url,{Referer:'https://m.stock.naver.com/'},{timeout:6000,signal:controller.signal,priority});
          if(stopped||epoch!==generation)throw stoppedError();
          if(response.status!==200)throw Object.assign(new Error('Naver index HTTP '+response.status),{status:response.status,code:response.status===429?'RATE_LIMITED':'SOURCE_UNAVAILABLE',retryAt:providerRetryAt(response.headers,now())});
          const value=parse(JSON.parse(response.body)),checkedAt=now(),until=checkedAt+(typeof ttl==='function'?ttl(value):ttl);
          if(value&&typeof value==='object')Object.defineProperties(value,{sourceCheckedAt:{value:checkedAt,enumerable:!Array.isArray(value),configurable:true},sourceFreshUntil:{value:until,enumerable:!Array.isArray(value),configurable:true}});
          cache.set(key,{value,until});return value;
        }catch(error){
          if(stopped||epoch!==generation)throw stoppedError();
          error.retryAt=Math.max(now()+60000,Number(error.retryAt)||0);
          cache.set(key,{error,until:error.retryAt});throw error;
        }finally{clearTimeout(timeout);controllers.delete(controller);if(jobs.get(key)===job)jobs.delete(key);while(cache.size>32)cache.delete(cache.keys().next().value);}
      });jobs.set(key,job);
    }
    const job=jobs.get(key);
    if(!signal)return job;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason||new Error('Aborted'));
      signal.addEventListener('abort',abort,{once:true});
      job.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      if(signal.aborted)abort();
    });
  }
  async function minuteCandles(symbol,params,options) {
    const spec=indexes[symbol],interval=params.get('interval'),resolution=Number(interval?.slice(0,-1));
    if(!['1m','5m'].includes(interval))throw invalid('unsupported candle interval');
    const day=86400,stamp=at=>new Date(at*1000).toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
    const requested=field=>params.has(field)?Number(params.get(field)):null;
    let start=requested('period1'),end=requested('period2');
    if(params.has('period1')&&!(Number.isSafeInteger(start)&&start>0)||params.has('period2')&&!(Number.isSafeInteger(end)&&end>0))
      throw invalid('invalid candle range');
    if(!params.has('period1')&&!params.has('period2')&&(params.get('range')||'1d')==='1d'){
      const target=regularChartTarget(symbol,now());
      if(target.status!=='ready')throw invalid('unknown candle session');
      start=localInstant(symbol,target.targetDate,0)/1000;
      end=localInstant(symbol,target.targetDate,1440)/1000;
    }
    end=Math.min(end||Math.floor(now()/60000)*60,Math.floor(now()/1000));
    if(start==null){
      const days=/^([1-8])d$/.exec(params.get('range')||'1d')?.[1];
      if(!days)throw invalid('unsupported candle range');
      start=end-Number(days)*day;
    }
    if(start>=end||end-start>8*day)throw invalid('invalid candle range');
    const rows=new Map(),checks=[],freshUntil=[];
    for(let from=start;from<end;from+=2*day){
      options.signal?.throwIfAborted();
      const to=Math.min(end,from+2*day),key=[symbol,'candles',resolution,from,to].join(':');
      const url=`https://api.stock.naver.com/chart/foreign/INDEX/${spec.chartExchange}/${spec.code}/interval/${resolution}?`+
        new URLSearchParams({startDateTime:stamp(from),endDateTime:stamp(to)});
      const bars=await read(key,url,60000,data=>parseNaverIndexCandles(data,symbol,resolution,{now:now()}),options.signal,options.priority);
      checks.push(bars.sourceCheckedAt);freshUntil.push(bars.sourceFreshUntil);
      // The provider may repeat a shortened end candle or an earlier row.
      // Only the page owning [from,to) can supply that interval's full OHLC.
      for(const bar of bars)if(bar.t>=from&&bar.t<to)rows.set(bar.t,bar);
    }
    const bars=[...rows.values()].sort((a,b)=>a.t-b.t);
    if(!bars.length)throw invalid('empty history');
    return {source:'naver-index-candles',retrievalLimited:true,sourceCheckedAt:Math.min(...checks),sourceFreshUntil:Math.min(...freshUntil),
      meta:{symbol,currency:spec.currency,instrumentType:'INDEX',exchangeName:spec.exchange,exchangeTimezoneName:spec.zone,
        dataGranularity:interval,chartTimeBasis:'bar-start',chartIntervalSeconds:resolution*60,
        regularMarketPrice:bars.at(-1).c,regularMarketTime:bars.at(-1).t},
      timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(()=>null)}]}};
  }
  async function fetchChart(symbol,query,options={}) {
    if(!supported(symbol))throw invalid('unsupported symbol');
    const spec=indexes[symbol],key=symbol+':',date=ms=>localDateAt(ms,spec.zone).replaceAll('-','');
    const params=new URLSearchParams(query),minute=params.get('interval')!=='1d';
    if(minute&&spec.minuteCandles)return minuteCandles(symbol,params,options);
    if(minute)return read(key+'minute',`https://api.stock.naver.com/chart/foreign/index/${spec.code}?periodType=day`,60000,data=>parseNaverIndexHistory(data,symbol,{minute:true,now:now()}),options.signal,options.priority);
    const end=now(),requested=Number(params.get('period1'))*1000;
    const years=/^(\d+)y$/.exec(params.get('range')||'')?.[1]||2;
    const start=Math.max(end-45*366*86400000,requested>0?requested:end-Number(years)*366*86400000);
    const from=date(start),through=date(end);
    const basic=await read(key+'identity',`https://api.stock.naver.com/index/${spec.code}/basic`,3600000,data=>{identity(data,symbol,{basic:true});return data;},options.signal,options.priority);
    return read(key+'daily:'+from+':'+through,`https://api.stock.naver.com/chart/foreign/index/${spec.code}/day?startDateTime=${from}0000&endDateTime=${through}2359`,300000,data=>parseNaverIndexHistory(data,symbol,{now:now(),identity:basic}),options.signal,options.priority);
  }
  fetchChart.supports=supported;
  async function fetchSnapshot(symbol,signal) {
    const spec=indexes[symbol],key=symbol+':quote';
    const result=await read(key,`https://polling.finance.naver.com/api/realtime/worldstock/index/${spec.code}`,value=>value.pollAfterMs,data=>{
      const pollAfterMs=Math.max(spec.pollMs,Math.min(86400000,number(data.pollingInterval)||spec.pollMs));
      if(!Array.isArray(data.datas)||data.datas.length!==1)throw invalid('invalid quote rows');
      return {quotes:[parseNaverIndexQuote(data.datas[0],symbol,{now:now(),pollAfterMs})],pollAfterMs};
    },signal);
    // Carry the actual TTL deadline: scheduling from request start would hit
    // the cache just before it expires and add an unintended second interval.
    return {...result,nextPollAtBySymbol:{[symbol]:cache.get(key)?.until??now()+result.pollAfterMs}};
  }
  async function fetchSnapshotBatch(symbols,{signal}={}) {
    if(symbols.some(s=>!supported(s)))throw invalid('unsupported symbol');
    const list=[...new Set(symbols)];
    if(!list.length)return {quotes:[],pollAfterMs:70000};
    const results=await Promise.allSettled(list.map(s=>fetchSnapshot(s,signal)));
    if(stopped||signal?.aborted||results.some(r=>r.status==='rejected'&&r.reason.code==='STOPPED'))throw stoppedError();
    const good=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if(!good.length)throw results.map(r=>r.reason).sort((a,b)=>(a.retryAt||Infinity)-(b.retryAt||Infinity))[0];
    const quotes=results.flatMap((r,i)=>r.status==='fulfilled'?r.value.quotes:[{symbol:list[i],error:'指数来源暂不可用',code:r.reason.code||'SOURCE_UNAVAILABLE',retryAt:r.reason.retryAt,pollAfterMs:Math.max(60000,(r.reason.retryAt||now())-now())}]);
    return {quotes,pollAfterMs:Math.min(...good.map(r=>r.pollAfterMs)),nextPollAtBySymbol:Object.assign({},...good.map(r=>r.nextPollAtBySymbol))};
  }
  return {fetchChart,fetchSnapshotBatch,close(){stopped=true;generation++;for(const c of controllers)c.abort();jobs.clear();cache.clear();},reopen(){stopped=false;}};
}
