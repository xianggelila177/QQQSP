import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSampleStore} from '../../lib/sample-store.js';
import {sampleTradingDays,sampleTradingDay} from '../../lib/sample-calendar.js';
import {calendarRegistry} from '../../mkt.mjs';
import {MAX_SAMPLE_SYMBOLS} from '../../lib/watchlist-limits.js';

const base=Date.parse('2026-09-30T14:30:00Z');
const quote=(at,extra={})=>({symbol:'NVDA',price:100,quoteAt:at,sourceCheckedAt:at,src:'fixture',currency:'USD',instrumentType:'EQUITY',priceSession:'REGULAR',...extra});
function measurePointReads(run){
 const values=Map.prototype.values;let reads=0;
 Map.prototype.values=function(){
  const iterator=values.call(this);
  return {next(){const item=iterator.next();if(!item.done&&item.value?._sample)reads++;return item;},[Symbol.iterator](){return this;}};
 };
 try{return {value:run(),reads};}finally{Map.prototype.values=values;}
}

test('sample admission skips retired sorting without pressure and still reclaims on capacity',()=>{
 let clock=base;const store=createSampleStore({now:()=>clock,maxSymbols:2});
 assert.equal(store.accept(quote(clock,{symbol:'OLD'})),true);
 clock+=1000;assert.equal(store.accept(quote(clock)),true);store.retain(['NVDA','AAPL']);
 const sort=Array.prototype.sort;let sortedItems=0;
 Array.prototype.sort=function(...args){sortedItems+=this.length;return sort.apply(this,args);};
 try{clock+=1000;assert.equal(store.accept(quote(clock)),true);}finally{Array.prototype.sort=sort;}
 assert.equal(sortedItems,0,'existing point fits both bounds; do not build/sort retired candidates');
 clock+=1000;assert.equal(store.accept(quote(clock,{symbol:'AAPL'})),true);
 assert.equal(store.diagnostics().retiredEvicted,1);
 assert.equal(store.snapshot('OLD').points.length,0);
 assert.equal(store.snapshot('NVDA').points.length,1);
});

test('sample calendar reuses an immutable window only within the same forward-moving minute and context',()=>{
 const context={instrumentType:'EQUITY',exchangeName:'cache-boundary-fixture'};
 const first=sampleTradingDays('NVDA',base,context);
 assert.strictEqual(sampleTradingDays('NVDA',base+20000,{...context}),first);
 assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.tradingDays));
 assert.throws(()=>first.tradingDays.push('2035-01-01'),TypeError);
 const reversed=sampleTradingDays('NVDA',base+10000,context);
 assert.notStrictEqual(reversed,first,'clock reversal discards the future observation');
 assert.strictEqual(sampleTradingDays('NVDA',base+11000,context),reversed);
 const nextMinute=sampleTradingDays('NVDA',base+60000,context);assert.notStrictEqual(nextMinute,reversed);
 assert.notStrictEqual(sampleTradingDays('NVDA',base+60000,{...context,instrumentType:'ETF'}),nextMinute);
 assert.notStrictEqual(sampleTradingDays('NVDA',base+60000,{...context,exchangeName:'other-venue'}),nextMinute);
 assert.notStrictEqual(sampleTradingDays('AAPL',base+60000,context),nextMinute);
});

test('sample window invalidates on calendar version and its cache remains bounded across securities',()=>{
 const context={exchangeName:'version-fixture'},oldVersion=calendarRegistry.version,closed=calendarRegistry.markets.us['2026'].closed;
 const before=sampleTradingDays('NVDA',base,context);
 try{
  calendarRegistry.version=String(oldVersion)+'-sample-test';closed.push('09-30');
  const after=sampleTradingDays('NVDA',base+1000,context);
  assert.notStrictEqual(after,before);assert.equal(after.tradingDays.at(-1),'2026-09-29');
 }finally{closed.pop();calendarRegistry.version=oldVersion;}
 assert.deepEqual(sampleTradingDays('NVDA',base+2000,context).tradingDays,before.tradingDays);
 const first=sampleTradingDays('CACHEOLD',base,context);
 assert.strictEqual(sampleTradingDays('CACHEOLD',base+500,context),first);
 for(let i=0;i<=MAX_SAMPLE_SYMBOLS*2;i++)sampleTradingDays('CACHE'+i,base,context);
 assert.notStrictEqual(sampleTradingDays('CACHEOLD',base+1000,context),first,'old security is evicted from the bounded cache');
});

