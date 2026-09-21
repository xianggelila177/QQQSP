import test from 'node:test';
import assert from 'node:assert/strict';
import {createFastPolling} from '../../lib/providers/fast-polling.js';

test('a slow backup cannot promote another source cooldown into a 30 second quote freeze',async()=>{
 const start=Date.parse('2026-09-21T13:36:47Z');let now=start;
 const calls={sina:0,tencent:[],naver:0};
 const polling=createFastPolling({now:()=>now,pollMs:1000,
  httpsGet:async()=>{calls.sina++;return {status:429,headers:{'retry-after':'30'},body:''};},
  legacy:{tencent:async symbols=>{calls.tencent.push(now);return symbols.map(symbol=>({symbol,currency:'USD',src:'tx-batch',price:123.67,
   quoteAt:start-400000,sourceCheckedAt:now,pollAfterMs:1000}));},
   fetchSnapshotBatch:async()=>{calls.naver++;now+=1500;throw Object.assign(new Error('slow source unavailable'),{retryAfterMs:60000});}}
 });
 const first=await polling.fetchSnapshotBatch(['SOXL'],{group:'us'});
 assert.equal(first.quotes[0].src,'tx-batch');assert.equal(first.quotes[0].sourceCheckedAt,start);
 assert.equal(now,start+1500,'the backup completed after Tencent\'s first 1 second deadline');
 assert.ok(first.nextPollAtBySymbol.SOXL<=now+1000,'an expired fast deadline cannot be replaced by Sina\'s unrelated 30 second cooldown');
 // Drive subsequent reads at the deadline advertised to the outer scheduler.
 // Rechecking the cache must not bypass either failed source's Retry-After.
 now=first.nextPollAtBySymbol.SOXL;
 const second=await polling.fetchSnapshotBatch(['SOXL'],{group:'us'});
 assert.equal(second.quotes[0].sourceCheckedAt,now);assert.equal(calls.tencent.length,2);
 now=second.nextPollAtBySymbol.SOXL;
 const third=await polling.fetchSnapshotBatch(['SOXL'],{group:'us'});
 assert.equal(third.quotes[0].sourceCheckedAt,now);assert.equal(calls.tencent.length,3);
 assert.equal(calls.sina,1);assert.equal(calls.naver,1);
 assert.ok(calls.tencent[1]-calls.tencent[0]<=2500);assert.equal(calls.tencent[2]-calls.tencent[1],1000);
});
