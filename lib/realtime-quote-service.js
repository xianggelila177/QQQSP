import {mergeOrderBook} from './order-book.js';
import {alpacaOrderBook} from './providers/alpaca-book.js';
import {streamAvailability} from './stream-policy.js';
import {publishQuote} from './quote-contract.js';
import {instrumentTypeFor} from './instruments.js';
import {priceSessionFor} from './sessions.js';
import {marketStateFor, marketCalendarCoverage, timezoneOffsetFor} from '../mkt.mjs';
import {tradeTimestamp} from './providers/alpaca-stream.js';
import {regularTradingStatistics} from './trading-statistics.js';
import {previousTradingDate} from './market-calendar-api.js';

const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'});
const venueDate = at => dateFormat.format(new Date(at));
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const quoteTime = q => { const t=Number(q?.quoteAt ?? q?.ts); return Number.isFinite(t) && t>0 ? (t<1e12?t*1000:t):0; };
const validTime=(value,now)=>finitePositive(value)&&value<=now+1000?value:null;
// These fields describe the selected quote source, not reusable instrument or
// history metadata. Never carry a website's delay/precision into a stream tick.
const quoteSourceFields=['isDelayed','feedDelaySource','quoteTimePrecision','providerUpdatedAt','declaredRealtime','delayed',
  'feed','source','quoteTimeBasis','observedAt','quoteTradingDate','tradingDate','quoteSourceTimestamp','tradeExchange','tradeConditions','tradeReceivedAt'];
function streamMetadata(symbol,data,now){
  const availability=streamAvailability(symbol,data,now);
  return {realtimeSource:data?.source||null,connectionCheckedAt:validTime(data?.connectionCheckedAt,now),
    realtimeConnectionHealthy:availability.connectionHealthy,realtimeTradeFresh:availability.tradeFresh,realtimeNoNewTrade:availability.noNewTrade};
}
function validBar(bar) {
  return bar && ['o','h','l','c'].every(key=>finitePositive(bar[key])) && bar.h>=Math.max(bar.o,bar.c,bar.l) && bar.l<=Math.min(bar.o,bar.c);
}
function sameDayStatistics(base,symbol,day,now){
  if(base?.symbol!==symbol||base.currency!=='USD'||base.error||base.pending||base.recovery||base.stale||base.staleInfo)return null;
  const stats=regularTradingStatistics(base);
  // A premarket/after-hours price's date cannot date yesterday's OHLC. Require
  // an actual regular-session statistics clock, not just the outer quote day.
  if(!stats||!stats.source||stats.tradeDate!==day||stats.asOf>now+1000||priceSessionFor(symbol,stats.asOf)!=='REGULAR'||
    base.tradingStats?.tradeDate&&base.tradingStats.tradeDate!==stats.tradeDate)return null;
  return {...stats,retained:false,checkedAt:validTime(stats.checkedAt,now)??(stats.source===base.src?validTime(base.sourceCheckedAt,now):null)};
}

