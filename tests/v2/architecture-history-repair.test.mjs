import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {calendarRegistry} from '../../mkt.mjs';
import {historyData,fixtureAt,deferred,turn} from './backend-repair-fixtures.mjs';

function source(calls,{start='1980-01-01',wait=async()=>{},update=value=>value}={}){
 return async(symbol,query,options)=>{
  const p=new URLSearchParams(query),from=new Date(Number(p.get('period1'))*1000).toISOString().slice(0,10),through=new Date(Number(p.get('period2'))*1000).toISOString().slice(0,10);
  calls.push({symbol,from,through,before:options.pageBefore,signal:options.signal});await wait({symbol,options});
  const earliest=typeof start==='function'?start(symbol):start;
  return update(historyData(symbol,{start:from>earliest?from:earliest,end:through<'2026-09-30'?through:'2026-09-30'}));
 };
}

test('architecture A: concurrent disjoint history windows match the same reads made separately',async t=>{
 const calls=[],entered=deferred(),release=deferred();let block=false;
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls,{wait:async({options})=>{if(block&&options.pageBefore==='2020-01-01'){entered.resolve();await release.promise;}}})});
 t.after(()=>{release.resolve();history.close();});
 const seed=await history.get('NVDA','daily',{count:79}),first={count:12,before:'2020-01-01',seriesId:seed.seriesId},second={...first,before:'2025-01-01'};
 block=true;const older=history.get('NVDA','monthly',first);await entered.promise;
 const newer=history.get('NVDA','monthly',second);await turn();release.resolve();
 const [a,b]=await Promise.all([older,newer]);
 const serial=await history.get('NVDA','monthly',second);
 assert.equal(a.bars.at(-1).periodStart,'2019-12-01');
 assert.deepEqual(b.bars,serial.bars,'a different before cursor must not inherit another reader\'s interval');
 assert.equal(b.bars.at(-1).periodStart,'2024-12-01');assert.equal(b.seriesId,seed.seriesId);assert.equal(b.extent.satisfied,true);
});

test('architecture A: identical windows share a producer and one reader cancellation does not abort it',async t=>{
 const calls=[],entered=deferred(),release=deferred(),controller=new AbortController();
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls,{wait:async()=>{entered.resolve();await release.promise;}})});
 t.after(()=>{release.resolve();history.close();});
 const abandoned=history.get('NVDA','monthly',{count:12,before:'2025-01-01',signal:controller.signal});await entered.promise;
 const survivor=history.get('NVDA','monthly',{count:12,before:'2025-01-01'});await turn();
 const rejected=assert.rejects(abandoned,{code:'READER_GONE'});controller.abort(Object.assign(Error('reader gone'),{code:'READER_GONE'}));await rejected;
 assert.equal(calls[0].signal.aborted,false);release.resolve();
 assert.equal((await survivor).bars.at(-1).periodStart,'2024-12-01');assert.equal(calls.length,1);assert.equal(history.diagnostics().inflight,0);
});

test('architecture A: all readers cancel their producer without poisoning a later retry',async t=>{
 const calls=[],entered=deferred();let block=true;
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls,{wait:async({options})=>{if(!block)return;entered.resolve();await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}})});
 t.after(()=>history.close());const controller=new AbortController();
 const pending=history.get('NVDA','daily',{count:79,signal:controller.signal});await entered.promise;
 const rejected=assert.rejects(pending,{code:'READER_GONE'});controller.abort(Object.assign(Error('reader gone'),{code:'READER_GONE'}));await rejected;await turn();
 block=false;const value=await history.get('NVDA','daily',{count:79});assert.equal(value.bars.length,79);assert.equal(calls.length,2);assert.equal(history.diagnostics().failureEntries,0);
});

test('architecture A: an older cached window cannot satisfy a request through today',async t=>{
 const calls=[],history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls)});t.after(()=>history.close());
 const old=await history.get('NVDA','monthly',{count:12,before:'2020-01-01'});
 const current=await history.get('NVDA','monthly',{count:12});
 assert.equal(old.bars.at(-1).periodStart,'2019-12-01');assert.equal(current.bars.at(-1).periodStart,'2026-09-01');
});