test('window reuse preserves day/opening/DST changes and source timestamps keep second-level checks',()=>{
 for(const [before,after,expected] of [
  ['2026-09-14T07:59:59Z','2026-09-14T08:00:00Z',['2026-09-10','2026-09-11','2026-09-14']],
  ['2026-11-02T08:59:59Z','2026-11-02T09:00:00Z',['2026-10-29','2026-10-30','2026-11-02']],
  ['2026-09-30T23:59:59Z','2026-10-01T08:00:00Z',['2026-09-29','2026-09-30','2026-10-01']],
 ]){
  const old=sampleTradingDays('NVDA',Date.parse(before));
  const next=sampleTradingDays('NVDA',Date.parse(after));
  assert.notStrictEqual(next,old);assert.deepEqual(next.tradingDays,expected);
 }
 assert.equal(sampleTradingDay('^SOX',Date.parse('2026-09-30T13:30:00Z')),null);
 assert.equal(sampleTradingDay('^SOX',Date.parse('2026-09-30T13:30:01Z')),'2026-09-30');
 const checkedAt=Date.parse('2026-09-30T13:31:00Z'),store=createSampleStore({now:()=>checkedAt});
 const sourceAt=Date.parse('2026-09-30T13:30:00Z'),identity={symbol:'^SOX',instrumentType:'INDEX',sourceCheckedAt:checkedAt};
 assert.equal(store.accept(quote(sourceAt,identity)),false);
 assert.equal(store.accept(quote(sourceAt+1000,identity)),true,'cached window never replaces per-quote source-time validation');
 assert.equal(sampleTradingDays('NQ=F',base).supported,false);
 assert.equal(sampleTradingDays('NVDA',Date.parse('2035-01-01T14:30:00Z')).supported,false);
});

test('single-point and metadata-only sample deltas use point keys and bounded day summaries',()=>{
 let clock=base;const store=createSampleStore({now:()=>clock});store.retain(['NVDA']);
 for(const date of ['2026-09-28','2026-09-29','2026-09-30'])for(let i=0;i<12;i++){
  clock=Date.parse(date+'T14:00:00Z')+i*60000;assert.equal(store.accept(quote(clock,{price:100+i})),true);
 }
 store.takeUpdates();clock+=1000;assert.equal(store.accept(quote(clock,{price:200})),true);
 const all=store.snapshot('NVDA'),delta=measurePointReads(()=>store.takeUpdates());
 assert.equal(delta.reads,0,'delta must not enumerate unchanged minute Maps');
 assert.deepEqual(delta.value,[{...all,points:[all.points.at(-1)]}]);
 clock+=1000;store.touch('NVDA');const status=store.snapshot('NVDA'),metadata=measurePointReads(()=>store.takeUpdates());
 assert.equal(metadata.reads,0,'metadata-only touch must not enumerate history');
 assert.deepEqual(metadata.value,[{...status,points:[]}]);
 assert.equal(metadata.value[0].coveredDays,3);assert.equal(metadata.value[0].serverNow,clock);
});