// A stream price is a reported trade, NOT an official close or NBBO. Supplemental
// regular statistics keep their own verified trading day, source and clock.
export function mergeAlpacaQuote(base, data, now=Date.now()) {
  const symbolHint=base?.symbol||data?.trade?.symbol||data?.orderBook?.symbol;
  const book=data?.orderBook||alpacaOrderBook(symbolHint,data?.snapshot?.latestQuote,{source:data?.source,coverage:data?.coverage,checkedAt:data?.snapshotCheckedAt,now});
  if(book&&symbolHint)base=mergeOrderBook(base||{symbol:symbolHint,currency:'USD'}, {symbol:symbolHint,currency:'USD',orderBook:book},now);
  const trade = data?.trade;
  const metadata=streamMetadata(symbolHint,data,now);
  if (!trade || !finitePositive(trade.price) || !finitePositive(trade.quoteAt) || trade.quoteAt>now+1000) return base?{...base,...metadata}:base;
  if (base?.symbol && base.symbol!==trade.symbol) base=null;
  if (base && !base.error && finitePositive(base.price) && quoteTime(base)<=now+1000 && quoteTime(base)>trade.quoteAt) {
    const out={...base,...metadata,realtimeStatus:'NEW_SOURCE_OLDER_THAN_FALLBACK'};
    delete out.tradeReceivedAt;
    return out;
  }
  const symbol=trade.symbol, day=venueDate(trade.quoteAt), daily=data.snapshot?.dailyBar, prior=data.snapshot?.prevDailyBar;
  const dailyAt=tradeTimestamp(daily?.t)?.milliseconds, priorAt=tradeTimestamp(prior?.t)?.milliseconds;
  const currentDaily=validBar(daily) && dailyAt && dailyAt<=trade.quoteAt && venueDate(dailyAt)===day;
  const supplemental=sameDayStatistics(base,symbol,day,now);
  // No inferred previous-close date on premarket/day-rollover snapshots.
  let expectedPreviousDate=null;
  try{expectedPreviousDate=previousTradingDate(symbol,day);}catch{/* Do not guess across an unknown calendar. */}
  const priorDate=priorAt?venueDate(priorAt):null;
  const dailyDate=dailyAt?venueDate(dailyAt):null;
  const sourcePreviousClose=expectedPreviousDate&&
    (validBar(prior)&&priorDate===expectedPreviousDate&&trade.quoteAt-priorAt<10*86400000?prior.c:
      validBar(daily)&&dailyDate===expectedPreviousDate&&trade.quoteAt-dailyAt<10*86400000?daily.c:null);
  const previousClose=sourcePreviousClose??(expectedPreviousDate&&supplemental? supplemental.prevClose:null);
  const statisticsSource=currentDaily?data.source:supplemental?.source??null;
  const statisticsAsOf=currentDaily?validTime(data.snapshotCheckedAt,now):supplemental?.asOf??null;
  const change=previousClose!=null ? trade.price-previousClose : null;
  const checkedAt=Math.max(validTime(trade.receivedAt,now)||0,validTime(data.snapshotCheckedAt,now)||0)||null;
  const streaming=data.state==='streaming',availability=streamAvailability(symbol,data,now);
  const inherited={...(base && !base.error ? base : {})};for(const key of quoteSourceFields)delete inherited[key];
  const delay=typeof data.delayMinutes==='number'&&Number.isFinite(data.delayMinutes)&&data.delayMinutes>=0?data.delayMinutes:null;
  const out={...inherited,symbol,displayName:base?.displayName||symbol,
    price:trade.price,quoteAt:trade.quoteAt,ts:trade.quoteAt,sourceCheckedAt:checkedAt,fetchedAt:checkedAt,
    src:data.source,priceBasis:'reported-trade',quoteKind:'reported-trade',feedCoverage:data.coverage,feedDelayMinutes:delay,
    isDelayed:delay===null?null:delay>0,feedDelaySource:delay===null?null:data.source+'-feed-declaration',quoteTimePrecision:'millisecond',quoteTimeBasis:'source_time',
    quoteSourceTimestamp:trade.sourceTimestamp,tradeExchange:trade.exchange,tradeConditions:trade.conditions,
    ...metadata,tradeReceivedAt:validTime(trade.receivedAt,now),
    priceSession:priceSessionFor(symbol,trade.quoteAt),market:'美股',marketState:marketStateFor(symbol,null,now),
    calendarCoverage:marketCalendarCoverage(symbol,now),gmtoff:timezoneOffsetFor(symbol,trade.quoteAt),
    currency:'USD',sourceCurrency:'USD',priceScale:1,instrumentType:instrumentTypeFor(symbol,base?.instrumentType),
    checkIntervalMs:streaming?1000:60000,pollAfterMs:1000,realtimeStatus:data.state,
    change,changePct:previousClose!=null?change/previousClose*100:null,prevClose:previousClose,
    previousCloseSource:sourcePreviousClose!==null?data.source:supplemental?.source??null,
    previousCloseAsOf:sourcePreviousClose!==null?(priorDate===expectedPreviousDate?priorAt:dailyAt):supplemental?.asOf??null,
    previousCloseTradeDate:previousClose!==null?expectedPreviousDate:null,
    previousCloseStatus:previousClose!==null?'source-dated':'unavailable',
    regularPrice:null,regularMarketPrice:null,regularQuoteAt:null,ext:null,
    open:currentDaily?daily.o:supplemental?.open??null,dayHigh:currentDaily?daily.h:supplemental?.high??null,dayLow:currentDaily?daily.l:supplemental?.low??null,
    volume:currentDaily?(typeof daily.v==='number' && Number.isFinite(daily.v) && daily.v>=0?daily.v:null):supplemental?.volume??null,
    volumeUnit:currentDaily||supplemental?'shares':null,turnoverAmount:currentDaily?null:supplemental?.turnoverAmount??null,
    tradingStats:currentDaily?null:supplemental,
    ohlcSession:currentDaily?'SOURCE_SNAPSHOT':supplemental?'REGULAR':null,statisticsSource,statisticsAsOf,
    statisticsCheckedAt:currentDaily?validTime(data.snapshotCheckedAt,now):supplemental?.checkedAt??null,
    historySource:base?.src||null,
    slowFields:{...base?.slowFields,ohlc:{source:statisticsSource,updatedAt:statisticsAsOf,
      stale:!statisticsAsOf||now-statisticsAsOf>120000,status:currentDaily?'source-snapshot':supplemental?'supplemental-statistics':'unavailable'}},
    stale:!availability.usable};
  for(const key of ['error','code','pending','recovery','staleInfo','retryAt','retryAfterMs']) delete out[key];
  if(out.stale)out.staleInfo={reason:availability.reason||'realtime-disconnected'};
  return publishQuote(out);
}

