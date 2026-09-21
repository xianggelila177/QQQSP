import {tradeTimestamp} from './provider-timestamp.js';
import {normalizeOrderBook} from '../order-book.js';
// Official Alpaca quote sizes are ROUND LOTS, not shares. Never multiply by 100.
export function alpacaOrderBook(symbol,value,{source,coverage,checkedAt,now=Date.now()}={}) {
  if (!value) return null;
  const at=tradeTimestamp(value.t);
  if (!at) return null;
  const book=normalizeOrderBook({symbol,currency:'USD',source,coverage,asOf:at.milliseconds,checkedAt,
    sizeUnit:'round_lots',delayMinutes:0,bid:{price:value.bp,size:value.bs,exchange:value.bx},ask:{price:value.ap,size:value.as,exchange:value.ax}},
    {symbol,currency:'USD'},now);
  return book.asOf?book:null;
}
