import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {deferred,turn,fixtureAt,quote} from './backend-repair-fixtures.mjs';
import {createNewsService} from '../../lib/news.js';

test('R3 cached quote bypasses occupied source-wait slots without watches or pokes',async()=>{
 const blocker=deferred();let watches=0,pokes=0,done=false;
 const service=createMarketContextService({now:()=>fixtureAt,news:{peek:()=>null,requestNews:()=>blocker.promise},engine:{read:([s])=>[quote(s)],watch(){watches++;return()=>{};},poke(){pokes++;}}});
 const slow=service.query({symbol:'QQQ',include:['news'],max_wait_ms:10000});const outcomes=[slow];
 try{await turn();const fast=service.query({symbol:'NVDA',include:['quote'],max_wait_ms:0}).then(v=>{done=true;return v;});outcomes.push(fast);fast.catch(()=>{});
  await turn();assert.equal(done,true,'cache read must finish before the slow producer');assert.equal((await fast).sections.quote.data.price,100);assert.equal(watches,0);assert.equal(pokes,0);
 }finally{blocker.resolve({items:[],updatedAt:fixtureAt});service.close();await Promise.allSettled(outcomes);}
});
test('R3 all slow slots can be occupied while zero, short and normal budget cache reads and batches finish',async()=>{
 const blocker=deferred();let starts=0;
 const service=createMarketContextService({maxActive:2,now:()=>fixtureAt,news:{peek:()=>null,requestNews:()=>{starts++;return blocker.promise;}},engine:{read:([s])=>[quote(s)]}});
 const slow=['QQQ','SPY'].map(symbol=>service.query({symbol,include:['news'],max_wait_ms:10}));
 try{await Promise.all(slow);assert.equal(starts,2);assert.equal(service.diagnostics().active,2,'timed-out readers must not release unfinished producers');
  for(const max_wait_ms of [0,5,500])assert.equal((await service.query({symbol:'NVDA',include:['quote'],max_wait_ms})).sections.quote.data.price,100);
  const batch=await service.query({symbols:Array.from({length:10},(_,i)=>'W'+i),include:['quote'],max_wait_ms:50});assert.equal(batch.results.length,10);assert.ok(batch.results.every(r=>r.sections.quote.data.price===100));assert.equal(starts,2);
 }finally{blocker.resolve({items:[],updatedAt:fixtureAt});await turn();service.close();}
});
test('R3 external cancellation also retains the source slot until producer completion',async()=>{
 const blocker=deferred(),controller=new AbortController();
 const service=createMarketContextService({now:()=>fixtureAt,news:{peek:()=>null,requestNews:()=>blocker.promise}});
 const pending=service.query({symbol:'QQQ',include:['news']},{signal:controller.signal});await turn();controller.abort();
 await assert.rejects(pending);assert.equal(service.diagnostics().active,1);
 blocker.resolve({items:[],updatedAt:fixtureAt});await turn();assert.equal(service.diagnostics().active,0);service.close();
});
test('R3 real news source coalesces the same key and removes both temporary subscribers',async()=>{
 const blocked=deferred();let calls=0;
 const news=createNewsService({now:()=>fixtureAt,newsLoader:async()=>{calls++;await blocked.promise;return [];}});
 const service=createMarketContextService({maxActive:2,news,now:()=>fixtureAt});
 const a=service.query({symbol:'NVDA',include:['news'],max_wait_ms:1000}),b=service.query({symbol:'NVDA',include:['news'],max_wait_ms:1000});
 try{await turn();assert.equal(calls,1);blocked.resolve();await Promise.all([a,b]);assert.equal(news.newsInflightNews.size,0);assert.equal(news.activeSyms.size,0);}finally{blocked.resolve();service.close();news.stopNews();}
});
