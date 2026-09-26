import {publishQuote} from '../quote-contract.js';
import {quoteDisplayName,instrumentMeta} from '../instruments.js';
import {marketStateFor,marketCalendarCoverage,timezoneOffsetFor} from '../../mkt.mjs';
import {providerRetryAt} from './provider-retry.js';
import {twseListingFor} from './twse-listings.js';

const number=value=>{
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value.trim()))return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:null;
};
function tradeInstant(day,time){
  if(!/^\d{8}$/.test(String(day||''))||!/^\d{2}:\d{2}:\d{2}$/.test(String(time||'')))return null;
  const text=`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}T${time}+08:00`;
  const at=Date.parse(text);
  return Number.isFinite(at)&&new Date(at+28800000).toISOString().slice(0,10)===`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}`?at:null;
}
export function parseTwseQuote(payload,symbol,{now=Date.now(),previous=null,bars=[]}={}){
  const listing=twseListingFor(symbol);
  if(!listing)throw Object.assign(new Error('Unconfirmed TWSE listing'),{code:'QUOTE_UNSUPPORTED'});
  if(payload?.rtcode!=='0000'||!Array.isArray(payload.msgArray))throw Object.assign(new Error('TWSE MIS response incomplete'),{code:'QUOTE_BAD_RESPONSE'});
  const rows=payload.msgArray.filter(row=>row?.ex===listing.ex&&row.c===listing.code&&row.ch===listing.channel);
  if(rows.length!==1||payload.msgArray.length!==1)throw Object.assign(new Error('TWSE MIS identity mismatch'),{code:'QUOTE_IDENTITY_CONFLICT'});
  const row=rows[0],rawDay=String(row.d||''),date=/^\d{8}$/.test(rawDay)?`${rawDay.slice(0,4)}-${rawDay.slice(4,6)}-${rawDay.slice(6,8)}`:null;
  if(!date||row['^']&&row['^']!==rawDay||row.key&&!String(row.key).startsWith(`${listing.ex}_${listing.code}.tw_${rawDay}`))
    throw Object.assign(new Error('TWSE MIS trade date mismatch'),{code:'QUOTE_IDENTITY_CONFLICT'});
  const tradePrice=number(row.trade?.z),lastPrice=number(row.z);
  if(tradePrice!=null&&lastPrice!=null&&tradePrice!==lastPrice)throw Object.assign(new Error('TWSE MIS last trade mismatch'),{code:'QUOTE_BAD_RESPONSE'});
  const price=tradePrice??lastPrice,time=tradePrice!=null?row.trade?.t:row.t;
  const quoteAt=tradeInstant(rawDay,time);
  if(!(price>0)||!quoteAt||quoteAt>now+5000)throw Object.assign(new Error('TWSE MIS has no confirmed last trade'),{code:'NO_QUOTE'});
  const localTime=String(time),priceSession=localTime<='13:30:00'?'REGULAR':'POST';
  const referencePrice=number(row.y),meta=instrumentMeta(symbol,{shortName:row.n,exchangeName:'TWSE',instrumentType:listing.instrumentType});
  const close=previous?.date<date&&previous.c>0?previous:null;
  const state=marketStateFor(symbol,null,now,{venue:'TWSE',instrumentType:listing.instrumentType});
  const calendar=marketCalendarCoverage(symbol,now,null,{venue:'TWSE',instrumentType:listing.instrumentType});
  const providerHint=number(payload.userDelay);
  const pollAfterMs=Math.max(providerHint>=5000?providerHint:5000,['CLOSED','HOLIDAY'].includes(state)?900000:state==='BREAK'?60000:5000);
  const dailyBars=bars.filter(bar=>bar.date<=date).slice(-126).map(bar=>({t:bar.t,o:bar.o,h:bar.h,l:bar.l,c:bar.c,v:null}));
  const previousClose=close?{prevClose:close.c,previousCloseTradeDate:close.date,previousCloseSource:'twse-stock-day',previousCloseStatus:'source-dated',previousCloseCurrency:'TWD',previousClosePriceScale:1}:{};
  return publishQuote({symbol,market:meta.market,name:row.n||quoteDisplayName(symbol),displayName:row.n||quoteDisplayName(symbol),
    exchangeName:'TWSE',instrumentType:listing.instrumentType,instrumentTypeSource:'provider',currency:'TWD',sourceCurrency:'TWD',priceScale:1,gmtoff:timezoneOffsetFor(symbol,now),
    price,quoteAt,ts:quoteAt,quoteTimePrecision:'second',quoteTimeBasis:tradePrice!=null?'mis-trade.t':'mis-t',quoteTradeDate:date,
    regularPrice:priceSession==='REGULAR'?price:null,regularQuoteAt:priceSession==='REGULAR'?quoteAt:null,priceSession,
    ...previousClose,referencePrice,referencePriceSource:'twse-mis-y',referencePriceIsPreviousClose:false,
    open:number(row.o),dayHigh:number(row.h),dayLow:number(row.l),volume:null,volumeStatus:'unverified',volumeMissingReason:'TWSE_MIS_VOLUME_SCOPE_UNVERIFIED',
    marketState:state,calendarCoverage:calendar,ohlcSession:'SOURCE_UNVERIFIED',ohlcConsistent:null,
    src:'twse-mis',priceBasis:'official-website-last-trade',feedCoverage:'TWSE MIS quoted last trade; exact dissemination delay unverified',feedDelayMinutes:null,
    pollAfterMs,checkIntervalMs:pollAfterMs,userDelayMs:providerHint,
    sourceCheckedAt:now,fetchedAt:now,fxMap:null,fxStale:true,currency2cny:null,
    charts:{intraday:[],daily30:dailyBars},daily30Version:dailyBars.at(-1)?.t||0,
    slowFields:{intraday:{source:'twse-mis',status:'no-history',unsupported:true,stale:false,retryable:false,updatedAt:null,missingReason:'NO_VERIFIED_MINUTE_HISTORY'},
      daily30:{source:'twse-stock-day',status:dailyBars.length?'ready':'missing',updatedAt:now,stale:!dailyBars.length,coverage:'source-mixed-sessions',volumeStatus:'unverified'},
      fx:{source:'reference-fx',status:'unavailable',updatedAt:null,stale:true,missingReason:'TWD_REFERENCE_RATE_UNAVAILABLE'}}});
}

