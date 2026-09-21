import {rawRegularStatistics} from './regular-statistics.js';
import {financialNumber} from './financial-values.js';
import {timezoneOffsetFor} from '../mkt.mjs';
const ms=value=>{const n=financialNumber(value);return n>0?(n<1e12?n*1000:n):null;};
export function tradingDate(symbol,at){const offset=timezoneOffsetFor(symbol,at);return at>0&&offset!=null?new Date(at+offset*1000).toISOString().slice(0,10):null;}
export function regularTradingStatistics(quote){
  if(!quote?.symbol)return null;
  const raw=rawRegularStatistics(quote);
  if(!raw||raw.volumeUnit&&raw.volumeUnit!=='shares'||raw.currency&&raw.currency!==quote.currency)return null;
  const stamp=ms(raw.asOf),volume=financialNumber(raw.volume),numbers=Object.fromEntries(['open','high','low','prevClose'].map(k=>[k,financialNumber(raw[k])]));
  if(!stamp||volume==null||volume<0||!Object.values(numbers).every(n=>n>0)||numbers.high<numbers.low||numbers.open>numbers.high||numbers.open<numbers.low)return null;
  const amount=financialNumber(raw.turnoverAmount);
  return {...raw,...numbers,volume,volumeUnit:'shares',asOf:stamp,currency:raw.currency||quote.currency,source:raw.source||quote.src,tradeDate:tradingDate(quote.symbol,stamp),turnoverAmount:amount!=null&&amount>=0?amount:null};
}
export function mergeTradingStatistics(next,previous,{now=Date.now()}={}){
  if(!next?.symbol)return next;
  const current=regularTradingStatistics(next),other=previous?.symbol===next.symbol&&previous.currency===next.currency?regularTradingStatistics(previous):null;
  const candidates=[current,other].filter(v=>v&&v.asOf<=now+5000&&now-v.asOf<7*86400000).sort((a,b)=>b.asOf-a.asOf);
  if(!candidates.length)return next;
  let stats={...candidates[0]};
  if(stats.turnoverAmount==null){const amount=candidates.find(v=>v.tradeDate===stats.tradeDate&&v.turnoverAmount!=null);if(amount)stats={...stats,turnoverAmount:amount.turnoverAmount,amountSource:amount.source,amountAsOf:amount.asOf};}
  stats.retained=stats.tradeDate!==tradingDate(next.symbol,now);
  return {...next,tradingStats:stats,open:stats.open,dayHigh:stats.high,dayLow:stats.low,volume:stats.volume,volumeUnit:'shares',turnoverAmount:stats.turnoverAmount,statisticsSource:stats.source,statisticsAsOf:stats.asOf};
}
