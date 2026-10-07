import {priceSessionFor} from './sessions.js';
import {tradingDate} from './trading-statistics.js';

const rawBases=new Set(['provider-quote','website-last-trade','official-website-last-trade','reported-trade']);
const valid=q=>q&&typeof q.price==='number'&&Number.isFinite(q.price)&&q.price>0&&Number.isFinite(q.quoteAt)&&q.quoteAt>0;
const session=q=>q.priceSession||priceSessionFor(q.symbol,q.quoteAt,null,q);
// This is a bounded anomaly screen, not a price oracle or independent-vendor
// vote. Feed scopes can differ; keep both observations and never average them.
export function compareQuoteSources(selected,candidates,{now=Date.now()}={}){
 const comparisons=[],seen=new Set(),thresholdPercent=5,maxTimeGapMs=60000;
 if(!valid(selected))return {status:'not_compared',comparisons,thresholdPercent,maxTimeGapMs};
 for(const q of candidates){
  if(!valid(q)||!q.src||q.src===selected.src||seen.has(q.src))continue;
  seen.add(q.src);
  if(q.symbol!==selected.symbol||!q.currency||q.currency!==selected.currency||q.instrumentType&&selected.instrumentType&&q.instrumentType!==selected.instrumentType)continue;
  if(!rawBases.has(q.priceBasis)||!rawBases.has(selected.priceBasis))continue;
  if([q,selected].some(v=>v.proxy||v.stale||v.recovery||v.adjustmentBasis&&!['raw','unadjusted'].includes(v.adjustmentBasis)||v.quoteAt>now||v.quoteTimeBasis==='server_observation'))continue;
  const selectedSession=session(selected),otherSession=session(q);
  if(!['PRE','REGULAR','POST','AUCTION'].includes(selectedSession)||selectedSession!==otherSession||tradingDate(q.symbol,q.quoteAt)!==tradingDate(selected.symbol,selected.quoteAt))continue;
  const timeGapMs=Math.abs(selected.quoteAt-q.quoteAt);
  if(timeGapMs>maxTimeGapMs)continue;
  const differencePercent=Math.abs(selected.price-q.price)/Math.min(selected.price,q.price)*100;
  comparisons.push({source:q.src,price:q.price,currency:q.currency,quoteAt:q.quoteAt,sourceCheckedAt:q.sourceCheckedAt??null,
   session:otherSession,timeGapMs,differencePercent,status:differencePercent>thresholdPercent?'conflict':'within_threshold'});
 }
 return {status:comparisons.some(v=>v.status==='conflict')?'conflict':comparisons.length?'within_threshold':'not_compared',
  selectedSource:selected.src,thresholdPercent,maxTimeGapMs,comparisons,
  method:'same_security_currency_session_raw_price; anomaly_screen_not_independent_verification'};
}
