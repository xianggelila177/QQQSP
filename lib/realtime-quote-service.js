import {streamAvailability} from './stream-policy.js';
import {publishQuote} from './quote-contract.js';
import {instrumentTypeFor} from './instruments.js';
import {priceSessionFor} from './sessions.js';
import {marketStateFor, marketCalendarCoverage, timezoneOffsetFor} from '../mkt.mjs';
import {tradeTimestamp} from './providers/alpaca-stream.js';

const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'});
const venueDate = at => dateFormat.format(new Date(at));
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const quoteTime = q => { const t=Number(q?.quoteAt ?? q?.ts); return Number.isFinite(t) && t>0 ? (t<1e12?t*1000:t):0; };
function validBar(bar) {
  return bar && ['o','h','l','c'].every(key=>finitePositive(bar[key])) && bar.h>=Math.max(bar.o,bar.c,bar.l) && bar.l<=Math.min(bar.o,bar.c);
}

// A stream price is a reported trade, NOT an official close or NBBO. Only same-
// provider, same-trading-day daily statistics may be combined with that price.
export function mergeAlpacaQuote(base, data, now=Date.now()) {
  const trade = data?.trade;
  if (!trade || !finitePositive(trade.price) || !finitePositive(trade.quoteAt) || trade.quoteAt>now+1000) return base;
  if (base?.symbol && base.symbol!==trade.symbol) base=null;
  if (base && !base.error && quoteTime(base)>trade.quoteAt) return {...base, realtimeStatus:'NEW_SOURCE_OLDER_THAN_FALLBACK'};
  const symbol=trade.symbol, day=venueDate(trade.quoteAt), daily=data.snapshot?.dailyBar, prior=data.snapshot?.prevDailyBar;
  const dailyAt=tradeTimestamp(daily?.t)?.milliseconds, priorAt=tradeTimestamp(prior?.t)?.milliseconds;
  const currentDaily=validBar(daily) && dailyAt && venueDate(dailyAt)===day;
  // No inferred previous-close date on premarket/day-rollover snapshots.
  const previousClose=currentDaily && validBar(prior) && priorAt && venueDate(priorAt)<day && trade.quoteAt-priorAt<10*86400000 ? prior.c : null;
  const change=previousClose!=null ? trade.price-previousClose : null;
  const checkedAt=Math.max(trade.receivedAt,Number(data.snapshotCheckedAt)||0);
  const streaming=data.state==='streaming',availability=streamAvailability(symbol,data,now);
  const out={...(base && !base.error ? base : {}),symbol,displayName:base?.displayName||symbol,
    price:trade.price,quoteAt:trade.quoteAt,ts:trade.quoteAt,sourceCheckedAt:checkedAt,fetchedAt:checkedAt,
    src:data.source,priceBasis:'reported-trade',quoteKind:'reported-trade',feedCoverage:data.coverage,feedDelayMinutes:data.delayMinutes??null,
    quoteSourceTimestamp:trade.sourceTimestamp,tradeExchange:trade.exchange,tradeConditions:trade.conditions,
    priceSession:priceSessionFor(symbol,trade.quoteAt),market:'美股',marketState:marketStateFor(symbol,null,now),
    calendarCoverage:marketCalendarCoverage(symbol,now),gmtoff:timezoneOffsetFor(symbol,trade.quoteAt),
    currency:'USD',sourceCurrency:'USD',priceScale:1,instrumentType:instrumentTypeFor(symbol,base?.instrumentType),
    checkIntervalMs:streaming?1000:60000,pollAfterMs:1000,realtimeStatus:data.state,
    change,changePct:previousClose!=null?change/previousClose*100:null,prevClose:previousClose,
    regularPrice:null,regularQuoteAt:null,ext:null,
    open:currentDaily?daily.o:null,dayHigh:currentDaily?daily.h:null,dayLow:currentDaily?daily.l:null,
    volume:currentDaily && typeof daily.v==='number' && Number.isFinite(daily.v) && daily.v>=0?daily.v:null,
    ohlcSession:'SOURCE_SNAPSHOT',statisticsSource:data.source,statisticsAsOf:data.snapshotCheckedAt,
    historySource:base?.src||null,
    slowFields:{...base?.slowFields,ohlc:{source:data.source,updatedAt:data.snapshotCheckedAt,
      stale:!currentDaily || now-Number(data.snapshotCheckedAt)>120000,status:currentDaily?'source-snapshot':'unavailable'}},
    stale:!availability.usable};
  for(const key of ['error','code','pending','recovery','staleInfo','retryAt','retryAfterMs']) delete out[key];
  if(out.stale)out.staleInfo={reason:availability.reason||'realtime-disconnected'};
  return publishQuote(out);
}

export function createRealtimeQuoteService({provider, fallback, now=Date.now, ttl=60000, maxEntries=200, maxInflight=4}={}) {
  const cache=new Map(), inflight=new Map();
  let closed=false,generation=0;
  function remember(symbol, value) {
    cache.delete(symbol);cache.set(symbol,value);
    while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
  }
  function warm(symbol) {
    const old=cache.get(symbol);
    if(inflight.has(symbol))return inflight.get(symbol);
    if(closed || old?.nextAt>now() || inflight.size>=maxInflight)return null;
    const epoch=generation;
    const work=Promise.resolve().then(()=>fallback(symbol)).then(quote=>{
      if(!closed && epoch===generation)remember(symbol,{quote:quote?.error||quote?.pending ? old?.quote : quote,checkedAt:now(),nextAt:now()+(quote?.error||quote?.pending?1000:ttl)});
      return quote;
    },()=>{
      if(!closed && epoch===generation)remember(symbol,{quote:old?.quote,checkedAt:now(),nextAt:now()+5000});
      return {symbol,error:'报价来源暂不可用',code:'REALTIME_FALLBACK_UNAVAILABLE'};
    }).finally(()=>{if(inflight.get(symbol)===work)inflight.delete(symbol);});
    inflight.set(symbol,work);return work;
  }
  async function getCachedQuote(symbol) {
    if(closed)throw Object.assign(new Error('Realtime service stopped'),{code:'STOPPED'});
    if(!provider.supports(symbol) || !provider.touch(symbol))return fallback(symbol);
    const epoch=generation;
    const data=provider.read(symbol);
    if(streamAvailability(symbol,data,now()).needsBackup&&cache.has(symbol)){const entry=cache.get(symbol);entry.nextAt=Math.min(entry.nextAt,(entry.checkedAt||0)+5000);}
    const work=warm(symbol), existing=cache.get(symbol)?.quote;
    if(data?.trade)return mergeAlpacaQuote(existing,data,now());
    if(existing)return {...existing,realtimeStatus:data?.invalidated?'TRADE_INVALIDATED':data?.state||'connecting'};
    const result=work ? await work : {symbol,pending:true,error:'等待首次报价'};
    if(closed||epoch!==generation)throw Object.assign(new Error('Realtime service stopped'),{code:'STOPPED'});
    return mergeAlpacaQuote(result,provider.read(symbol),now());
  }
  return Object.freeze({getCachedQuote,
    start(){closed=false;provider.start();},
    stop(){closed=true;generation++;cache.clear();provider.stop();},
    diagnostics:()=>({...provider.diagnostics(),enrichmentEntries:cache.size,enrichmentInflight:inflight.size})});
}
