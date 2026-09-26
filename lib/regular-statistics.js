import {financialNumber} from './financial-values.js';
const regularSessions=new Set(['REGULAR','CACHED_REGULAR','CN_SNAPSHOT']);
const millis=value=>{const n=financialNumber(value);return n>0?(n<1e12?n*1000:n):null;};
// Shared raw shape; the trading merge additionally validates complete OHLC and volume.
export function rawRegularStatistics(quote) {
  if(!quote)return null;
  if(quote.tradingStats?.session==='REGULAR')return {...quote.tradingStats,asOf:millis(quote.tradingStats.asOf),source:quote.tradingStats.source||quote.src};
  if(!regularSessions.has(quote.ohlcSession))return null;
  const asOf=millis(quote.regularQuoteAt??quote.quoteAt??quote.ts);
  // PRE headline change uses the prior day's close, while retained regular
  // OHLC uses the close before that regular day. Adapters bind that independent
  // comparison to its regular timestamp; never carry it to another stats day.
  const separate=Object.hasOwn(quote,'regularPreviousClose');
  const prevClose=separate?(asOf&&millis(quote.regularPreviousCloseQuoteAt)===asOf?quote.regularPreviousClose:null):
    quote.priceSession==='PRE'?null:quote.prevClose;
  return {session:'REGULAR',open:quote.open,high:quote.dayHigh,low:quote.dayLow,prevClose,
    volume:quote.volume,volumeUnit:quote.volumeUnit,turnoverAmount:quote.turnoverAmount,currency:quote.currency,
    asOf,source:quote.statisticsSource||quote.src};
}
