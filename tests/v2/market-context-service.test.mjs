import test from 'node:test';import assert from 'node:assert/strict';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {createMarketContextService,parseContextQuery} from '../../lib/market-context-service.js';
const now=Date.parse('2026-09-18T14:00:00Z');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const q=(symbol='NVDA')=>({symbol,price:100,currency:'USD',instrumentType:'EQUITY',marketState:'REGULAR',quoteAt:now-1000,sourceCheckedAt:now,src:'fixture'});
test('context query validates ranges, single canonical identity, fields and defaults',()=>{
 const x=parseContextQuery({symbol:' nvda '});assert.equal(x.symbol,'NVDA');assert.equal(x.daily_bar_count,252);assert.equal(x.sample_trading_days,3);assert.equal(x.max_wait_ms,15000);
 for(const bad of [{symbol:'NVDA,SOXX'},{symbol:'https://evil.test'},{symbol:'NVDA',daily_bar_count:501},{symbol:'NVDA',sample_trading_days:4},{symbol:'NVDA',max_wait_ms:15001},{symbol:'NVDA',include:['secret']},{symbol:'NVDA',include:[]},{symbol:'NVDA',force:true},{symbol:'NVDA',format:'raw'},{symbol:'NVDA',daily_bar_count:'252'}])assert.throws(()=>parseContextQuery(bad),{code:'BAD_CONTEXT_QUERY'});
});
test('fresh quote is returned independently of stalled history within one deadline and browser subscriptions survive',async()=>{
 const engine=createQuoteEngine({readQuote:async s=>q(s),now:()=>now});engine.start();const browser=engine.watch(['QQQ']);let aborted=false;
 const service=createMarketContextService({engine,now:()=>now,history:{get:(_s,_p,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}))}});
 try{const started=performance.now();const out=await service.query(parseContextQuery({symbol:'NVDA',include:['quote','daily'],max_wait_ms:100}));assert.equal(out.status,'partial');assert.equal(out.sections.quote.data.price,100);assert.equal(out.sections.daily.status,'unavailable');assert.ok(performance.now()-started<350);assert.ok(aborted);assert.deepEqual(engine.diagnostics().active,['QQQ']);assert.equal(engine.diagnostics().subscribers,1);}finally{service.close();browser();engine.stop();}
});
test('samples and macro are cache reads; query neither subscribes nor changes collection membership',async()=>{
 let watched=0,macroCalls=0;const service=createMarketContextService({now:()=>now,engine:{watch(){watched++;throw Error('unexpected watch');}},samples:{snapshot:s=>({symbol:s,supported:true,tradingDays:['2026-09-18'],points:[],collecting:false})},macro:{snapshot(){macroCalls++;return {context:{factors:[],observedAt:now},news:{items:[]}};}}});
 try{const out=await service.query(parseContextQuery({symbol:'NVDA',include:['samples','macro']}));assert.equal(watched,0);assert.equal(macroCalls,1);assert.equal(out.sections.samples.rows.length,0);assert.ok(out.sections.samples.missing_reason);}finally{service.close();}
});
test('news projection reads existing cache and cannot create orphaned producers after a short query',async()=>{
 let starts=0,reads=0;const service=createMarketContextService({now:()=>now,news:{peek(){reads++;return {items:[],updatedAt:now,stale:false};},requestNews(){starts++;return new Promise(()=>{});}}});
 try{for(const symbol of ['NVDA','SOXX','^SOX']){const out=await service.query(parseContextQuery({symbol,include:['news'],max_wait_ms:10}));assert.equal(out.sections.news.status,'ready');}assert.equal(reads,3);assert.equal(starts,0);}finally{service.close();}
});
test('zero-wait queries only inspect caches without starting a temporary quote subscription',async()=>{
 let watches=0,pokes=0;const service=createMarketContextService({now:()=>now,engine:{watch(){watches++;},poke(){pokes++;},read:()=>[q()]}});
 try{const out=await service.query(parseContextQuery({symbol:'NVDA',include:['quote'],max_wait_ms:0}));assert.equal(out.sections.quote.data.price,100);assert.equal(watches,0);assert.equal(pokes,0);}finally{service.close();}
});
test('overdue checks get a bounded recovery opportunity without relabeling old data as newly checked',async()=>{
 const old={...q(),sourceCheckedAt:now-300000,checkIntervalMs:7000},engine=createQuoteEngine({readQuote:async()=>old,now:()=>now});engine.start();const service=createMarketContextService({engine,now:()=>now});
 try{const started=performance.now(),out=await service.query(parseContextQuery({symbol:'NVDA',include:['quote'],max_wait_ms:80}));assert.ok(performance.now()-started>=65);assert.equal(out.status,'partial');assert.equal(out.sections.quote.data.source_checked_at_ms,old.sourceCheckedAt);assert.equal(out.sections.quote.data.price,100);}finally{service.close();engine.stop();}
});
test('global queue is bounded, queue wait counts in deadline, disconnect releases only its temporary subscription',async()=>{
 const engine=createQuoteEngine({readQuote:()=>new Promise(()=>{}),now:()=>now});engine.start();const service=createMarketContextService({engine,now:()=>now});
 try{const query=parseContextQuery({symbol:'NVDA',include:['quote'],max_wait_ms:150}),first=service.query(query),second=service.query({...query,max_wait_ms:70}),third=service.query({...query,max_wait_ms:300}),secondCheck=assert.rejects(second,{code:'CONTEXT_TIMEOUT'});await assert.rejects(service.query(query),{code:'CONTEXT_BUSY'});await secondCheck;await first;await third;assert.equal(engine.diagnostics().subscribers,0);
 const controller=new AbortController(),pending=service.query({...query,max_wait_ms:1000},{signal:controller.signal});await pause(20);controller.abort();await assert.rejects(pending);assert.equal(engine.diagnostics().subscribers,0);
 }finally{service.close();engine.stop();}
});
test('stop cancels active and queued work and does not allow retained requests to restart network work',async()=>{
 const engine=createQuoteEngine({readQuote:()=>new Promise(()=>{}),now:()=>now});engine.start();const service=createMarketContextService({engine,now:()=>now});
 const a=service.query(parseContextQuery({symbol:'NVDA',include:['quote']})),b=service.query(parseContextQuery({symbol:'SOXX',include:['quote']}));
 const settled=Promise.allSettled([a,b]);await pause(20);service.close();assert.ok((await settled).every(r=>r.status==='rejected'));assert.equal(engine.diagnostics().subscribers,0);await assert.rejects(service.query(parseContextQuery({symbol:'QQQ'})),{code:'STOPPED'});engine.stop();
});
