import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {createRecoveryStore} from '../../lib/recovery-store.js';
import {mergeQuoteHistory} from '../../lib/quote-history-merge.js';
const now=Date.parse('2026-09-13T13:00:00Z'),regularAt=Date.parse('2026-09-11T20:00:01Z'),postAt=Date.parse('2026-09-12T00:00:00Z');
const base={symbol:'NVDA',currency:'USD',gmtoff:-14400,marketState:'CLOSED',priceSession:'POST',price:218.26,quoteAt:postAt,sourceCheckedAt:now,src:'naver-us'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('closed market checks the later postmarket provider even when regular close is healthy',async()=>{
 let calls=0,clock=now;
 const regular={...base,src:'tx-batch',quoteAt:regularAt,price:218.29,pollAfterMs:70000};
 const service=createFastPolling({now:()=>clock,httpsGet:async()=>{throw Error('primary unavailable');},legacy:{tencent:async()=>[regular],fetchSnapshotBatch:async()=>{calls++;return {quotes:[{...base,sourceCheckedAt:clock,pollAfterMs:70000}]};}}});
 const out=await service.fetchSnapshotBatch(['NVDA'],{group:'us'});assert.equal(out.quotes[0].quoteAt,postAt);assert.equal(calls,1);
 clock+=1000;await service.fetchSnapshotBatch(['NVDA'],{group:'us'});assert.equal(calls,1);
 clock+=70000;assert.equal((await service.fetchSnapshotBatch(['NVDA'],{group:'us'})).quotes[0].sourceCheckedAt,clock);assert.equal(calls,2);
});
for(const currency of ['USD','KRW'])test('older price merges only compatible independent history: '+currency,async()=>{
 let candidate={...base,recovery:true,stale:true,staleInfo:{reason:'offline-cache'}};
 const engine=createQuoteEngine({readQuote:async()=>candidate,now:()=>now,tickMs:60000});
 try{
  engine.start();engine.watch(['NVDA']);await flush();
  candidate={...base,currency,src:'tx-batch',quoteAt:regularAt,price:218.29,charts:{intraday:[{t:postAt/1000-60,c:218.26}]},slowFields:{intraday:{source:'nasdaq-intraday',updatedAt:now,stale:false}}};
  engine.poke('NVDA');await flush();const out=engine.read(['NVDA'],{lease:false})[0];
  assert.equal(out.price,base.price);assert.equal(out.src,base.src);assert.equal(out.quoteAt,postAt);assert.equal(out.recovery,true);
  assert.equal(out.charts?.intraday?.length||0,currency==='USD'?1:0);
  candidate={...base};engine.poke('NVDA');await flush();assert.equal(engine.read(['NVDA'],{lease:false})[0].recovery,undefined);
 }finally{engine.stop();}
});
test('recovery persistence accepts new independent history without downgrading the saved price',()=>{
 const recovery=createRecoveryStore({filePath:'',now:()=>now});
 // Use in-memory recovery with an explicit nonempty path; no flush performs I/O.
 const store=createRecoveryStore({filePath:'/unused-samples-regression/quotes.json',now:()=>now});
 store.load();assert.equal(store.remember(base),true);
 const next={...base,src:'tx-batch',price:218.29,quoteAt:regularAt,charts:{intraday:[{t:postAt/1000-60,c:218.26}]},slowFields:{intraday:{source:'nasdaq-intraday',timeContract:'nasdaq-label-et-v2',updatedAt:now,stale:false}}};
 assert.equal(store.remember(next),true);const saved=store.get('NVDA');assert.equal(saved.price,218.26);assert.equal(saved.charts.intraday.length,1);
 assert.equal(recovery.enabled,false);
});
test('history merge keeps newer verified families and never serializes a spurious update',()=>{
 const info={source:'fixture',updatedAt:now,stale:false},bars=[{t:postAt/1000,c:218.26}];
 const previous={...base,charts:{intraday:bars},slowFields:{intraday:info}};
 assert.strictEqual(mergeQuoteHistory(null,base),null);assert.strictEqual(mergeQuoteHistory(previous,{...previous,symbol:'SPY'}),previous);
 assert.strictEqual(mergeQuoteHistory(previous,structuredClone(previous)),previous);
 for(const meta of [{...info,stale:true},{...info,error:'offline'},{...info,updatedAt:now-1000},{...info,source:''}])assert.strictEqual(mergeQuoteHistory(previous,{...previous,slowFields:{intraday:meta}}),previous);
 assert.strictEqual(mergeQuoteHistory(previous,{...previous,charts:{intraday:[{t:regularAt/1000,c:218}]}}),previous);
 const daily=mergeQuoteHistory(base,{...base,charts:{daily30:bars},slowFields:{daily30:info}});assert.equal(daily.daily30Version,postAt/1000);assert.equal(daily.slowFields.charts.updatedAt,now);
 const weekly=mergeQuoteHistory(base,{...base,charts:{weekly:bars},slowFields:{weekly:info}});assert.equal(weekly.slowFields.charts.updatedAt,now);
});