test('architecture A: a detached window with a different source identity still returns 409',async t=>{
 let currency='USD';const calls=[],history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls,{update:value=>({...value,meta:{...value.meta,currency}})})});t.after(()=>history.close());
 const first=await history.get('NVDA','daily',{count:79});currency='EUR';
 await assert.rejects(history.get('NVDA','monthly',{count:12,before:'2020-01-01',seriesId:first.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
});

test('architecture A: a late old-window producer cannot replace a concurrently published current cache',async t=>{
 let at=fixtureAt;const entered=deferred(),release=deferred();
 const history=createHistoryService({now:()=>at,maxConcurrent:2,fetchChart:async(symbol,query,options)=>{
  const from=new Date(Number(new URLSearchParams(query).get('period1'))*1000).toISOString().slice(0,10);
  if(options.pageBefore==='2020-01-01'){entered.resolve();await release.promise;}
  return {...historyData(symbol,{start:from,end:options.pageBefore?'2019-12-31':'2026-09-30'}),sourceCheckedAt:at};
 }});t.after(()=>{release.resolve();history.close();});
 const older=history.get('NVDA','monthly',{count:12,before:'2020-01-01'});await entered.promise;at+=1000;
 const current=await history.get('NVDA','monthly',{count:12}),nearOwner=history.cache.get('NVDA'),longOwner=history.longCache.get('NVDA');
 at+=1000;release.resolve();assert.equal((await older).bars.at(-1).periodStart,'2019-12-01');
 const retained=await history.get('NVDA','monthly',{count:12,cacheOnly:true}),near=await history.get('NVDA','daily',{count:79,cacheOnly:true});
 assert.equal(retained.bars.at(-1).periodStart,'2026-09-01');assert.equal(near.sourceCheckedAt,current.sourceCheckedAt);
 assert.ok(history.cache.get('NVDA')===nearOwner);assert.ok(history.longCache.get('NVDA')===longOwner);
});

test('architecture B: an uncacheable long entry cannot evict admitted entries',async t=>{
 const calls=[],history=createHistoryService({now:()=>fixtureAt,fetchChart:source(calls,{start:s=>s==='SMALL'?'2020-01-01':'1980-01-01'})});t.after(()=>history.close());
 const small=await history.get('SMALL','monthly',{count:79}),owner=history.longCache.get('SMALL');
 const large=await history.get('JUMBO','yearly',{count:44});assert.equal(large.bars.length,44);
 assert.ok(history.longCache.get('SMALL')===owner,'reject oversized admission before removing any retained entries');
 assert.equal(history.longCache.has('JUMBO'),false);assert.equal(history.diagnostics().evictions,0);
 assert.deepEqual((await history.get('SMALL','monthly',{count:79})).bars,small.bars);
 assert.equal(calls.filter(c=>c.symbol==='SMALL').length,1);assert.ok(history.diagnostics().bytes<=history.diagnostics().maxBytes);
});

test('architecture A: queued contracts honor a source cooldown established by an earlier producer',async t=>{
 const calls=[],entered=deferred(),release=deferred();
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:async()=>{
  calls.push(1);entered.resolve();await release.promise;throw Object.assign(Error('rate limited'),{code:'HISTORY_RATE_LIMITED',status:429,retryAt:fixtureAt+120000});
 }});t.after(()=>{release.resolve();history.close();});
 const a=history.get('NVDA','monthly',{count:12,before:'2020-01-01'});await entered.promise;
 const b=history.get('NVDA','monthly',{count:12,before:'2025-01-01'}),results=Promise.allSettled([a,b]);await turn();release.resolve();
 for(const result of await results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'HISTORY_RATE_LIMITED');assert.equal(result.reason.retryAt,fixtureAt+120000);}
 assert.equal(calls.length,1,'a queued contract must recheck newly established source-wide cooldown');
});

test('architecture A: an ordinary failed detached window does not cool down a disjoint older interval',async t=>{
 const calls=[],fetchChart=source(calls,{wait:async({options})=>{if(options.pageBefore==='2025-01-01')throw Object.assign(Error('this window unavailable'),{code:'WINDOW_UNAVAILABLE'});}});
 const history=createHistoryService({now:()=>fixtureAt,fetchChart});t.after(()=>history.close());
 await history.get('NVDA','daily',{count:79});
 const failed=await history.get('NVDA','monthly',{count:12,before:'2025-01-01'});assert.equal(failed.errorCode,'WINDOW_UNAVAILABLE');
 const priorCalls=calls.length,older=await history.get('NVDA','monthly',{count:12,before:'2020-01-01'});
 assert.equal(calls.length,priorCalls+1);assert.equal(older.bars.at(-1).periodStart,'2019-12-01');assert.equal(older.errorCode,undefined);
});

test('architecture A: invalidation cancels every active window for one symbol',async t=>{
 const calls=[],bothStarted=deferred();
 const history=createHistoryService({now:()=>fixtureAt,maxConcurrent:2,fetchChart:source(calls,{wait:async({options})=>{
  if(calls.length===2)bothStarted.resolve();await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }})});t.after(()=>history.close());
 const a=history.get('NVDA','monthly',{count:12,before:'2020-01-01'}),b=history.get('NVDA','monthly',{count:12,before:'2025-01-01'}),results=Promise.allSettled([a,b]);
 await bothStarted.promise;history.invalidate('NVDA');
 for(const result of await results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'HISTORY_CANCELLED');}
 await turn();assert.equal(calls.length,2);assert.equal(history.diagnostics().inflight,0);assert.equal(history.diagnostics().failureEntries,0);
});

test('architecture A: total deadline releases readers but retains a still-running producer slot',async t=>{
 const calls=[],entered=deferred(),release=deferred();
 const history=createHistoryService({now:()=>fixtureAt,totalDeadlineMs:20,deadlineMs:1000,fetchChart:source(calls,{wait:async()=>{entered.resolve();await release.promise;}})});
 t.after(()=>{release.resolve();history.close();});
 const a=history.get('NVDA','daily',{count:79}),rejected=assert.rejects(a,{code:'HISTORY_TIMEOUT'});await entered.promise;await rejected;
 assert.equal(calls[0].signal.aborted,true);assert.equal(history.diagnostics().active,1);
 release.resolve();await turn();await turn();assert.equal(history.diagnostics().active,0);assert.equal(history.diagnostics().failureEntries,0);
});

