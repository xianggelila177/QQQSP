import test from 'node:test';import assert from 'node:assert/strict';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {sinaRow} from './source-fixtures.mjs';
const base=Date.parse('2026-09-10T13:59:00Z');
const tick=()=>new Promise(r=>setImmediate(r));
test('one batch per second for healthy US siblings; neither Tencent nor Yahoo is polled unnecessarily',async()=>{
 let now=base,calls=0,backup=0;const source=createFastPolling({now:()=>now,httpsGet:async()=>{calls++;return {status:200,body:sinaRow('NVDA')+sinaRow('LITE')};},legacy:{tencent:async()=>{backup++;return [];},fetchSnapshotBatch:async()=>({quotes:[]})}});
 const first=await source.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});assert.equal(first.quotes.length,2);assert.equal(calls,1);assert.equal(backup,0);
 await source.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});assert.equal(calls,1);now+=1000;await source.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});assert.equal(calls,2);
});
test('primary 429 falls back; no repeated primary request during Retry-After',async()=>{
 let now=base,primary=0,backup=0;
 const source=createFastPolling({now:()=>now,httpsGet:async()=>{primary++;return {status:429,headers:{'retry-after':'120'}};},legacy:{tencent:async syms=>{backup++;return syms.map(symbol=>({symbol,price:10,quoteAt:now,sourceCheckedAt:now,src:'tx-batch',pollAfterMs:1000}));},fetchSnapshotBatch:async()=>({quotes:[]})}});
 const q=await source.fetchSnapshotBatch(['NVDA'],{group:'us'});assert.equal(q.quotes[0].src,'tx-batch');
 now+=1000;await source.fetchSnapshotBatch(['NVDA'],{group:'us'});now+=2000;await source.fetchSnapshotBatch(['NVDA'],{group:'us'});await tick();assert.equal(primary,1);assert.equal(backup,3);
 now+=120000;await source.fetchSnapshotBatch(['NVDA'],{group:'us'});assert.equal(primary,2);
});
test('Korean upstream polling hint survives; US adapter is never used for Korean ordinary shares',async()=>{
 let calls=0;const source=createFastPolling({httpsGet:async()=>{throw new Error('wrong source');},legacy:{fetchSnapshotBatch:async(symbols,{group})=>{calls++;assert.equal(group,'kr');return {quotes:[{symbol:symbols[0],pollAfterMs:7000}],pollAfterMs:7000};}}});
 assert.equal((await source.fetchSnapshotBatch(['000660.KS'],{group:'kr'})).pollAfterMs,7000);assert.equal(calls,1);
});
test('a slow unsupported sibling does not block healthy primary batch responses',async()=>{
 let release;const hung=new Promise(r=>release=r);let calls=0;
 const source=createFastPolling({now:()=>base,httpsGet:async()=>({status:200,body:sinaRow('NVDA')}),legacy:{tencent:async()=>{calls++;return hung;},fetchSnapshotBatch:async()=>({quotes:[]})}});
 const result=await Promise.race([source.fetchSnapshotBatch(['NVDA','SKHY'],{group:'us'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('blocked healthy ticker')),300))]);
 assert.equal(result.quotes[0].symbol,'NVDA');assert.equal(calls,1);release([]);await tick();
});
