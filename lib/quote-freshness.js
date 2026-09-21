import {quoteAgeLimitMs} from './quote-age.js';
import {quoteConnectionHealthy} from './stream-policy.js';

const timestamp=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8.64e15?value:null;
// A source confirmation clock belongs to the selected price. Fetching a cached
// object or receiving another provider's heartbeat cannot refresh that clock.
// Shared by API projection, its wait gate and operational health diagnostics.
export function assessQuoteFreshness(quote,at=Date.now()) {
  const checked=timestamp(quote?.sourceCheckedAt),eventAt=timestamp(quote?.quoteAt);
  const cadence=Math.min(3600000,Math.max(0,...[quote?.checkIntervalMs,quote?.pollAfterMs].filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)));
  const checkLimitMs=Math.max(60000,2*cadence+5000),ageLimitMs=quoteAgeLimitMs(quote,at);
  const checkReason=quote?.sourceCheckedAt==null?'UNKNOWN_SOURCE_CHECK':checked===null||checked>at?'SOURCE_TIME_INVALID':
    !quoteConnectionHealthy(quote,at)&&at-checked>checkLimitMs?'SOURCE_CHECK_OVERDUE':null;
  const eventReason=quote?.quoteAt==null?'UNKNOWN_QUOTE_TIME':eventAt===null||eventAt>at?'QUOTE_TIME_INVALID':at-eventAt>ageLimitMs?'QUOTE_TOO_OLD':null;
  return {checkReason,eventReason,checkLimitMs,ageLimitMs,validEventAt:eventReason==='UNKNOWN_QUOTE_TIME'||eventReason==='QUOTE_TIME_INVALID'?null:eventAt};
}
