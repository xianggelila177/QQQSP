import assert from 'node:assert/strict';
import {livePointFailures} from '../ops/intraday-live-smoke.mjs';
const history=[{t:1788878479,c:717.81,v:0}];
const quote={symbol:'QQQ',price:718.01,quoteAt:1788878504000,src:'naver-us',currency:'USD',marketState:'REGULAR',intradayLiveStatus:'ready',intradayLivePoint:{t:1788878504,c:718.01,v:null,source:'naver-us',currency:'USD',sessionDate:'2026-09-08',historyDate:'2026-09-08'}};
assert.deepEqual(livePointFailures(quote,history),[]);
for(const patch of [
 {intradayLivePoint:null},
 {intradayLivePoint:{...quote.intradayLivePoint,c:717.81}},
 {intradayLivePoint:{...quote.intradayLivePoint,t:1788878479}},
 {intradayLivePoint:{...quote.intradayLivePoint,v:100}},
 {intradayLivePoint:{...quote.intradayLivePoint,o:718}},
 {intradayLivePoint:{...quote.intradayLivePoint,historyDate:'2026-09-07'}},
 {intradayLivePoint:{...quote.intradayLivePoint,source:'other'}},
 {intradayLivePoint:{...quote.intradayLivePoint,currency:'GBp'}},
 {stale:true},
 {recovery:{from:'disk'}},
 {quoteAt:quote.quoteAt+500},
 {marketState:'CLOSED'},
])assert.ok(livePointFailures({...quote,...patch},history).length);
assert.ok(livePointFailures(quote,[]).length);
assert.ok(livePointFailures(quote,history,quote.quoteAt-1).length);
console.log('PASS live intraday smoke rejects missing, lagging, mismatched and fabricated points');
const {runIntradaySmoke}=await import('../ops/intraday-live-smoke.mjs');
let clock=quote.quoteAt,calls=0;
const requests=[];
const result=await runIntradaySmoke('http://127.0.0.1:1234',{symbols:['QQQ'],durationMs:6000,now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async url=>{
 const u=new URL(url);requests.push(u);calls++;
 const current={...quote,price:718.01+calls/100,quoteAt:clock,intradayVer:123,daily30Ver:456,charts:{intraday:history,daily30:history},slowFields:{intraday:{updatedAt:quote.quoteAt,stale:false},daily30:{updatedAt:quote.quoteAt,stale:false}}};
 current.intradayLivePoint={...quote.intradayLivePoint,t:clock/1000,c:current.price};
 if(u.searchParams.has('cv'))current.charts={intraday:'same',daily30:'same'};
 return {ok:true,json:async()=>[current]};
}});
assert.equal(result.ok,true);
assert.ok(result.summary[0].quoteUpdates>=2);
assert.ok(result.summary[0].sameTransfers>=2);
assert.ok(requests.some(u=>u.searchParams.get('cv')==='QQQ:123:456'));
assert.ok(result.observations.every(row=>row.historyLast.c===717.81));
console.log('PASS live smoke verifies changing quotes with conditional unchanged history');
// Production source handoff: Yahoo history can be two seconds newer than the
// fast quote. The application deliberately omits a backward-time quote point.
const handoff={...quote,quoteAt:1788880975000,price:767.38,intradayLiveStatus:'unavailable',intradayLivePoint:null};
const newerHistory=[{t:1788880977,c:767.4550170898438,v:0}];
assert.deepEqual(livePointFailures(handoff,newerHistory,1788880979599),[]);
for(const [candidate,bars,at] of [
 [{...handoff,stale:true},newerHistory,1788880979599],
 [{...handoff,intradayLiveStatus:'ready'},newerHistory,1788880979599],
 [handoff,[{...newerHistory[0],t:1788880986}],1788880987000],
 [handoff,newerHistory,1788881010000],
 [handoff,newerHistory,1788880976000],
])assert.ok(livePointFailures(candidate,bars,at).length);
console.log('PASS bounded source handoff does not mask stale, future or missing ready points');
for(const mode of ['all-handoffs','static-points']){
 let simulated=1788880980000;
 const staticQuoteTime=simulated-5000;
 const staticBars=mode==='all-handoffs'?newerHistory:history;
 const rejected=await runIntradaySmoke('http://127.0.0.1:1234',{symbols:['QQQ'],durationMs:6000,now:()=>simulated,sleep:async ms=>{simulated+=ms;},fetchImpl:async url=>{
  const same=new URL(url).searchParams.has('cv');
  const q={...quote,quoteAt:staticQuoteTime,intradayVer:123,daily30Ver:456,charts:{intraday:same?'same':staticBars,daily30:same?'same':staticBars},slowFields:{intraday:{updatedAt:staticQuoteTime,stale:false},daily30:{updatedAt:staticQuoteTime,stale:false}}};
  q.intradayLivePoint=mode==='all-handoffs'?null:{...quote.intradayLivePoint,t:staticQuoteTime/1000};q.intradayLiveStatus=mode==='all-handoffs'?'unavailable':'ready';
  return {ok:true,json:async()=>[q]};
 }});
 assert.equal(rejected.ok,false,mode+' must not claim dynamic acceptance');
 assert.ok(rejected.failures.some(reason=>reason.includes('no changing matched quote points')));
 if(mode==='all-handoffs')assert.ok(rejected.failures.some(reason=>reason.includes('insufficient matched quote points')));
}
console.log('PASS all-handoff and static windows cannot pass dynamic acceptance');