test('restored unordered samples normalize order and preserve exact observation summaries on correction and prune',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sample-summary-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const date='2026-09-30';let clock=base+600000;const writes=[];
 const points=[2,0,1].map(i=>({t:base/1000+i*60,c:100+i,v:null,_sample:true,observedAt:base+600000-i*1000,sourceCheckedAt:base+600000-i*1000,source:'fixture',currency:'USD',tradingDate:date,priceSession:'REGULAR',feedDelayMinutes:15}));
 await fs.writeFile(path.join(directory,'4e564441--'+date+'.json'),JSON.stringify({schemaVersion:1,symbol:'NVDA',tradingDate:date,context:{instrumentType:'EQUITY'},points}));
 const store=createSampleStore({directory,now:()=>clock,writeFile:async(file,body)=>writes.push(JSON.parse(body))});await store.restore();
 let snapshot=store.snapshot('NVDA');assert.deepEqual(snapshot.points.map(p=>p.c),[100,101,102]);assert.equal(snapshot.firstObservedAt,base+598000);
 clock+=1000;assert.equal(store.accept(quote(base+140000,{price:200,sourceCheckedAt:clock,feedDelayMinutes:15})),true);
 snapshot=store.snapshot('NVDA');assert.equal(snapshot.firstObservedAt,base+599000);assert.equal(snapshot.lastObservedAt,clock);
 const delta=measurePointReads(()=>store.takeUpdates());assert.equal(delta.reads,0);assert.deepEqual(delta.value,[{...snapshot,points:[snapshot.points.at(-1)]}]);
 await store.flush();assert.deepEqual(writes[0].points.map(p=>p.c),[100,101,200]);
 clock=Date.parse('2026-10-06T14:30:00Z');store.prune();
 const empty=store.takeUpdates()[0];assert.deepEqual(empty.points,[]);assert.equal(empty.coveredDays,0);assert.equal(empty.firstObservedAt,null);assert.equal(empty.lastQuoteAt,null);assert.equal(store.diagnostics().bytes,0);
});

test('summary metadata expires by the visible calendar window even before pruning',()=>{
 let clock=Date.parse('2026-09-28T14:30:00Z');const store=createSampleStore({now:()=>clock});store.accept(quote(clock));store.takeUpdates();
 clock=Date.parse('2026-10-01T14:30:00Z');store.touch('NVDA');
 const value=store.takeUpdates()[0];assert.equal(value.coveredDays,0);assert.equal(value.firstObservedAt,null);assert.equal(value.lastObservedAt,null);assert.deepEqual(value.points,[]);
});

test('delta order survives eviction and same-symbol recreation after a clock reversal',()=>{
 let clock=base+60000;const store=createSampleStore({now:()=>clock,maxSymbols:1});store.retain(['NVDA']);store.accept(quote(clock));
 clock+=60000;store.accept(quote(clock));store.retain(['AAPL']);clock+=1000;store.accept(quote(clock,{symbol:'AAPL'}));
 store.retain(['NVDA']);clock=base;store.accept(quote(clock,{price:200}));clock+=60000;store.accept(quote(clock,{price:201}));
 const expected=store.snapshot('NVDA'),delta=store.takeUpdates().find(row=>row.symbol==='NVDA');
 assert.deepEqual(delta,expected);assert.deepEqual(delta.points.map(point=>point.c),[200,201]);
});

test('sample writes retain a concurrently updated dirty day and expose persistence failures on metadata deltas',async()=>{
 let clock=base,release,fail=false;const writes=[];
 const store=createSampleStore({now:()=>clock,directory:'unused-injected-writer',writeFile:async(file,body)=>{writes.push(JSON.parse(body));if(fail)throw Object.assign(Error('full'),{code:'ENOSPC'});if(writes.length===1)await new Promise(resolve=>{release=resolve;});}});
 store.accept(quote(clock));store.takeUpdates();const first=store.flush();
 clock+=1000;store.accept(quote(clock,{price:101}));release();await first;
 assert.equal(store.diagnostics().dirtyFiles,1);await store.flush();assert.equal(writes[0].points[0].c,100);assert.equal(writes[1].points[0].c,101);assert.equal(store.diagnostics().dirtyFiles,0);
 clock+=1000;store.accept(quote(clock,{price:102}));fail=true;await store.flush();store.takeUpdates();store.touch('NVDA');
 const delta=measurePointReads(()=>store.takeUpdates());assert.equal(delta.reads,0);assert.equal(delta.value[0].persistenceError,'ENOSPC');assert.equal(delta.value[0].lastObservedAt,clock);assert.deepEqual(delta.value[0].points,[]);
});
