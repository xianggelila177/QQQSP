import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSnapshotService} from '../lib/snapshot-service.js';

async function fixture({symbol='QQQ',state='REGULAR',barLag=25000,dailyAge=267000,cacheClosing=false}={},run){
 const originals={setInterval,clearInterval,setTimeout,clearTimeout};
 let tick,time=Date.parse('2026-09-08T14:41:44Z'),session=state,enrichCalls=0,initialQuote;
 globalThis.setInterval=fn=>(tick=fn,1);globalThis.clearInterval=()=>{};
 globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
 const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
 const service=createSnapshotService({now:()=>time,sessionFor:()=>session,
  fetchBatch:async()=>({quotes:[{symbol,price:718.01,quoteAt:time,fetchedAt:time,currency:'USD',marketState:session,src:'fixture-batch',feedDelayMinutes:0}]}),
  enrich:async()=>{enrichCalls++;if(cacheClosing&&enrichCalls===2)return initialQuote;const quote={symbol,price:717.81,quoteAt:time-barLag,fetchedAt:time,currency:'USD',marketState:session,src:'yahoo',feedDelayMinutes:0,
   charts:{intraday:[{t:(time-barLag)/1000,c:717.81,v:10}],daily30:[{t:time/1000-3600,c:717.39,v:100}]},
   slowFields:{intraday:{source:'yahoo',updatedAt:time,stale:false},daily30:{source:'yahoo',updatedAt:time-dailyAge,stale:false},charts:{source:'yahoo',updatedAt:time-dailyAge,stale:false}}};initialQuote??=quote;return quote;}
 });
 try{
  service.start();service.getCachedQuote(symbol);tick();await flush();
  await run({read:()=>service.getCachedQuote(symbol),calls:()=>enrichCalls,advance:async(ms,nextSession=session)=>{time+=ms;session=nextSession;tick();await flush();}});
 }finally{service.stop();Object.assign(globalThis,originals);}
}

test('retrieval metadata aggregate cannot claim stale when both chart families are fresh',()=>fixture({},async({read})=>{
 const q=read();assert.equal(q.slowFields.intraday.stale,false);assert.equal(q.slowFields.daily30.stale,false);
 assert.equal(q.slowFields.charts.stale,false,'aggregate must derive family statuses, not apply a different TTL to daily source timestamp');
}));

test('a recent HTTP check cannot make active-session intraday history 79 minutes behind its quote fresh',()=>fixture({barLag:79*60000,dailyAge:0},async({read})=>{
 const q=read();assert.equal(q.price,718.01);
 assert.equal(q.slowFields.intraday.stale,true,'fresh check and stale observation are separate clocks');
}));
test('closed-market vendor update times cannot be mistaken for late trades',()=>fixture({symbol:'300750.SZ',state:'CLOSED',barLag:79*60000,dailyAge:0},async({read})=>{
 const q=read();assert.equal(q.slowFields.intraday.stale,false,'closed source update time does not establish a historical gap');
 assert.equal(q.slowFields.intraday.dataComparable,false);
}));

test('a five-minute interval start is not an erroneous five-minute data outage',()=>fixture({barLag:4*60000,dailyAge:0},async({read})=>{
 assert.equal(read().slowFields.intraday.stale,false,'allow the current 5-minute bucket timestamp');
}));

test('regular to closed requests a final intraday refresh rather than waiting 15 minutes',()=>fixture({dailyAge:0},async({calls,advance})=>{
  assert.equal(calls(),1);await advance(2000,'CLOSED');
  assert.equal(calls(),2,'closing transition must collect closing prints before switching to closed cadence');
  await advance(2000);assert.equal(calls(),2,'closed boundary cannot cause repeated 2-second refreshes');
}));
test('latest quote point follows batch updates without mutating historical bars',()=>fixture({dailyAge:0},async({read,calls,advance})=>{
 const before=read(),serialized=JSON.stringify(before.charts);
 assert.equal(before.intradayLiveStatus,'ready');assert.equal(before.intradayLivePoint.c,before.price);
 await advance(2000);const after=read();
 assert.equal(calls(),1);assert.equal(after.intradayLivePoint.t-before.intradayLivePoint.t,2);
 assert.equal(JSON.stringify(after.charts),serialized);assert.equal(after.intradayLivePoint.v,null);
}));
test('closing refresh served from pre-close cache retries after cooldown without repeated polling',()=>fixture({dailyAge:0,cacheClosing:true},async({read,calls,advance})=>{
 await advance(2000,'CLOSED');assert.equal(calls(),2);
 assert.equal(read().slowFields.intraday.stale,true,'pre-close cache is not final closing history');
 await advance(2000);assert.equal(calls(),2,'no 2-second retry fanout');
 await advance(58000);assert.equal(calls(),3,'retry after cache window, not 15-minute closed cadence');
 assert.equal(read().slowFields.intraday.stale,false);
}));
