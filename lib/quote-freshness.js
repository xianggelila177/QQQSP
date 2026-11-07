import {quoteFreshnessPolicy} from './quote-age.js';
import {quoteConnectionHealthy} from './stream-policy.js';
import {localDateAt} from './history-contract.js';
import {timezoneForSymbol} from '../mkt.mjs';

// A configured primary may report the exact last trade before a website's
// rounded session timestamp. Permit a healthy source switch, never an older
// tick within one source or a switch across sessions/trading dates.
export function canPromotePrimaryQuote(next,previous,primarySource,at=Date.now()) {
  if(!primarySource||next?.src!==primarySource||previous?.src===primarySource||
    next?.symbol!==previous?.symbol||next?.currency!==previous?.currency||
    !next?.priceSession||next.priceSession!==previous?.priceSession||
    next.error||next.pending||next.stale||next.recovery||next.staleInfo||
    !Number.isFinite(next.price)||!Number.isFinite(next.quoteAt)||!Number.isFinite(previous.quoteAt)||
    !(next.sourceCheckedAt>=Number(previous.sourceCheckedAt||0)))return false;
  const freshness=assessQuoteFreshness(next,at);
  if(freshness.checkReason||freshness.eventReason)return false;
  const zone=timezoneForSymbol(next.symbol);
  return localDateAt(next.quoteAt,zone)===localDateAt(previous.quoteAt,zone);
}

const timestamp=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8.64e15?value:null;
// A source confirmation clock belongs to the selected price. Fetching a cached
// object or receiving another provider's heartbeat cannot refresh that clock.
// Shared by API projection, its wait gate and operational health diagnostics.
export function assessQuoteFreshness(quote,at=Date.now()) {
  const checked=timestamp(quote?.sourceCheckedAt),eventAt=timestamp(quote?.quoteAt);
  const cadence=Math.min(3600000,Math.max(0,...[quote?.checkIntervalMs,quote?.pollAfterMs].filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)));
  const policy=quoteFreshnessPolicy(quote,at);
  const checkLimitMs=Math.max(60000,2*cadence+5000),ageLimitMs=Math.max(0,at-policy.minEventAt);
  const mismatchedStream=quote?.priceBasis==='reported-trade'&&quote?.realtimeSource&&quote?.src!==quote.realtimeSource;
  const checkReason=mismatchedStream?'SOURCE_CONFIRMATION_MISMATCH':quote?.sourceCheckedAt==null?'UNKNOWN_SOURCE_CHECK':checked===null||checked>at?'SOURCE_TIME_INVALID':
    !quoteConnectionHealthy(quote,at)&&at-checked>checkLimitMs?'SOURCE_CHECK_OVERDUE':null;
  const eventReason=quote?.quoteAt==null?'UNKNOWN_QUOTE_TIME':eventAt===null||eventAt>at?'QUOTE_TIME_INVALID':at-eventAt>ageLimitMs?'QUOTE_TOO_OLD':policy.missingReason;
  return {checkReason,eventReason,checkLimitMs,ageLimitMs,policy,validEventAt:eventReason==='UNKNOWN_QUOTE_TIME'||eventReason==='QUOTE_TIME_INVALID'?null:eventAt};
}
