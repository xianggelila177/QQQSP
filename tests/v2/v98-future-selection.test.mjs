import test from 'node:test';import assert from 'node:assert/strict';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';
const now=Date.parse('2026-09-21T13:28:00Z');
const quote=(extra={})=>({symbol:'SOXL',price:132.38,currency:'USD',instrumentType:'ETF',quoteAt:now-1000,sourceCheckedAt:now,src:'naver-us',pollAfterMs:7000,...extra});
const future=()=>quote({src:'tx-batch',price:123.67,quoteAt:Date.parse('2026-09-21T13:30:00Z')});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('future source timestamps cannot suppress backup polling or win over actual premarket data',async()=>{
 let backups=0;
 const polling=createFastPolling({now:()=>now,preferred:'tencent',httpsGet:async()=>({status:200,body:''}),legacy:{tencent:async()=>[future()],fetchSnapshotBatch:async()=>{backups++;return {quotes:[quote()]};}}});
 const result=await polling.fetchSnapshotBatch(['SOXL'],{group:'us'});
 assert.equal(result.quotes[0]?.src,'naver-us');assert.equal(result.quotes[0]?.price,132.38);assert.ok(backups>0);polling.reset();
});

test('engine never publishes a future price and accepts the corrected earlier timestamp',async()=>{
 let incoming=future();const engine=createQuoteEngine({now:()=>now,readQuote:async()=>incoming,tickMs:60000});
 engine.start();const unwatch=engine.watch(['SOXL']);
 try{
  await tick();let q=engine.read(['SOXL'],{lease:false})[0];assert.equal(q.price,undefined);assert.equal(q.code,'SOURCE_TIME_INVALID');
  incoming=quote();engine.tick();await tick();q=engine.read(['SOXL'],{lease:false})[0];assert.equal(q.price,132.38);assert.equal(q.quoteAt,now-1000);
  incoming=future();engine.tick();await tick();q=engine.read(['SOXL'],{lease:false})[0];assert.equal(q.price,132.38);assert.equal(q.quoteAt,now-1000);assert.equal(q.stale,true);
 }finally{unwatch();engine.stop();}
});
