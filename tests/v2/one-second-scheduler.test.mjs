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
