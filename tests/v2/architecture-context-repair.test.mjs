import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {deferred,turn,fixtureAt,quote} from './backend-repair-fixtures.mjs';
import Ajv2020 from '../support/schema-validator.mjs';
import {responseSchema} from '../../scripts/build-context-docs.mjs';
const validate=new Ajv2020({allErrors:true}).compile(responseSchema);

function blockedFixture({now=()=>fixtureAt,engine={read:([s])=>[quote(s)]}}={}){
 const blocker=deferred(),pending=[];
 const service=createMarketContextService({now,engine,news:{peek:()=>null,requestNews:()=>blocker.promise}});
 return {service,blocker,pending,async fill(count=3){for(const symbol of ['AAA','BBB','CCC'].slice(0,count)){const p=service.query({symbol,include:['news'],max_wait_ms:10000});p.catch(()=>{});pending.push(p);await turn();}},async close(){blocker.resolve({items:[],updatedAt:now()});service.close();await Promise.allSettled(pending);}};
}

test('E queue-full mixed request retains usable quote with source time and explicit missing section',async()=>{
 const f=blockedFixture();try{await f.fill();
  const out=await f.service.query({symbol:'NVDA',include:['quote','news'],max_wait_ms:1000});
  assert.equal(out.status,'partial');assert.equal(out.sections.quote.data.price,100);
  assert.equal(out.sections.quote.data.source_checked_at_ms,fixtureAt);
  assert.equal(out.sections.news.status,'unavailable');assert.equal(out.sections.news.missing_reason,'CONTEXT_BUSY');
  assert.ok(validate(out),JSON.stringify(validate.errors));
  assert.deepEqual(out.quality.missing_sections,['news']);assert.equal(f.service.diagnostics().active,1);assert.equal(f.service.diagnostics().queued,2);
 }finally{await f.close();}
});

test('E queue wait fallback rereads current cache and recalculates source freshness',async()=>{
 let at=fixtureAt,cached=quote('NVDA');const f=blockedFixture({now:()=>at,engine:{read:()=>[cached]}});
 try{await f.fill(1);const pending=f.service.query({symbol:'NVDA',include:['quote','news'],max_wait_ms:30});
  await turn();at+=120000;cached={...cached,price:101};
  const out=await pending;assert.equal(out.status,'partial');assert.equal(out.sections.quote.data.price,101);
  assert.equal(out.sections.quote.status,'partial');assert.equal(out.sections.quote.missing_reason,'SOURCE_CHECK_OVERDUE');
  assert.equal(out.sections.quote.data.source_checked_at_ms,fixtureAt);assert.equal(out.generated_at_ms,at);
  assert.equal(out.sections.news.missing_reason,'CONTEXT_TIMEOUT');
 }finally{await f.close();}
});

test('E busy without usable cache and cancelled readers retain their original errors',async()=>{
 const f=blockedFixture({engine:{read:([s])=>[{symbol:s,pending:true}]}});
 try{await f.fill();await assert.rejects(f.service.query({symbol:'NVDA',include:['quote','news']}),{code:'CONTEXT_BUSY'});}
 finally{await f.close();}
 const g=blockedFixture();try{await g.fill(1);const controller=new AbortController(),pending=g.service.query({symbol:'NVDA',include:['quote','news']},{signal:controller.signal});await turn();controller.abort();await assert.rejects(pending,{name:'AbortError'});}
 finally{await g.close();}
});

test('E fresh quote plus missing news does not invoke the real quote producer again',async()=>{
 const blocker=deferred();let calls=0;
 const engine=createQuoteEngine({now:()=>fixtureAt,tickMs:60000,eventCoalesceMs:0,readQuote:async s=>{calls++;return quote(s);}});
 engine.start();await engine.refreshNow(['NVDA']);calls=0;
 const service=createMarketContextService({now:()=>fixtureAt,engine,news:{peek:()=>null,requestNews:()=>blocker.promise}});
 const pending=service.query({symbol:'NVDA',include:['quote','news'],max_wait_ms:1000});pending.catch(()=>{});
 try{await turn();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,0);assert.equal(engine.diagnostics().subscribers,0);blocker.resolve({items:[],updatedAt:fixtureAt});const out=await pending;assert.equal(out.sections.quote.data.price,100);assert.equal(out.sections.news.status,'ready');}
 finally{blocker.resolve({items:[],updatedAt:fixtureAt});service.close();engine.stop();await Promise.allSettled([pending]);}
});

test('E fresh quote still refreshes when another engine section is missing',async()=>{
 let value=quote('NVDA'),pokes=0,watches=0;
 const engine={read:()=>[value],watch(){watches++;return()=>{};},poke(){pokes++;value={...value,fundamentals:{status:'ready',peRatio:20}};},subscribe:()=>()=>{}};
 const service=createMarketContextService({now:()=>fixtureAt,engine});
 try{const out=await service.query({symbol:'NVDA',include:['quote','fundamentals'],max_wait_ms:100});assert.equal(watches,1);assert.equal(pokes,1);assert.equal(out.sections.quote.data.price,100);}
 finally{service.close();}
});
