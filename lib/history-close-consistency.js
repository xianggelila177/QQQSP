import {localDateAt} from './history-contract.js';
import {tradingDayInfo} from './market-calendar-api.js';
import {marketKeyFor} from './instruments.js';

const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
// Compare a completed cash-session close, never the latest PRE/POST price or a
// date label interpreted as an instant. A conflict does not establish which
// provider is wrong and must not be repaired by splicing prices into OHLC.
export function historyCloseConflict(symbol,currency,rows,quote,now=Date.now()){
 if(marketKeyFor(symbol)!=='us'||quote?.symbol!==symbol||quote.stale||quote.recovery||
  quote.currency!==currency||!positive(quote.regularPrice)||!positive(quote.regularQuoteAt))return null;
 const at=quote.regularQuoteAt,date=localDateAt(at,'America/New_York');
 const day=tradingDayInfo(symbol,date),close=day.regular_sessions?.at(-1)?.close_at_ms;
 if(!day.known||!day.is_open||!close||now<close||at<close||at>close+60000)return null;
 const row=rows.find(row=>row.sessionDate===date);
 if(!positive(row?.c)||Math.abs(row.c-quote.regularPrice)<=Math.max(0.011,quote.regularPrice*0.000001))return null;
 return {status:'conflict',tradeDate:date,historyClose:row.c,quoteClose:quote.regularPrice,
  quoteSource:quote.src||quote.source||null,quoteAt:at,currency};
}

export function chartCloseConflict(symbol,data,quote,now=Date.now()){
 if(data?.meta?.dataGranularity!=='1d'||data.meta.currency!=='USD')return null;
 const q=data.indicators?.quote?.[0],rows=(data.timestamp||[]).flatMap((t,i)=>Number.isFinite(t)
  ?[{sessionDate:localDateAt(t*1000,'America/New_York'),c:q?.close?.[i]}]:[]);
 return historyCloseConflict(symbol,'USD',rows,quote,now);
}
