import test from 'node:test';import assert from 'node:assert/strict';
import {createSnapshotService} from '../../lib/snapshot-service.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<120;i++){if(fn())return;await pause(10);}assert.fail('condition timed out');}
test('cold first failure becomes an explicit error with retry time and then recovers',async()=>{
 let now=Date.parse('2026-09-17T13:40:00Z'),fail=true,calls=0;
 const service=createSnapshotService({now:()=>now,env:{POLL_MS:1000},sessionFor:()=> 'CLOSED',fetchBatch:async()=>{calls++;if(fail)throw Object.assign(Error('rate limited'),{status:429,retryAt:now+60000});return {quotes:[{symbol:'^N225',price:64136.25,currency:'JPY',instrumentType:'INDEX',src:'naver-index',quoteAt:now-60000,sourceCheckedAt:now,pollAfterMs:70000}],pollAfterMs:70000};},enrich:async()=>{throw Object.assign(Error('Yahoo 429'),{status:429,retryAt:now+60000});}});
 try{
  service.start();assert.equal(service.getCachedQuote('^N225').pending,true);
  await until(()=>calls>0);await pause(20);const error=service.getCachedQuote('^N225');assert.equal(error.pending,false);assert.equal(error.code,'RATE_LIMITED');assert.ok(error.retryAt>now);assert.equal(error.price,undefined);
  fail=false;now+=71000;await until(()=>service.getCachedQuote('^N225').price>0);const good=service.getCachedQuote('^N225');assert.equal(good.error,undefined);assert.equal(good.pending,undefined);assert.equal(good.price,64136.25);
 }finally{service.stop();}
});
test('non-batch source failure also stops claiming that the first request is still pending',async()=>{
 const now=Date.parse('2026-09-17T13:40:00Z');let attempted=false;
 const service=createSnapshotService({now:()=>now,env:{POLL_MS:1000},enrich:async()=>{attempted=true;throw Object.assign(Error('offline'),{retryAt:now+60000});}});
 try{service.start();service.getCachedQuote('VOD.L');await until(()=>attempted);await pause(10);assert.equal(service.getCachedQuote('VOD.L').pending,false);assert.ok(service.getCachedQuote('VOD.L').retryAt>now);}finally{service.stop();}
});
