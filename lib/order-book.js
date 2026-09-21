import {number,positive,nonnegative,text,timestamp,common} from './context-values.js';

const emptySide=()=>({price:null,size:null,exchange:null});
const unavailable=reason=>({status:'unavailable',reason,bid:emptySide(),ask:emptySide(),spread:null,
  asOf:null,checkedAt:null,source:null,currency:null,sizeUnit:null,coverage:null,depth:1,stale:false,delayMinutes:null});

/** A book has its own identity, clock, unit and venue scope, independent of trades. */
export function normalizeOrderBook(value,quote,now=Date.now()) {
  if (!value) return unavailable(quote?.instrumentType==='INDEX'?'INSTRUMENT_TYPE':'SOURCE_HAS_NO_BOOK');
  if (value.symbol!==quote?.symbol || !value.currency || value.currency!==quote.currency) return unavailable('BOOK_IDENTITY_MISMATCH');
  const at=timestamp(value.asOf),checked=timestamp(value.checkedAt);
  if (!at || at>now+5000 || checked!==null&&checked>now+5000) return unavailable('BOOK_TIME_INVALID');
  const side=v=>({price:positive(v?.price),size:nonnegative(v?.size),exchange:text(v?.exchange)});
  const bid=side(value.bid),ask=side(value.ask),usable=bid.price!==null||ask.price!==null;
  const delay=nonnegative(value.delayMinutes),age=Math.max(0,now-at);
  const stale=!!value.stale || age>Math.max(60000,(delay||0)*60000+15000);
  const crossed=bid.price!==null&&ask.price!==null&&bid.price>ask.price;
  const missing=[bid,ask].some(s=>s.price===null||s.size===null)||!text(value.sizeUnit)||!text(value.coverage)||!text(value.source)||checked===null;
  const reason=!usable?'EMPTY_BOOK':crossed?'CROSSED_BOOK':stale?'RETAINED_BOOK':missing?'INCOMPLETE_BOOK':null;
  return {symbol:quote.symbol,currency:value.currency,bid,ask,asOf:at,checkedAt:checked,source:text(value.source),
    sizeUnit:text(value.sizeUnit),coverage:text(value.coverage),depth:1,delayMinutes:delay,stale,
    spread:!crossed&&bid.price!==null&&ask.price!==null?+(ask.price-bid.price).toPrecision(12):null,
    status:!usable?'unavailable':reason?'partial':'ready',reason};
}

/** Preserve price fields while accepting a newer independent book (even on a late trade). */
export function mergeOrderBook(previous,next,now=Date.now()) {
  if (!previous || previous.symbol!==next?.symbol || previous.currency!==next.currency || !next.orderBook) return previous;
  const incoming=normalizeOrderBook(next.orderBook,previous,now);
  if (!incoming.asOf || incoming.asOf<(previous.orderBook?.asOf||0)) return previous;
  return {...previous,orderBook:incoming};
}

export function projectOrderBook(quote,source,now) {
  const b=normalizeOrderBook(quote?.orderBook,quote,now);
  return {...common({status:b.reason==='INSTRUMENT_TYPE'?'not_applicable':b.status,sources:[source(b.source)],asOf:b.asOf,checkedAt:b.checkedAt,
    delay:b.delayMinutes,coverage:{scope:b.coverage,depth:1,size_unit:b.sizeUnit},adjustment:'not_applicable',reason:b.reason}),
    data:{bid:b.bid,ask:b.ask,spread:b.spread,currency:b.currency,size_unit:b.sizeUnit,retained:b.stale}};
}