export function createRealtimeQuoteService({provider, fallback, now=Date.now, maxEntries=200, maxInflight=4,onUpdate=()=>{}}={}) {
  const cache=new Map(), inflight=new Map(),queue=new Map();
  // This is a cache-read cadence. The shared fallback owns provider TTLs,
  // batching and Retry-After, so reading it cannot shorten an upstream gate.
  const refreshMs=1000;
  let closed=false,generation=0;
  function remember(symbol, value) {
    cache.delete(symbol);cache.set(symbol,value);
    while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
  }
  function drain(){
    if(closed)return;
    for(const [symbol,task] of queue){
      if(inflight.size>=maxInflight)break;
      if(inflight.has(symbol))continue;
      queue.delete(symbol);inflight.set(symbol,task);
      const old=cache.get(symbol);
      Promise.resolve().then(()=>{
        if(closed||task.epoch!==generation)return null;
        return fallback(symbol);
      }).then(quote=>{
        if(!closed&&task.epoch===generation){
          const next=quote?.error||quote?.pending||!quote?old?.quote:quote;
          remember(symbol,{quote:next,checkedAt:now(),nextAt:now()+refreshMs});
          task.notify=next!==old?.quote;
        }
        task.resolve(quote);
      },()=>{
        if(!closed&&task.epoch===generation)remember(symbol,{quote:old?.quote,checkedAt:now(),nextAt:now()+refreshMs});
        task.resolve({symbol,error:'报价来源暂不可用',code:'REALTIME_FALLBACK_UNAVAILABLE'});
      }).finally(()=>{
        if(inflight.get(symbol)===task)inflight.delete(symbol);
        if(task.notify&&!closed&&task.epoch===generation){try{onUpdate(symbol);}catch{}}
        drain();
      });
    }
  }
  function warm(symbol) {
    const old=cache.get(symbol),active=inflight.get(symbol);
    if(active?.epoch===generation)return active.promise;
    if(queue.has(symbol))return queue.get(symbol).promise;
    if(closed||old?.nextAt>now()||queue.size>=maxEntries)return null;
    let resolve;const promise=new Promise(r=>{resolve=r;});
    queue.set(symbol,{promise,resolve,epoch:generation});drain();return promise;
  }
  async function getCachedQuote(symbol) {
    if(closed)throw Object.assign(new Error('Realtime service stopped'),{code:'STOPPED'});
    if(!provider.supports(symbol) || !provider.touch(symbol))return fallback(symbol);
    const epoch=generation;
    const data=provider.read(symbol);
    const work=warm(symbol), existing=cache.get(symbol)?.quote;
    if(data?.trade)return mergeAlpacaQuote(existing,data,now());
    if(existing)return {...mergeAlpacaQuote(existing,data,now()),realtimeStatus:data?.invalidated?'TRADE_INVALIDATED':data?.state||'connecting'};
    // Give an immediately available shared cache one event-loop turn, but never
    // hold the engine's per-symbol singleflight slot behind a network lookup.
    // Its first streamed trade can then poke the engine independently.
    const pending={symbol,pending:true,error:'等待首次报价'};
    let immediate,result;
    try{result=work?await Promise.race([work,new Promise(resolve=>{immediate=setImmediate(()=>resolve(pending));})]):pending;}
    finally{clearImmediate(immediate);}
    if(closed||epoch!==generation)throw Object.assign(new Error('Realtime service stopped'),{code:'STOPPED'});
    return mergeAlpacaQuote(result,provider.read(symbol),now());
  }
  return Object.freeze({getCachedQuote,
    start(){closed=false;provider.start();drain();},
    stop(){closed=true;generation++;cache.clear();for(const task of queue.values())task.resolve(null);queue.clear();provider.stop();},
    diagnostics:()=>({...provider.diagnostics(),enrichmentEntries:cache.size,enrichmentInflight:inflight.size,enrichmentQueued:queue.size,cacheReadMs:refreshMs})});
}
