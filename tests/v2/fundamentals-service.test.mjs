import test from 'node:test';import assert from 'node:assert/strict';
import {createFundamentalsService} from '../../lib/fundamentals-service.js';
import {NOW,quote,record} from './fundamentals-fixture.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await wait(5);}assert.fail('financial task did not settle');}

test('quotes are decorated synchronously while one financial fetch runs in background',async t=>{
  let calls=0,resolve,updates=0;const service=createFundamentalsService({now:()=>NOW,fetchFundamentals:async symbol=>{calls++;await new Promise(r=>resolve=r);return record(symbol);},onUpdate:()=>updates++});
  t.after(()=>service.stop());service.start();const q=quote(),first=service.decorate(q);
  assert.equal(first.price,q.price);assert.equal(first.quoteAt,q.quoteAt);assert.equal(first.sourceCheckedAt,q.sourceCheckedAt);assert.equal(first.fundamentals.status,'loading');
  for(let i=0;i<30;i++)service.decorate(q);await until(()=>calls===1);resolve();await until(()=>updates===1);
  const final=service.decorate(q);assert.equal(final.fundamentals.fields.priceToBook.value,5.33);assert.equal(final.quoteAt,q.quoteAt);assert.equal(final.sourceCheckedAt,q.sourceCheckedAt);assert.equal(calls,1);
});
test('failed refresh retains dated facts until max age, respects cooldown and replaces fields atomically',async t=>{
  let now=NOW,calls=0,mode='ok';const service=createFundamentalsService({now:()=>now,ttlMs:60000,retryMs:60000,maxAgeMs:180000,fetchFundamentals:async symbol=>{calls++;if(mode==='fail')throw Object.assign(new Error('429'),{retryAt:now+120000});const r=record(symbol,now);if(mode==='partial')delete r.fields.priceToBook;return r;}});
  t.after(()=>service.stop());service.start();service.decorate(quote());await until(()=>service.diagnostics().inflight===0);assert.equal(calls,1);
  now+=60001;mode='fail';service.decorate(quote());await until(()=>service.diagnostics().inflight===0);
  let m=service.decorate(quote()).fundamentals;assert.equal(m.status,'stale');assert.equal(m.fields.priceToBook.value,5.33);assert.equal(calls,2);
  for(let i=0;i<20;i++)service.decorate(quote());assert.equal(calls,2);
  now=NOW+180000;assert.equal(service.decorate(quote()).fundamentals.fields.priceToBook.value,null);
  now=NOW+180002;mode='partial';service.decorate(quote());await until(()=>service.diagnostics().inflight===0);
  m=service.decorate(quote()).fundamentals;assert.equal(m.status,'ready');assert.equal(m.fields.priceToBook.value,null);assert.equal(calls,3);
});
test('disabled, pending, errors and nonsecurity quotes never request financial sources',async t=>{
  let calls=0;const service=createFundamentalsService({enabled:false,fetchFundamentals:async()=>{calls++;}});t.after(()=>service.stop());service.start();
  assert.equal(service.decorate(quote()).fundamentals.status,'disabled');await wait(10);assert.equal(calls,0);
  const other=createFundamentalsService({fetchFundamentals:async()=>{calls++;}});t.after(()=>other.stop());other.start();
  for(const q of [quote('AAOI',{instrumentType:'INDEX'}),quote('AAOI',{instrumentType:'FUTURE'}),{symbol:'AAOI',pending:true},{symbol:'AAOI',error:'offline'}])other.decorate(q);
  await wait(10);assert.equal(calls,0);
});
test('single active financial task, membership cancellation, stop and reopen are bounded',async t=>{
  let active=0,max=0,calls=0;const service=createFundamentalsService({fetchFundamentals:(symbol,{signal})=>new Promise((resolve,reject)=>{
    calls++;active++;max=Math.max(max,active);signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true});
  })});t.after(()=>service.stop());service.start();for(const symbol of ['AAOI','NVDA','AAPL'])service.decorate(quote(symbol));
  await until(()=>calls===1);assert.equal(max,1);assert.equal(service.diagnostics().queue.queued,2);
  service.retain([]);await until(()=>active===0);assert.equal(service.diagnostics().inflight,0);
  service.stop();assert.equal(service.diagnostics().running,false);service.start();service.decorate(quote());await until(()=>calls===2);assert.equal(max,1);
});
test('financial identity mismatch is rejected and cooled down without quote mutation',async t=>{
  let calls=0;const service=createFundamentalsService({now:()=>NOW,fetchFundamentals:async()=>{calls++;return record('NVDA');}});t.after(()=>service.stop());service.start();
  service.decorate(quote());await until(()=>service.diagnostics().inflight===0);
  const q=service.decorate(quote());assert.equal(q.fundamentals.fields.priceToBook.value,null);assert.equal(q.price,105.36);assert.equal(calls,1);assert.equal(service.diagnostics().failures,1);
});