export function createTwseQuotes({httpsGet,daily,now=Date.now}={}){
  const getQuote=async(symbol,{signal}={})=>{
    const listing=twseListingFor(symbol);
    if(!listing)throw Object.assign(new Error('Unconfirmed TWSE listing'),{code:'QUOTE_UNSUPPORTED'});
    const url=`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${listing.ex}_${listing.code}.tw&json=1&delay=0`;
    const response=await httpsGet(url,{Accept:'application/json',Referer:'https://mis.twse.com.tw/stock/index.jsp'},{timeout:4000,signal});
    if(response?.status!==200){
      const status=response?.status||503;
      throw Object.assign(new Error(`TWSE MIS HTTP ${status}`),{code:status===429?'RATE_LIMITED':'SOURCE_UNAVAILABLE',status,
        retryAt:providerRetryAt(response?.headers,now(),status===429?60000:30000)});
    }
    let payload;
    try{payload=JSON.parse(response.body);}catch{throw Object.assign(new Error('TWSE MIS response is not JSON'),{code:'QUOTE_BAD_RESPONSE'});}
    const checkedAt=now();
    // Parse identity and trade time before fetching the dated close. An
    // unavailable daily source must not suppress a valid official last trade.
    const provisional=parseTwseQuote(payload,symbol,{now:checkedAt});
    let context={previous:null,bars:[]};
    try{context=await daily.quoteContext(symbol,provisional.quoteTradeDate,{signal});}
    catch(error){if(signal?.aborted)throw error;}
    return parseTwseQuote(payload,symbol,{now:checkedAt,...context});
  };
  const fetchQuotes=async(symbols,options={})=>{
    const supported=[...new Set(symbols.filter(symbol=>twseListingFor(symbol)))];
    return Promise.all(supported.map(symbol=>getQuote(symbol,options)));
  };
  return {supports:symbol=>!!twseListingFor(symbol),getQuote,fetchQuotes};
}
