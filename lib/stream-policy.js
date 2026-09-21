import {marketStateFor} from '../mkt.mjs';
import {quoteAgeLimitMs} from './quote-age.js';

// Public quote readers may exempt an old source-check clock only when the
// selected price itself belongs to this healthy stream. Related stream status
// on a website/recovery quote is not a verification of that quote's source.
export function quoteConnectionHealthy(quote,at=Date.now()) {
  const connection=Number(quote?.connectionCheckedAt)||0;
  return quote?.priceBasis==='reported-trade'&&!!quote?.src&&quote.src===quote.realtimeSource&&
    quote.realtimeConnectionHealthy===true&&quote.realtimeStatus==='streaming'&&
    connection>0&&connection<=at+1000&&at-connection<=90000;
}

// A connection heartbeat is not a security's trade. Unknown/delayed coverage
// remains displayable, but never disables periodic website backup checks.
export function streamAvailability(symbol,data,at=Date.now()) {
  const trade=data?.trade,quoteAt=Number(trade?.quoteAt);
  const valid=trade?.symbol===symbol&&Number.isFinite(trade.price)&&trade.price>0&&quoteAt>0&&quoteAt<=at+1000;
  const marketState=marketStateFor(symbol,null,at);
  const closed=['CLOSED','HOLIDAY','BREAK'].includes(marketState);
  const delay=data?.delayMinutes;
  const delayMs=typeof delay==='number'&&Number.isFinite(delay)&&delay>=0?delay*60000:0;
  const maxAgeMs=quoteAgeLimitMs({symbol,feedDelayMinutes:delay,marketState},at);
  const ageMs=valid?Math.max(0,at-quoteAt):Infinity;
  // Only a WebSocket frame confirms that connection. A fresh REST snapshot or
  // its latestTrade.receivedAt must never mask a silent/disconnected socket.
  const checkAt=Number(data?.connectionCheckedAt)||0;
  const connectionFresh=checkAt>0&&checkAt<=at+1000&&at-checkAt<=90000;
  const connectionHealthy=['streaming','subscribing'].includes(data?.state)&&data?.connectionHealthy!==false&&connectionFresh;
  const tradeFresh=!!valid&&ageMs<=maxAgeMs;
  const usable=connectionHealthy&&data?.state==='streaming'&&tradeFresh;
  const noNewTrade=!!valid&&!closed&&ageMs>delayMs+30000;
  const fullCoverage=data?.coverage==='us-sip';
  return {usable,connectionHealthy,tradeFresh,noNewTrade,needsBackup:!usable||delay!==0||!fullCoverage,ageMs,marketState,closed,
    reason:!valid?'invalid-trade':data.state!=='streaming'?'realtime-disconnected':!connectionFresh?'stream-check-overdue':!tradeFresh?'trade-age-exceeded':delay!==0?'feed-delay-unverified-or-delayed':!fullCoverage?'feed-coverage-limited-or-unverified':null};
}
export function selectStream(symbol,a,b,at=Date.now()) {
  const x=streamAvailability(symbol,a,at),y=streamAvailability(symbol,b,at);
  if(y.usable&&(!x.usable||b.trade.quoteAt>a.trade.quoteAt))return b;
  if(x.usable)return a;
  return b?.trade&&(!a?.trade||b.trade.quoteAt>a.trade.quoteAt)?b:a||b;
}