test('architecture C: unchanged real tail refreshes reuse stable aggregation while clocks advance',async t=>{
 let at=fixtureAt;const calls=[],history=createHistoryService({now:()=>at,fetchChart:source(calls,{start:'1990-01-01'})});t.after(()=>history.close());
 const first=await history.get('NVDA','yearly',{count:39}),rows=history.longCache.get('NVDA').rows,builds=history.diagnostics().aggregateBuilds;
 assert.ok(rows.length>9000);
 for(let i=0;i<3;i++){
  at+=60001;const next=await history.get('NVDA','yearly',{count:39});
  assert.equal(next.revision,first.revision);assert.equal(next.sourceCheckedAt,at);assert.equal(next.stale,false);
  assert.equal(history.diagnostics().aggregateBuilds,builds,'unchanged source data must retain its stable aggregate owner');
  assert.equal(next.bars[0],first.bars[0]);assert.equal(history.longCache.get('NVDA').rows,rows);
 }
 assert.equal(calls.length,4);at+=60001;
 assert.equal((await history.get('NVDA','yearly',{count:39,cacheOnly:true})).stale,true);
});

test('architecture C: tail quality changes invalidate reused content and recovery clears missing-date metadata',async t=>{
 let at=fixtureAt,missing=false;const calls=[];
 const history=createHistoryService({now:()=>at,fetchChart:source(calls,{start:'2020-01-01',update:value=>{
  if(!missing)return value;const missingDate='2026-09-28';
  const indices=value.timestamp.map((time,index)=>[new Date(time*1000).toISOString().slice(0,10),index]).filter(([date])=>date!==missingDate).map(([,i])=>i);
  return {...value,timestamp:indices.map(i=>value.timestamp[i]),indicators:{quote:[Object.fromEntries(Object.entries(value.indicators.quote[0]).map(([key,values])=>[key,indices.map(i=>values[i])]))]},historyQuality:{reason:'source-invalid-ohlc',missingTradingDates:[missingDate]}};
 }})});t.after(()=>history.close());
 const first=await history.get('NVDA','monthly',{count:24}),builds=history.diagnostics().aggregateBuilds;
 missing=true;at+=60001;const partial=await history.get('NVDA','monthly',{count:24});
 assert.deepEqual(partial.historyQuality.missingTradingDates,['2026-09-28']);assert.notEqual(partial.revision,first.revision);assert.ok(history.diagnostics().aggregateBuilds>builds);
 missing=false;at+=60001;const recovered=await history.get('NVDA','monthly',{count:24});
 assert.equal(recovered.historyQuality,undefined);assert.ok(!recovered.bars.at(-1).qualityFlags.includes('source-invalid-ohlc'));
 assert.ok(recovered.warnings.includes('source-adjustment-unverified'));
});

test('architecture C: price corrections, event revisions, identity and calendar changes are never hidden',async t=>{
 let at=fixtureAt,price=100,split=0,currency='USD';const calls=[];
 const history=createHistoryService({now:()=>at,fetchChart:source(calls,{start:'2020-01-01',update:value=>{
  const q=value.indicators.quote[0];return {...value,meta:{...value.meta,currency},events:split?{splits:{one:{date:Date.parse('2026-09-28T16:00Z')/1000,numerator:split,denominator:1}}}:{},indicators:{quote:[{...q,open:q.open.map(()=>price),high:q.high.map(()=>price+2),low:q.low.map(()=>price-1),close:q.close.map(()=>price+1)}]}};
 }})});t.after(()=>history.close());
 const first=await history.get('NVDA','monthly',{count:24});
 price=110;at+=60001;const corrected=await history.get('NVDA','monthly',{count:24});assert.equal(corrected.bars.at(-1).c,111);assert.notEqual(corrected.revision,first.revision);
 split=2;at+=60001;await history.get('NVDA','monthly',{count:24});const afterSplit=history.diagnostics().aggregateBuilds;
 split=3;at+=60001;await history.get('NVDA','monthly',{count:24});assert.ok(history.diagnostics().aggregateBuilds>afterSplit,'a revised existing split is a content change');
 currency='EUR';at+=60001;await assert.rejects(history.get('NVDA','monthly',{count:24,seriesId:first.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
 const euro=await history.get('NVDA','monthly',{count:24,cacheOnly:true});assert.equal(euro.currency,'EUR');
 const oldVersion=calendarRegistry.version;
 try{calendarRegistry.version=oldVersion+'-architecture';await assert.rejects(history.get('NVDA','monthly',{count:24,cacheOnly:true,seriesId:euro.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
  const changed=await history.get('NVDA','monthly',{count:24,cacheOnly:true});assert.equal(changed.calendarVersion,calendarRegistry.version);
 }finally{calendarRegistry.version=oldVersion;}
});
