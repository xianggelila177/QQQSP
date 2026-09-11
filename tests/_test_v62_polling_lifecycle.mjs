import assert from 'node:assert/strict';
import {createSnapshotService} from '../lib/snapshot-service.js';
import {loadApp} from './_harness.mjs';
let at=Date.parse('2026-09-06T00:00:00Z');
const service=createSnapshotService({now:()=>at,fetchBatch:async syms=>({quotes:syms.map(symbol=>({symbol,price:100,quoteAt:at,fetchedAt:at,marketState:'CLOSED'})),pollAfterMs:70000})});
try {
 service.start();service.getCachedQuote('AAPL');await new Promise(resolve=>setTimeout(resolve,140));
 assert.equal(service.getCachedQuote('AAPL').price,100);
 for(let n=0;n<3;n++){
  at+=120000;
  assert.equal(service.getCachedQuote('AAPL').pending,undefined,'economy cadence must not evict non-core snapshots');
 }
}finally{service.stop();}
const q={symbol:'AAPL',price:100,currency:'USD',marketState:'CLOSED',quoteAt:Date.now(),fetchedAt:Date.now(),pollAfterMs:70000,charts:{intraday:[]}};
const env=await loadApp({watchlist:['AAPL'],initialMarket:[q],hidden:true,refreshMode:'economy',fakeWorker:true});await env.drain();
const h=env.hooks();env.fetch.push('market',{body:[{symbol:'AAPL',pending:true,error:'waiting'}]});await h.refresh(false);
const before=env.countFetch('/api/market');env.fetch.push('market',{body:[q]});
for(let n=0;n<3;n++){h.onBeat();await env.drain();}
assert.ok(env.countFetch('/api/market')>before,'pending with retained quote reacquires rapidly, even hidden');
console.log('PASS economy/non-core snapshot lifetime and retained-pending fast reacquisition');
