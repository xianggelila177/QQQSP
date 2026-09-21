import test from 'node:test';import assert from 'node:assert/strict';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {sinaRow} from './source-fixtures.mjs';
test('v94 crossing a source TTL boundary inside one iteration cannot split a same-deadline batch',async()=>{
 const base=Date.parse('2026-09-10T14:00Z'),requests=[];let read=()=>base,n=0;
 const polling=createFastPolling({now:()=>read(),pollMs:1000,legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})},httpsGet:async url=>{requests.push(url);return {status:200,body:sinaRow('NVDA',{date:'2026-09-10 22:00:00',trade:'Sep 10 10:00AM EDT'})+sinaRow('LITE',{date:'2026-09-10 22:00:00',trade:'Sep 10 10:00AM EDT'})};}});
 await polling.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});assert.equal(requests.length,1);
 read=()=>base+999+(n++%2);await polling.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});
 assert.ok(requests.every(url=>url.includes('gb_nvda')&&url.includes('gb_lite')),JSON.stringify(requests));
 read=()=>base+1001;await polling.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});
 assert.equal(requests.length,2);assert.ok(requests.every(url=>url.includes('gb_nvda')&&url.includes('gb_lite')),JSON.stringify(requests));
});
