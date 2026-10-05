import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {historyData,rangeSource,fixtureAt} from './backend-repair-fixtures.mjs';
import {calendarRegistry} from '../../mkt.mjs';
import {createHistorySource} from '../../lib/history-source.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {periodBounds,periodTiming} from '../../lib/history-aggregate.js';

test('R2 unknown calendar periods expire at local midnight across a DST change',()=>{
 const bounds=periodBounds('2026-10-31','daily'),before=Date.parse('2026-11-01T03:59:59Z');
 const options={symbol:'SPY',zone:'America/New_York',asOf:before,dayPlan:()=>({known:false})};
 const timing=periodTiming(bounds,options);assert.equal(timing.state,'unknown');
 assert.equal(timing.nextAt,Date.parse('2026-11-01T04:00:00Z'),'midnight precedes the offset change at 02:00');
 assert.equal(periodTiming(bounds,{...options,asOf:timing.nextAt}).state,'closed');
});

test('R2 ten thousand closed rows reuse aggregates across minute boundaries',async t=>{
 let clock=fixtureAt;
 const service=createHistoryService({now:()=>clock,fetchChart:async s=>historyData(s,{start:'1986-01-02',count:10000})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:39});
 await service.get('NVDA','daily',{count:79,before:'2026-10-01',cacheOnly:true});
 assert.equal(service.longCache.get('NVDA').rows.length,10000);
 const builds=service.diagnostics().aggregateBuilds;
 for(let i=0;i<3;i++){clock+=60000;const value=await service.get('NVDA','daily',{count:79,before:'2026-10-01',cacheOnly:true});assert.ok(value.bars.every(b=>b.periodState==='closed'));assert.equal(value.status,'stale');}
 assert.equal(service.diagnostics().aggregateBuilds-builds,0,'unchanged closed history must not rebuild');
});
for(const [period,date,before,after,state] of [
 ['daily','2026-11-27','2026-11-27T17:59:59Z','2026-11-27T18:00:00Z','open'],
 ['weekly','2026-10-02','2026-10-02T19:59:59Z','2026-10-02T20:00:00Z','open'],
 ['monthly','2026-09-30','2026-09-30T19:59:59Z','2026-09-30T20:00:00Z','open'],
 ['yearly','2026-12-31','2026-12-31T20:59:59Z','2026-12-31T21:00:00Z','open'],
 ['daily','2027-01-04','2027-01-04T20:00:00Z','2027-01-05T05:00:00Z','unknown']
])test('R2 only dynamic '+period+' state changes at '+after,async t=>{
 let clock=Date.parse(before);const service=createHistoryService({now:()=>clock,fetchChart:async s=>historyData(s,{start:date,end:date})});t.after(()=>service.close());
 const initial=await service.get('NVDA',period,{count:1}),builds=service.diagnostics().aggregateBuilds;
 assert.equal(initial.bars.at(-1).periodState,state);clock=Date.parse(after);
 const closed=await service.get('NVDA',period,{count:1,cacheOnly:true});
 assert.equal(closed.bars.at(-1).periodState,'closed');assert.equal(service.diagnostics().aggregateBuilds,builds);
 assert.equal(service.diagnostics().aggregateStateUpdates,1);assert.deepEqual(closed.bars[0].qualityFlags,initial.bars[0].qualityFlags);assert.notEqual(closed.revision,initial.revision);
});
test('R2 revisions, splits, source identity and calendar revisions invalidate stable aggregates',async t=>{
 let price=100,source='yahoo';
 const service=createHistoryService({now:()=>fixtureAt,fetchChart:async s=>({...historyData(s,{start:'2026-09-01',price,source}),events:price>100?{splits:{one:{date:1,numerator:2,denominator:1}}}:{}})});t.after(()=>service.close());
 const original=await service.get('NVDA','daily',{count:10});price=110;
 const corrected=await service.get('NVDA','daily',{count:10,force:true});assert.equal(corrected.bars.at(-1).c,111);assert.notEqual(corrected.revision,original.revision);
 source='fixture';await assert.rejects(service.get('NVDA','daily',{count:10,force:true,seriesId:original.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
 const latest=await service.get('NVDA','daily',{count:10,cacheOnly:true}),version=calendarRegistry.version;
 try{calendarRegistry.version=version+'-test';await assert.rejects(service.get('NVDA','daily',{count:10,cacheOnly:true,seriesId:latest.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
  const changed=await service.get('NVDA','daily',{count:10,cacheOnly:true});assert.equal(changed.calendarVersion,version+'-test');assert.equal(changed.bars.at(-1).c,111);
 }finally{calendarRegistry.version=version;}
});
test('R4 sparse histories expand, proven IPO stops, unknown exhaustion stays explicit',async t=>{
 const calls=[];const source=rangeSource(calls,{start:'2025-01-01'});
 const service=createHistoryService({now:()=>fixtureAt,fetchChart:async(s,q,o)=>{
  const data=await source(s,q,o);
  const indices=data.timestamp.map((_,i)=>i).filter(i=>i%4===0);
  return {...data,timestamp:indices.map(i=>data.timestamp[i]),indicators:{quote:[Object.fromEntries(Object.entries(data.indicators.quote[0]).map(([k,v])=>[k,indices.map(i=>v[i])]))]}};
 }});t.after(()=>service.close());
 const sparse=await service.get('SPARSE','daily',{count:79});assert.equal(sparse.bars.length,79);assert.ok(calls.length>1&&calls.length<=4);
 let ipoCalls=0;const ipo=createHistoryService({now:()=>fixtureAt,fetchChart:async s=>{ipoCalls++;const d=historyData(s,{start:'2026-09-28'});return {...d,meta:{...d.meta,firstTradeDate:d.timestamp[0]}};}});t.after(()=>ipo.close());
 const short=await ipo.get('IPO','daily',{count:79});assert.equal(ipoCalls,1);assert.equal(short.hasMore,false);assert.equal(short.bars.length,3);
 let missingCalls=0;const missing=createHistoryService({now:()=>fixtureAt,fetchChart:async s=>{missingCalls++;return historyData(s,{start:'2026-09-30'});}});t.after(()=>missing.close());
 const unknown=await missing.get('SPARSE','daily',{count:79});assert.equal(missingCalls,2);assert.equal(unknown.hasMore,null);assert.equal(unknown.coverage.sourceStopReason,'recent-expansion-budget');
 const again=await missing.get('SPARSE','daily',{count:79});assert.equal(missingCalls,2);assert.deepEqual(again.bars,unknown.bars);
});
test('R4 pagination remains ordered, bounded and preserves TWSE / TSM identities',async t=>{
 const calls=[],service=createHistoryService({now:()=>fixtureAt,fetchChart:async(s,q,o)=>{
  const data=await rangeSource(calls)(s,q,o);
  return s==='2330.TW'?{...data,source:'twse-stock-day',meta:{...data.meta,exchangeName:'TWSE',exchangeTimezoneName:'Asia/Taipei',currency:'TWD'}}:data;
 }});t.after(()=>service.close());
 for(const s of ['TSM','2330.TW']){
  const recent=await service.get(s,'daily',{count:79});const older=await service.get(s,'daily',{count:79,before:recent.nextBefore,seriesId:recent.seriesId});
  assert.equal(older.bars.length,79);assert.ok(older.bars.every(b=>b.periodStart<recent.nextBefore));assert.equal(older.currency,s==='TSM'?'USD':'TWD');assert.equal(older.symbol,s);
  assert.ok(older.warnings.includes('source-adjustment-unverified'));assert.equal((await service.get(s,'daily',{count:79})).bars.at(-1).c,recent.bars.at(-1).c);
 }
 const tiny=createHistoryService({maxBytes:1024,now:()=>fixtureAt,fetchChart:rangeSource([])});t.after(()=>tiny.close());await tiny.get('NVDA','daily',{count:79});assert.equal(tiny.diagnostics().entries,0);assert.equal(tiny.diagnostics().bytes,0);
});
test('R2 cached period states still close and revisions change at real boundaries',async t=>{
 let clock=Date.parse('2026-09-30T19:59:00Z');
 const service=createHistoryService({now:()=>clock,fetchChart:async s=>historyData(s,{start:'2026-09-30',end:'2026-09-30'})});t.after(()=>service.close());
 const before=await service.get('NVDA','daily',{count:1});clock=Date.parse('2026-09-30T20:01:00Z');
 const after=await service.get('NVDA','daily',{count:1,cacheOnly:true});
 assert.equal(before.bars[0].periodState,'open');assert.equal(after.bars[0].periodState,'closed');assert.notEqual(before.revision,after.revision);
});
test('R4 one hundred recent histories fit and a long read does not evict the recent working set',async t=>{
 const calls=[],service=createHistoryService({now:()=>fixtureAt,fetchChart:rangeSource(calls)});t.after(()=>service.close());
 const symbols=Array.from({length:100},(_,i)=>'W'+i);
 for(const s of symbols)assert.equal((await service.get(s,'daily',{count:79})).bars.length,79);
 const first=calls.length;
 for(const s of symbols)await service.get(s,'daily',{count:79});
 assert.equal(calls.length,first,'second recent scan should require no fetches');
 const recent=service.cache.get('W0');
 await service.get('W0','yearly',{count:39});
 assert.equal(service.cache.get('W0'),recent,'long raw data has a separate retention budget');
 const afterLong=calls.length;
 for(const s of symbols)await service.get(s,'daily',{count:79});
 assert.equal(calls.length,afterLong);assert.ok(service.diagnostics().bytes<=service.diagnostics().maxBytes);
});

test('R4 a new recent bar invalidates an otherwise fresh long-history projection',async t=>{
 let end='2026-09-29';
 const service=createHistoryService({now:()=>fixtureAt,fetchChart:async s=>historyData(s,{start:'2025-01-01',end})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:3});assert.equal(service.longCache.get('NVDA').rows.at(-1).sessionDate,end);
 end='2026-09-30';await service.get('NVDA','daily',{count:79,force:true});
 const latest=await service.get('NVDA','monthly',{count:12,cacheOnly:true});
 assert.equal(latest.historyAsOf,end,'a long cache hit cannot hide a newer observed trading date');
});

test('R4 an empty recent source window expands without bypassing another source cooldown',async t=>{
 let primaryCalls=0;const ranges=[];
 const alternative=createPublicHistory({now:()=>fixtureAt,httpsGet:async url=>{
  const parsed=new URL(url);if(!url.includes('nasdaq'))return {status:200,body:JSON.stringify({data:null})};
  const from=parsed.searchParams.get('fromdate');ranges.push(from);
  return {status:200,body:JSON.stringify({data:{symbol:'TSM',tradesTable:{rows:from<='2026-07-01'?[{date:'07/01/2026',open:'100',high:'102',low:'99',close:'101',volume:'1000'}]:[]}}})};
 }});
 const source=createHistorySource({now:()=>fixtureAt,alternative,primary:async()=>{primaryCalls++;throw Object.assign(Error('cooling'),{status:429,code:'HISTORY_RATE_LIMITED',retryAt:fixtureAt+120000});}});
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:source});t.after(()=>{history.close();source.close();});
 const out=await history.get('TSM','daily',{count:1});assert.equal(out.bars.length,1);assert.equal(out.historyAsOf,'2026-07-01');
 assert.equal(primaryCalls,1);assert.ok(ranges.length>1&&ranges.length<=4);assert.equal(out.currency,'USD');
 const before=ranges.length;await history.get('TSM','daily',{count:1});assert.equal(ranges.length,before);
});

test('R4 exhausted empty-window expansion remains bounded and negatively cached',async t=>{
 let calls=0;
 const history=createHistoryService({now:()=>fixtureAt,fetchChart:async()=>{calls++;throw Object.assign(Error('empty window'),{code:'HISTORY_EMPTY'});}});t.after(()=>history.close());
 await assert.rejects(history.get('TSM','daily',{count:79}),{code:'HISTORY_EMPTY'});assert.equal(calls,4);
 await assert.rejects(history.get('TSM','daily',{count:79}),{code:'HISTORY_EMPTY'});assert.equal(calls,4);
});
