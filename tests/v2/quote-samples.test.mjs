import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sampleTradingDays} from '../../lib/sample-calendar.js';
import {createSampleStore} from '../../lib/sample-store.js';
import {createQuoteSamples} from '../../lib/quote-samples.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';
const stamp=Date.parse,at=stamp('2026-09-11T14:00:00Z');
const quote=(t=at,overrides={})=>({symbol:'NVDA',price:218.26,quoteAt:t,sourceCheckedAt:t,src:'naver-us',currency:'USD',marketState:'REGULAR',priceSession:'REGULAR',...overrides});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const [date,expected] of [
 ['2026-09-13T13:00:00Z',['2026-09-09','2026-09-10','2026-09-11']],
 ['2026-09-14T07:59:00Z',['2026-09-09','2026-09-10','2026-09-11']],
 ['2026-09-14T08:00:00Z',['2026-09-10','2026-09-11','2026-09-14']],
 ['2026-09-07T14:00:00Z',['2026-09-02','2026-09-03','2026-09-04']],
 ['2026-11-02T08:59:00Z',['2026-10-28','2026-10-29','2026-10-30']],
 ['2026-11-02T09:00:00Z',['2026-10-29','2026-10-30','2026-11-02']],
 ['2026-11-27T19:00:00Z',['2026-11-24','2026-11-25','2026-11-27']],
])test('three started trading days at '+date,()=>assert.deepEqual(sampleTradingDays('NVDA',stamp(date)).tradingDays,expected));
test('unsupported futures and unknown calendar fail closed',()=>{
 assert.equal(sampleTradingDays('NQ=F',at).supported,false);
 assert.equal(sampleTradingDays('NVDA',stamp('2035-01-01T14:00:00Z')).supported,false);
});
test('minute last actual quote, deduplication, corrections, no stale/future/unknown data',()=>{
 let clock=at;const store=createSampleStore({now:()=>clock});
 assert.equal(store.accept(quote()),true);
 assert.equal(store.accept(quote(at,{sourceCheckedAt:at+1000})),false);
 clock+=20000;assert.equal(store.accept(quote(clock,{price:219})),true);
 assert.equal(store.snapshot('NVDA').points.length,1);assert.equal(store.snapshot('NVDA').points[0].c,219);
 assert.equal(store.accept(quote(clock,{price:219.01})),true);
 for(const overrides of [{recovery:true},{stale:true},{staleInfo:{reason:'offline-cache'}},{error:'bad'},{pending:true},{price:NaN},{currency:''},{src:''},{quoteAt:clock+6000},{quoteAt:clock-900000}])assert.equal(store.accept(quote(clock,overrides)),false);
 clock=at+120000;assert.equal(store.accept(quote(clock,{price:220})),true);
 const rows=store.snapshot('NVDA').points;assert.equal(rows.length,2);assert.equal(rows[1].t-rows[0].t,100);assert.equal(rows[0].v,null);assert.equal(rows[0].o,undefined);
});
test('delayed quotes retain source time and delay; first opening cannot backfill weekend closes',()=>{
 let clock=at+16*60000;const store=createSampleStore({now:()=>clock});
 assert.equal(store.accept(quote(at,{sourceCheckedAt:clock,feedDelayMinutes:15})),true);
 assert.equal(store.snapshot('NVDA').points[0].t,at/1000);
 clock=stamp('2026-09-13T13:00:00Z');assert.equal(store.accept(quote(at,{sourceCheckedAt:clock,marketState:'CLOSED'})),false);
});
test('window excludes an unobserved trading day rather than retaining older observed dates',()=>{
 let clock=stamp('2026-09-09T14:00:00Z');const store=createSampleStore({now:()=>clock});store.accept(quote(clock));
 clock=stamp('2026-09-11T14:00:00Z');store.accept(quote(clock));
 clock=stamp('2026-09-14T08:00:00Z');store.prune();
 assert.deepEqual(store.snapshot('NVDA').tradingDays,['2026-09-10','2026-09-11','2026-09-14']);
 assert.equal(store.snapshot('NVDA').points.length,1);assert.equal(store.snapshot('NVDA').coveredDays,1);
});
test('persist and restore preserve points, prune removed symbols and report write failures',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quote-samples-'));let clock=at;
 try{
  const a=createSampleStore({directory,now:()=>clock});await a.restore();a.accept(quote());await a.flush();
  const b=createSampleStore({directory,now:()=>clock});await b.restore();assert.equal(b.snapshot('NVDA').points.length,1);assert.equal(b.accept(quote()),false);
  const fail=createSampleStore({directory,now:()=>clock,writeFile:async()=>{throw Object.assign(Error('full'),{code:'ENOSPC'});}});await fail.restore();clock+=60000;fail.accept(quote(clock));await fail.flush();assert.equal(fail.diagnostics().saveError,'ENOSPC');
  clock=stamp('2026-09-17T14:00:00Z');b.prune();await b.flush();assert.equal(b.snapshot('NVDA').points.length,0);assert.deepEqual(await fs.readdir(directory),[]);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('malformed or symlink persisted files are not trusted and capacity stays bounded',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quote-samples-'));
 try{
  await fs.writeFile(path.join(directory,'4e564441--2026-09-11.json'),'{broken');
  const store=createSampleStore({directory,now:()=>at,maxBytes:700});await store.restore();assert.ok(store.diagnostics().loadError);assert.equal(store.snapshot('NVDA').points.length,0);
  for(let i=0;i<20;i++)store.accept(quote(at,{symbol:'S'+i}));assert.ok(store.diagnostics().bytes<=700);assert.ok(store.diagnostics().rejected>0);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('server membership survives zero browser clients and removal stops sampling',async()=>{
 let clock=at,list=['NVDA'],calls=0;
 const engine=createQuoteEngine({now:()=>clock,readQuote:async()=>{calls++;return quote(clock);},tickMs:60000});
 const samples=createQuoteSamples({engine,getWatchlist:()=>list,now:()=>clock,tickMs:60000});
 try{
  engine.start();await samples.start();await flush();samples.runDue();assert.equal(samples.snapshot('NVDA').points.length,1);
  const before=calls,unwatch=engine.watch(['NVDA']);await flush();assert.equal(calls,before);unwatch();
  clock+=60000;engine.poke('NVDA');await flush();samples.runDue();assert.equal(samples.snapshot('NVDA').points.length,2);
  list=[];samples.runDue();assert.equal(engine.diagnostics().active.length,0);clock+=60000;engine.poke('NVDA');await flush();assert.equal(samples.snapshot('NVDA').points.length,2);
  assert.equal(samples.snapshot('NVDA').collecting,false);
 }finally{await samples.stop();engine.stop();}
});
test('connected clients receive source-only and persistence error transitions without new prices',async()=>{
 let clock=at,broken=false,candidate=quote();
 const engine=createQuoteEngine({now:()=>clock,readQuote:async()=>candidate,tickMs:60000});
 const store=createSampleStore({now:()=>clock,directory:'/unused-sample-write',writeFile:async()=>{if(broken)throw Object.assign(Error('full'),{code:'ENOSPC'});}});
 const samples=createQuoteSamples({engine,store,getWatchlist:()=>['NVDA'],now:()=>clock,tickMs:60000}),events=[];
 samples.subscribe(rows=>events.push(...rows));
 try{
  engine.start();await samples.start();await flush();samples.runDue();clock+=60000;broken=true;candidate=quote(clock);engine.poke('NVDA');await flush();samples.runDue();await flush();await flush();
  assert.equal(events.at(-1).persistenceError,'ENOSPC');const before=events.at(-1).revision;
  candidate={...candidate,stale:true};engine.poke('NVDA');await flush();clock+=60000;samples.runDue();
  assert.equal(events.at(-1).status,'degraded');assert.ok(events.at(-1).revision>before);assert.equal(events.at(-1).points.length,0);
 }finally{await samples.stop();engine.stop();}
});
test('interrupting startup restore and restarting does not double-count retained bytes',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sample-start-'));
 const engine=createQuoteEngine({readQuote:async()=>quote(),now:()=>at,tickMs:60000});
 try{
  const saved=createSampleStore({directory,now:()=>at});saved.accept(quote());await saved.flush();
  const samples=createQuoteSamples({engine,directory,now:()=>at,getWatchlist:()=>['NVDA'],tickMs:60000});
  const started=samples.start();await samples.stop();await started;const bytes=samples.diagnostics().bytes;
  assert.ok(bytes>0);await samples.start();assert.equal(samples.diagnostics().bytes,bytes);await samples.stop();
 }finally{engine.stop();await fs.rm(directory,{recursive:true,force:true});}
});
test('capacity rejection is visible and clears after retained dates expire',()=>{
 let clock=at;const store=createSampleStore({now:()=>clock,maxBytes:1500});
 assert.equal(store.accept(quote()),true);clock+=60000;store.accept(quote(clock));clock+=60000;assert.equal(store.accept(quote(clock)),false);assert.ok(store.snapshot('NVDA').capacityError);
 clock=Date.parse('2026-09-17T14:00:00Z');store.prune();assert.equal(store.accept(quote(clock)),true);assert.equal(store.snapshot('NVDA').capacityError,null);
});
test('global-market samples preserve minor currency units without a hundred-fold conversion',()=>{
 const store=createSampleStore({now:()=>at});
 for(const [symbol,currency] of [['VOD.L','GBp'],['NPN.JO','ZAc']]){
  assert.equal(store.accept(quote(at,{symbol,currency,price:1000})),true);
  const saved=store.snapshot(symbol).points[0];assert.equal(saved.currency,currency);assert.equal(saved.c,1000);
 }
});
