import {timezoneForSymbol} from '../mkt.mjs';
import {localDateAt} from './history-contract.js';
import {previousTradingDate,tradingDayInfo} from './market-calendar-api.js';

const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const stamp=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?(value<1e12?value*1000:value):null;
const cashType=type=>['EQUITY','ETF','MUTUALFUND'].includes(type);
const sourceComparison=new Set(['naver-us','naver-jp','naver-kr','sina-batch','tx-batch','tx-cn','tx-us','em-cn']);

function tradeDate(symbol,at){
  const ms=stamp(at);
  if(!ms)return null;
  try{return localDateAt(ms,timezoneForSymbol(symbol));}catch{return null;}
}

// Quote-service daily bars use UTC date labels, not intraday trade instants.
export function previousCloseFromDailyBars(symbol,quoteAt,bars,source){
  const day=tradeDate(symbol,quoteAt);
  if(!day||!Array.isArray(bars))return null;
  let previous;
  try{previous=previousTradingDate(symbol,day);}catch{return null;}
  const bar=bars.find(item=>Number.isFinite(item?.t)&&
    new Date(item.t*1000).toISOString().slice(0,10)===previous&&positive(item.c));
  return bar?{prevClose:bar.c,previousCloseTradeDate:previous,
    previousCloseSource:source,previousCloseStatus:'source-dated',previousCloseAsOf:null}:null;
}

function closedRegularPrice(quote,expectedDate){
  const at=stamp(quote.regularQuoteAt);
  if(!positive(quote.regularPrice)||!at||tradeDate(quote.symbol,at)!==expectedDate)return null;
  const day=tradingDayInfo(quote.symbol,expectedDate);
  if(!day.known||!day.is_open||!day.regular_sessions.length)return null;
  const close=day.regular_sessions.at(-1).close_at_ms;
  // A reported 16:00 closing point is valid; an earlier intraday price is not.
  return at>=close-60_000&&at<=close+60_000?{value:quote.regularPrice,asOf:at}:null;
}

/** Resolve the close for the trading day immediately before the selected quote. */
export function resolvePreviousCloseReference(quote){
  if(!quote||!cashType(quote.instrumentType)||!positive(quote.price)||!quote.symbol)return quote;
  const quoteAt=stamp(quote.quoteAt??quote.ts),quoteTradeDate=tradeDate(quote.symbol,quoteAt);
  const missing=(reason,expectedDate=null)=>{
    const out={...quote,quoteTradeDate,previousCloseTradeDate:expectedDate,
      previousCloseStatus:'unavailable',previousCloseMissingReason:reason,previousCloseSource:null,previousCloseAsOf:null,
      prevClose:null,change:null,changePct:null,changeBasis:'previous-regular-close'};
    const key=quote.priceSession==='PRE'?'pre':quote.priceSession==='POST'?'post':null;
    if(key&&out.ext?.[key])out.ext={...out.ext,[key]:{...out.ext[key],change:null,changePct:null,
      referencePrice:null,referenceTradeDate:null}};
    return out;
  };
  if(!quoteTradeDate)return missing('QUOTE_TRADE_DATE_UNKNOWN');
  let expectedDate;
  try{expectedDate=previousTradingDate(quote.symbol,quoteTradeDate);}
  catch{return missing('CALENDAR_OUTSIDE_COVERAGE');}
  let value=null,source=null,asOf=null,status=null;
  const providedDate=quote.previousCloseTradeDate;
  if(providedDate){
    if(providedDate!==expectedDate)return missing('PREVIOUS_CLOSE_DATE_MISMATCH',expectedDate);
    if(quote.previousCloseCurrency&&quote.previousCloseCurrency!==quote.currency)return missing('PREVIOUS_CLOSE_CURRENCY_MISMATCH',expectedDate);
    if(positive(quote.previousClosePriceScale)&&positive(quote.priceScale)&&quote.previousClosePriceScale!==quote.priceScale)return missing('PREVIOUS_CLOSE_SCALE_MISMATCH',expectedDate);
    if(positive(quote.prevClose)){
      value=quote.prevClose;source=quote.previousCloseSource||quote.src||null;asOf=stamp(quote.previousCloseAsOf);
      status=quote.previousCloseStatus==='regular-close'?'regular-close':'source-dated';
    }
  }
  const regularDate=tradeDate(quote.symbol,quote.regularQuoteAt);
  if(value===null&&quote.priceSession==='PRE'&&regularDate===expectedDate){
    const closed=closedRegularPrice(quote,expectedDate);
    if(closed){value=closed.value;source=quote.src||null;asOf=closed.asOf;status='regular-close';}
  }
  if(value===null&&['REGULAR','POST'].includes(quote.priceSession)&&regularDate===quoteTradeDate&&
     sourceComparison.has(quote.src)&&positive(quote.prevClose)){
    value=quote.prevClose;source=quote.src;asOf=null;status='source-aligned';
  }
  // Finnhub's quote `pc` is a previous-close field paired with its trade
  // timestamp. It has no separate close timestamp, so keep the weaker
  // source-aligned status instead of claiming a dated close print.
  if(value===null&&quote.src==='finnhub-quote'&&['PRE','REGULAR','POST'].includes(quote.priceSession)&&positive(quote.providerPrevClose)){
    value=quote.providerPrevClose;source=quote.src;asOf=null;status='source-aligned';
  }
  if(value===null)return missing(providedDate?'PREVIOUS_CLOSE_UNAVAILABLE':
    quote.priceSession==='PRE'?'PRIOR_REGULAR_CLOSE_UNCONFIRMED':'PREVIOUS_CLOSE_DATE_UNCONFIRMED',expectedDate);
  const change=quote.price-value;
  const out={...quote,quoteTradeDate,previousCloseTradeDate:expectedDate,previousCloseStatus:status,
    previousCloseMissingReason:null,previousCloseSource:source,previousCloseAsOf:asOf,
    prevClose:value,change,changePct:change/value*100,changeBasis:'previous-regular-close'};
  if(out.priceSession==='PRE'&&out.ext?.pre){
    const pre=out.ext.pre,price=positive(pre.price)?pre.price:out.price;
    out.ext={...out.ext,pre:{...pre,change:price-value,changePct:(price/value-1)*100,
      referencePrice:value,referenceTradeDate:expectedDate}};
  }
  if(out.priceSession==='POST'&&out.ext?.post){
    const post=out.ext.post,closed=closedRegularPrice(out,quoteTradeDate);
    out.ext={...out.ext,post:{...post,change:closed?post.price-closed.value:null,
      changePct:closed?(post.price/closed.value-1)*100:null,
      referencePrice:closed?.value??null,referenceTradeDate:closed?quoteTradeDate:null}};
  }
  return out;
}
