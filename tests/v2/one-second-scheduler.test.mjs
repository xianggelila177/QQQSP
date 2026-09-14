import test from 'node:test';import assert from 'node:assert/strict';
import {createSnapshotService} from '../../lib/snapshot-service.js';
// Deterministic clock: no sleeping, external provider traffic, or changed tests.
async function withClock(run){
 const originals={setInterval,clearInterval,setTimeout,clearTimeout};const timers=new Map();let id=0,now=Date.parse('2026-09-10T14:00:00Z');
 globalThis.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms,once:true});return id;};globalThis.clearInterval=globalThis.clearTimeout=i=>timers.delete(i);
 const clock={now:()=>now,set:t=>{now=t;},advance:d=>{now+=d;},async tick(){for(const [id,t] of [...timers]){if(t.once)timers.delete(id);t.fn();}for(let i=0;i<25;i++)await Promise.resolve();}};
 try{await run(clock);}finally{Object.assign(globalThis,originals);}
}
test('one-second schedule counts from request start, not response finish; slow history cannot block quotes',()=>withClock(async clock=>{
 const start=clock.now(),calls=[];let release;
 const service=createSnapshotService({env:{POLL_MS:1000},now:clock.now,sessionFor:()=> 'REGULAR',fetchBatch:async symbols=>{calls.push(clock.now());clock.advance(200);return {quotes:symbols.map(symbol=>({symbol,price:100,quoteAt:clock.now(),sourceCheckedAt:clock.now(),currency:'USD',pollAfterMs:1000})),pollAfterMs:1000};},enrich:()=>new Promise(r=>release=r)});
 try{service.start();service.getCachedQuote('NVDA');await clock.tick();for(let i=1;i<5;i++){clock.set(start+i*1000);await clock.tick();}assert.deepEqual(calls.map(t=>t-start),[0,1000,2000,3000,4000]);}finally{service.stop();release?.(null);}
}));
test('opening resumes promptly but does not override a provider Retry-After',()=>withClock(async clock=>{
 let session='CLOSED',calls=0,limited=false;const start=clock.now();
 const service=createSnapshotService({env:{POLL_MS:1000},now:clock.now,sessionFor:()=>session,fetchBatch:async symbols=>{calls++;if(limited)throw Object.assign(new Error('429'),{status:429,retryAt:start+120000});return {quotes:symbols.map(symbol=>({symbol,price:100,quoteAt:clock.now(),currency:'USD',pollAfterMs:1000})),pollAfterMs:1000};}});
 try{service.start();service.getCachedQuote('NVDA');await clock.tick();assert.equal(calls,1);clock.advance(1000);await clock.tick();assert.equal(calls,1);session='REGULAR';await clock.tick();assert.equal(calls,2);
 limited=true;clock.advance(1000);await clock.tick();assert.equal(calls,3);session='CLOSED';clock.advance(1000);await clock.tick();session='REGULAR';clock.advance(1000);await clock.tick();assert.equal(calls,3);clock.set(start+120000);limited=false;await clock.tick();assert.equal(calls,4);
 }finally{service.stop();}
}));

// The outer scheduler and inner source TTL need one absolute deadline. A one
// millisecond phase difference must not turn a cached read into a two-second gap.
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {sinaRow} from './source-fixtures.mjs';
test('nested source TTL does not skip a second when batch and source starts differ by 1 ms',()=>withClock(async clock=>{
 const start=clock.now(),calls=[];let first=true;
 const polling=createFastPolling({now:clock.now,pollMs:1000,legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})},httpsGet:async()=>{
  calls.push(clock.now());return {status:200,body:sinaRow('NVDA',{date:'2026-09-10 22:00:00',trade:'Sep 10 10:00AM EDT'})};
 }});
 const service=createSnapshotService({env:{POLL_MS:1000},now:clock.now,sessionFor:()=> 'REGULAR',fetchBatch:(symbols,options)=>{
  if(first){clock.advance(1);first=false;}return polling.fetchSnapshotBatch(symbols,options);
 }});
 try{
  service.start();service.getCachedQuote('NVDA');await clock.tick();
  for(let elapsed=100;elapsed<=3300;elapsed+=100){clock.set(start+elapsed);await clock.tick();}
  assert.equal(calls.length,4,'the source must be checked four times, not skip a whole poll cycle');
  assert.deepEqual(calls.map(at=>at-start),[1,1100,2100,3100]);
  assert.ok(calls.slice(1).every((at,i)=>at-calls[i]>=1000&&at-calls[i]<=1200));
 }finally{service.stop();}
}));

test('absolute source deadlines keep a fallback at 1 s without bypassing primary Retry-After',()=>withClock(async clock=>{
 const start=clock.now(),primary=[],backup=[];
 const polling=createFastPolling({now:clock.now,pollMs:1000,legacy:{
  tencent:async symbols=>{backup.push(clock.now());return symbols.map(symbol=>({symbol,price:100,quoteAt:clock.now(),sourceCheckedAt:clock.now(),currency:'USD',pollAfterMs:1000}));},
  fetchSnapshotBatch:async()=>({quotes:[]})
 },httpsGet:async()=>{
  primary.push(clock.now());return clock.now()<start+120000?{status:429,headers:{'retry-after':'120'},body:''}:
   {status:200,body:sinaRow('NVDA',{date:'2026-09-10 22:02:00',trade:'Sep 10 10:02AM EDT'})};
 }});
 const service=createSnapshotService({env:{POLL_MS:1000},now:clock.now,sessionFor:()=> 'REGULAR',fetchBatch:polling.fetchSnapshotBatch});
 try{
  service.start();service.getCachedQuote('NVDA');await clock.tick();
  for(let elapsed=100;elapsed<=3300;elapsed+=100){clock.set(start+elapsed);await clock.tick();}
  assert.equal(primary.length,1,'rate-limited primary cannot be retried by the outer clock');
  assert.deepEqual(backup.map(at=>at-start),[0,1000,2000,3000]);
  clock.set(start+120000);await clock.tick();assert.deepEqual(primary.map(at=>at-start),[0,120000]);
 }finally{service.stop();}
}));
