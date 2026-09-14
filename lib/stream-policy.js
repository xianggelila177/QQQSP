import {marketStateFor} from '../mkt.mjs';

// A connection heartbeat is not a security's trade. Unknown/delayed coverage
// remains displayable, but never disables periodic website backup checks.
export function streamAvailability(symbol,data,at=Date.now()) {
  const trade=data?.trade,quoteAt=Number(trade?.quoteAt);
  const valid=trade?.symbol===symbol&&Number.isFinite(trade.price)&&trade.price>0&&quoteAt>0&&quoteAt<=at+1000;
  const marketState=marketStateFor(symbol,null,at);
  const closed=['CLOSED','HOLIDAY','BREAK'].includes(marketState);
  const delay=data?.delayMinutes;
  const delayMs=typeof delay==='number'&&Number.isFinite(delay)&&delay>=0?delay*60000:0;
  const maxAgeMs=closed?14*86400000:delayMs+30000;
  const ageMs=valid?Math.max(0,at-quoteAt):Infinity;
  const checkAt=Math.max(Number(data?.connectionCheckedAt)||0,Number(trade?.receivedAt)||0,Number(data?.snapshotCheckedAt)||0);
  const connectionFresh=checkAt>0&&at-checkAt<=90000;
  const usable=!!valid&&data.state==='streaming'&&connectionFresh&&ageMs<=maxAgeMs;
  return {usable,needsBackup:!usable||delay!==0,ageMs,marketState,closed,
    reason:!valid?'invalid-trade':data.state!=='streaming'?'realtime-disconnected':!connectionFresh?'stream-check-overdue':ageMs>maxAgeMs?'trade-age-exceeded':delay!==0?'feed-delay-unverified-or-delayed':null};
}
export function selectStream(symbol,a,b,at=Date.now()) {
  const x=streamAvailability(symbol,a,at),y=streamAvailability(symbol,b,at);
  if(y.usable&&(!x.usable||b.trade.quoteAt>a.trade.quoteAt))return b;
  if(x.usable)return a;
  return b?.trade&&(!a?.trade||b.trade.quoteAt>a.trade.quoteAt)?b:a||b;
}
