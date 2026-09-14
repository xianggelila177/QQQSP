import test from 'node:test';import assert from 'node:assert/strict';
import {createFundamentalsService} from '../../lib/fundamentals-service.js';
import {NOW,quote} from './fundamentals-fixture.mjs';
const fact=value=>({value,status:'available'});
const record=(symbol,fields)=>({symbol,fields});
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('financial result did not arrive');};
test('partial primary and quote-embedded facts never suppress supplemental fields',async t=>{
 let release;const calls=[];const service=createFundamentalsService({now:()=>NOW,sources:[
  {id:'primary',fields:['priceToBook','sharesOutstanding'],load:async symbol=>{calls.push('primary');return record(symbol,{priceToBook:fact(5)});}},
  {id:'backup',fields:['priceToBook','peTTM','sharesOutstanding','week52High','week52Low'],load:async symbol=>{calls.push('backup');await new Promise(r=>release=r);return record(symbol,{priceToBook:fact(99),peTTM:fact(30),sharesOutstanding:fact(100000000),week52High:fact(250),week52Low:fact(10)});}}
 ]});t.after(()=>service.stop());service.start();const q=quote('AAOI',{week52High:null,week52Low:null,financials:{symbol:'AAOI',source:'primary',fetchedAt:NOW,fields:{priceToBook:fact(5)}}});
 assert.equal(service.decorate(q).fundamentals.fields.priceToBook.value,5);await until(()=>release);
 release();await until(()=>service.decorate(q).fundamentals.fields.peTTM.value===30);
 const out=service.decorate(q);assert.equal(out.fundamentals.fields.priceToBook.value,5);assert.equal(out.week52High,250);assert.equal(out.week52Low,10);assert.equal(out.fundamentals.fields.sharesOutstanding.value,100000000);
 assert.equal(out.fundamentals.fields.peTTM.backup,true);assert.equal(out.quoteAt,q.quoteAt);assert.equal(out.fundamentals.status,'partial');assert.equal(out.fundamentals.coverage.total,24);assert.ok(calls.includes('backup'));
});
test('independent source TTL, partial refresh, rate limit retention and recovery',async t=>{
 let now=NOW,mode='ok',quick=0,slow=0;const service=createFundamentalsService({now:()=>now,sources:[
  {id:'quick',fields:['priceToBook','sharesOutstanding'],ttlMs:60000,load:async s=>{quick++;if(mode==='fail')throw Object.assign(Error('limited'),{code:'RATE_LIMITED',retryAt:now+120000});return record(s,mode==='partial'?{priceToBook:fact(6)}:{priceToBook:fact(5),sharesOutstanding:fact(100000000)});}},
  {id:'slow',fields:['peTTM'],ttlMs:21600000,lane:'slow',load:async s=>{slow++;return record(s,{peTTM:fact(30)});}}
 ]});t.after(()=>service.stop());service.start();const q=quote();service.decorate(q);await until(()=>service.diagnostics().inflight===0);assert.equal(quick,1);assert.equal(slow,1);
 now+=60001;mode='partial';service.decorate(q);await until(()=>service.diagnostics().inflight===0);let out=service.decorate(q);assert.equal(out.fundamentals.fields.sharesOutstanding.value,100000000);assert.equal(out.fundamentals.fields.sharesOutstanding.fetchedAt,NOW);assert.equal(out.fundamentals.fields.sharesOutstanding.stale,true);assert.equal(slow,1);
 now+=60001;mode='fail';service.decorate(q);await until(()=>service.diagnostics().inflight===0);out=service.decorate(q);assert.equal(out.fundamentals.fields.priceToBook.value,6);assert.equal(out.fundamentals.fields.priceToBook.stale,true);
 for(let i=0;i<10;i++)service.decorate(q);assert.equal(quick,3);assert.ok(service.diagnostics().sources.quick.securities.AAOI.retryAt>now);
 now=service.diagnostics().sources.quick.securities.AAOI.retryAt+1;mode='ok';service.decorate(q);await until(()=>service.diagnostics().inflight===0);assert.equal(service.decorate(q).fundamentals.fields.priceToBook.stale,false);assert.equal(quick,4);
});
test('a stalled slow source does not block public sources and total concurrency stays bounded',async t=>{
 let active=0,max=0;const pending=[];const load=(s,{signal})=>new Promise((resolve,reject)=>{active++;max=Math.max(max,active);const finish=()=>{active--;resolve(record(s,{priceToBook:fact(5),peTTM:fact(20)}));};pending.push(finish);signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true});});
 const service=createFundamentalsService({sources:[{id:'slow',fields:['peTTM'],lane:'slow',load},{id:'fast',fields:['priceToBook'],load}]});t.after(()=>service.stop());service.start();for(const s of ['AAOI','NVDA','MRVL'])service.decorate(quote(s));await until(()=>active===2);assert.equal(max,2);pending[1]();await until(()=>pending.length===3);assert.equal(max,2);service.retain([]);await until(()=>active===0);assert.equal(service.diagnostics().inflight,0);
});
test('wrong-symbol, nonpositive shares and expired candidates cannot become valid values',async t=>{
 let now=NOW;const service=createFundamentalsService({now:()=>now,maxAgeMs:120000,sources:[{id:'wrong',fields:['priceToBook'],load:async()=>record('OTHER',{priceToBook:fact(500)})},{id:'good',fields:['priceToBook','sharesOutstanding'],load:async s=>record(s,{priceToBook:fact(5),sharesOutstanding:fact(-1)})}]});t.after(()=>service.stop());service.start();service.decorate(quote());await until(()=>service.diagnostics().inflight===0);let f=service.decorate(quote()).fundamentals;assert.equal(f.fields.priceToBook.value,5);assert.equal(f.fields.sharesOutstanding.value,null);now+=120001;service.stop();f=service.decorate(quote()).fundamentals;assert.equal(f.fields.priceToBook.value,null);
});
