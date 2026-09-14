import {timezoneOffsetFor,marketStateFor} from '../mkt.mjs';

function observationMs(value){return Number.isFinite(value)&&value>0?(value<1e12?value*1000:value):null;}
function lastPoint(quote,now){
  return (quote.charts?.intraday||[]).findLast(p=>Number.isFinite(p?.t)&&p.t>0&&p.t*1000<=now&&Number.isFinite(p.c)&&p.c>0);
}
function localDate(symbol,at){
  const offset=timezoneOffsetFor(symbol,at);
  return offset==null?null:new Date(at+offset*1000).toISOString().slice(0,10);
}

// A latest quote is a separate point, never an invented historical candle.
// Source timestamps, original units and historical arrays remain unchanged.
export function intradayLiveFields(quote,{now=Date.now(),historyCurrency}={}){
  const empty=status=>({intradayLivePoint:null,intradayLiveStatus:status});
  const at=observationMs(quote.quoteAt??quote.ts);
  const active=['REGULAR','PRE','POST','AUCTION'];
  const delay=Number.isFinite(quote.feedDelayMinutes)&&quote.feedDelayMinutes>=0?quote.feedDelayMinutes*60000:0;
  const poll=Number(quote.checkIntervalMs??quote.pollAfterMs);
  const freshnessMs=delay+Math.max(30000,Number.isFinite(poll)&&poll>0?Math.min(poll,300000)*2:30000);
  if(quote.stale||quote.staleInfo||quote.pending||quote.recovery||quote.error||
    !Number.isFinite(quote.price)||quote.price<=0||at==null||at>now||
    !active.includes(quote.marketState)||now-at>freshnessMs||
    typeof quote.src!=='string'||!quote.src||typeof quote.currency!=='string')return empty('unavailable');
  const last=lastPoint(quote,now);
  if(!last)return empty('waiting-history');
  if(!historyCurrency||quote.currency!==historyCurrency)return empty('unavailable');
  if(at<last.t*1000)return empty('unavailable');
  const sessionDate=localDate(quote.symbol,at),historyDate=localDate(quote.symbol,last.t*1000);
  if(sessionDate!==localDate(quote.symbol,now)||marketStateFor(quote.symbol,null,at,quote)!==quote.marketState||marketStateFor(quote.symbol,null,now,quote)!==quote.marketState)return empty('unavailable');
  if(!sessionDate||sessionDate!==historyDate)return empty('waiting-history');
  return {intradayLiveStatus:'ready',intradayLivePoint:{t:at/1000,c:quote.price,v:null,source:quote.src,currency:quote.currency,sessionDate,historyDate}};
}

// A 5m bar is labeled at interval start. Compare it to the newest known quote,
// allowing that bucket, declared historical-feed delay and one fetch cadence.
export function intradayObservationStatus(quote,{now=Date.now(),feedDelayMinutes,cadenceMs=60000}={}){
  const last=lastPoint(quote,now),at=observationMs(quote.quoteAt??quote.ts);
  if(!last||at==null||at>now)return {};
  // Some vendors stamp an after-close update rather than the final trade.
  // Only comparable regular-session timestamps can establish a historical gap;
  // historical feeds need not cover every extended/auction session.
  if(quote.marketState!=='REGULAR'||marketStateFor(quote.symbol,null,at,quote)!=='REGULAR')
    return {dataAsOf:last.t*1000,dataComparable:false,dataLagMs:null,dataStale:false};
  const delay=Number.isFinite(feedDelayMinutes)&&feedDelayMinutes>=0?feedDelayMinutes*60000:0;
  const dataLagMs=Math.max(0,at-last.t*1000),dataAllowanceMs=300000+delay+cadenceMs;
  return {dataAsOf:last.t*1000,dataComparable:true,dataLagMs,dataAllowanceMs,dataStale:dataLagMs>dataAllowanceMs};
}
