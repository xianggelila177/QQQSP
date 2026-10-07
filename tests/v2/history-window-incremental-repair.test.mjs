import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {aggregateHistory,periodBounds} from '../../lib/history-aggregate.js';
import {calendarRegistry} from '../../mkt.mjs';
import {historyData,fixtureAt} from './backend-repair-fixtures.mjs';

function fixture(calls,{floor='1980-01-01',update=value=>value}={}){
 return async(symbol,query,options)=>{
  const params=new URLSearchParams(query),from=new Date(Number(params.get('period1'))*1000).toISOString().slice(0,10),through=new Date(Number(params.get('period2'))*1000).toISOString().slice(0,10);
  calls.push({symbol,from,through,before:options.pageBefore});
  return update(historyData(symbol,{start:from>floor?from:floor,end:through<'2026-09-30'?through:'2026-09-30'}));
 };
}
function editDate(data,date,price){
 const index=data.timestamp.findIndex(t=>new Date(t*1000).toISOString().slice(0,10)===date);
 if(index>=0){const q=data.indicators.quote[0];q.close[index]=price;q.high[index]=Math.max(q.high[index],price);q.low[index]=Math.min(q.low[index],price);}
 return data;
}
function omitDate(data,date){
 const indices=data.timestamp.map((time,index)=>[new Date(time*1000).toISOString().slice(0,10),index]).filter(([day])=>day!==date).map(([,index])=>index);
 return {...data,timestamp:indices.map(i=>data.timestamp[i]),indicators:{quote:[Object.fromEntries(Object.entries(data.indicators.quote[0]).map(([key,values])=>[key,indices.map(i=>values[i])]))]}};
}
const queries={daily:{count:100},weekly:{count:79},monthly:{count:79},yearly:{count:39}};
async function readPeriods(service){
 const values={};for(const [period,query] of Object.entries(queries))values[period]=await service.get('NVDA',period,{...query,cacheOnly:true});return values;
}
function assertFullEquivalent(service,values,at){
 const raw=service.longCache.get('NVDA');
 for(const [period,value] of Object.entries(values)){
  const bars=aggregateHistory(raw.rows,period,{symbol:'NVDA',zone:raw.identity.exchangeTimeZone,asOf:at,requestedFrom:raw.from,listingDate:raw.listingDate,historyAsOf:raw.rows.at(-1).sessionDate}).map(bar=>{
   const missing=(raw.sourceInvalidDates||[]).filter(date=>periodBounds(date,period).periodStart===bar.periodStart);
   return missing.length?{...bar,coverageStatus:'partial',missingTradingDates:missing,qualityFlags:[...new Set([...bar.qualityFlags,'source-invalid-ohlc'])]}:bar;
  });
  assert.deepEqual(value.bars,bars.slice(-queries[period].count),period+' incremental output must equal a full rebuild');
 }
}

test('history repair: cold explicit cursors use the same bounded window and overlap contract as detached reads',async t=>{
 const coldCalls=[],warmCalls=[],cold=createHistoryService({now:()=>fixtureAt,fetchChart:fixture(coldCalls),maxDaily:1000}),warm=createHistoryService({now:()=>fixtureAt,fetchChart:fixture(warmCalls),maxDaily:1000});
 t.after(()=>{cold.close();warm.close();});
 await warm.get('NVDA','daily',{count:79});
 const query={count:12,before:'2000-01-01'},a=await cold.get('NVDA','monthly',query),b=await warm.get('NVDA','monthly',query);
 assert.equal(coldCalls[0].through,'2000-01-02');assert.equal(warmCalls.at(-1).through,'2000-01-02');
 assert.equal(a.returnedCount,12);assert.deepEqual(a.bars,b.bars);assert.deepEqual(a.overlapBars,b.overlapBars);assert.deepEqual(a.overlapBars,[]);
 assert.equal(a.historyAsOf,'1999-12-31');assert.equal(a.extent.satisfied,true);
 const latest=await cold.get('NVDA','monthly',{count:12});assert.equal(latest.bars.at(-1).periodStart,'2026-09-01');assert.equal(coldCalls.length,2);
});

test('history repair: rejected same-symbol expansion retains a bounded fresh projection without another fetch',async t=>{
 const calls=[],service=createHistoryService({now:()=>fixtureAt,fetchChart:fixture(calls)});t.after(()=>service.close());
 const first=await service.get('NVDA','monthly',{count:79}),old=service.longCache.get('NVDA');
 await service.get('SMALL','monthly',{count:12});const other=service.longCache.get('SMALL');
 await service.get('NVDA','yearly',{count:44});
 assert.ok(service.longCache.has('NVDA'));assert.equal(service.longCache.get('NVDA').from,old.from);assert.ok(service.longCache.get('SMALL')===other);
 assert.deepEqual((await service.get('NVDA','monthly',{count:79})).bars,first.bars);assert.equal(calls.filter(c=>c.symbol==='NVDA').length,2);
 assert.equal(service.diagnostics().admissionRejections,1);assert.equal(service.diagnostics().admissionProjections,1);assert.equal(service.diagnostics().evictions,0);
 assert.ok(service.diagnostics().bytes<=service.diagnostics().maxBytes);
});

for(const change of ['historical-price','split','identity','quality'])test('history repair: oversized '+change+' replaces old facts with the new bounded projection',async t=>{
 let revision=false;const calls=[],service=createHistoryService({now:()=>fixtureAt,fetchChart:fixture(calls,{update:data=>{
  if(!revision)return data;
  if(change==='historical-price')editDate(data,'2025-01-02',90);
  if(change==='split')data.events={splits:{one:{date:Date.parse('2025-01-02T16:00Z')/1000,numerator:2,denominator:1}}};
  if(change==='identity')data.meta.currency='EUR';
  if(change==='quality')data.historyQuality={reason:'source-invalid-ohlc',missingTradingDates:['2025-01-02']};
  return data;
 }})});t.after(()=>service.close());
 const first=await service.get('NVDA','monthly',{count:79});revision=true;
 if(change==='identity')await assert.rejects(service.get('NVDA','yearly',{count:44,seriesId:first.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
 else await service.get('NVDA','yearly',{count:44});
 const raw=service.longCache.get('NVDA');assert.ok(raw,'new source evidence must remain in a fitting projection');
 const next=await service.get('NVDA','monthly',{count:79});assert.equal(calls.length,2);
 if(change==='historical-price')assert.equal(raw.rows.find(r=>r.sessionDate==='2025-01-02').c,90);
 if(change==='split')assert.equal(raw.sourceEvents.splits.one.numerator,2);
 if(change==='identity'){assert.equal(next.currency,'EUR');assert.notEqual(next.seriesId,first.seriesId);await assert.rejects(service.get('NVDA','monthly',{count:79,seriesId:first.seriesId}),{code:'HISTORY_SERIES_CHANGED'});}
 if(change==='quality')assert.deepEqual(next.historyQuality.missingTradingDates,['2025-01-02']);
 assert.ok(service.diagnostics().bytes<=service.diagnostics().maxBytes);
});

test('history repair: one final-row update rebuilds only dirty periods and equals full aggregation',async t=>{
 let at=fixtureAt,price=101;const service=createHistoryService({now:()=>at,fetchChart:fixture([],{floor:'1990-01-01',update:data=>editDate(data,'2026-09-30',price)})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:39});const first=await readPeriods(service),before=service.diagnostics();
 price=102;at+=60001;await service.get('NVDA','yearly',{count:39});const next=await readPeriods(service),after=service.diagnostics();
 assert.equal(after.aggregateIncrementalBuilds-before.aggregateIncrementalBuilds,4);
 assert.equal(after.aggregateInputRows-before.aggregateInputRows,221);
 assert.equal(next.yearly.bars[0],first.yearly.bars[0]);assert.equal(next.monthly.bars.at(-1).c,102);assertFullEquivalent(service,next,at);
});

test('history repair: recent-tail updates reach long aggregates and unread periods coalesce safely',async t=>{
 let at=fixtureAt,price=101;const service=createHistoryService({now:()=>at,fetchChart:fixture([],{floor:'1990-01-01',update:data=>editDate(data,'2026-09-30',price)})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:39});await readPeriods(service);const before=service.diagnostics();
 for(const value of [102,103]){price=value;at+=60001;await service.get('NVDA','daily',{count:79});await service.get('NVDA','yearly',{count:39,cacheOnly:true});}
 const next=await readPeriods(service);assertFullEquivalent(service,next,at);assert.equal(next.yearly.bars.at(-1).c,103);
 assert.ok(service.diagnostics().aggregateIncrementalBuilds-before.aggregateIncrementalBuilds>=4);
});

test('history repair: incremental owners still update period clocks and invalidate on calendar changes',async t=>{
 let at=Date.parse('2026-09-30T19:58:00Z'),price=101;const service=createHistoryService({now:()=>at,fetchChart:fixture([],{floor:'1990-01-01',update:data=>editDate(data,'2026-09-30',price)})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:39});const first=await readPeriods(service);assert.equal(first.monthly.bars.at(-1).periodState,'open');
 price=102;at+=60001;await service.get('NVDA','yearly',{count:39});const next=await readPeriods(service);assertFullEquivalent(service,next,at);
 at=Date.parse('2026-09-30T20:00:01Z');const closed=await readPeriods(service);assert.equal(closed.monthly.bars.at(-1).periodState,'closed');assertFullEquivalent(service,closed,at);
 const version=calendarRegistry.version,before=service.diagnostics();
 try{calendarRegistry.version=version+'-incremental-repair';await assert.rejects(service.get('NVDA','monthly',{count:79,cacheOnly:true,seriesId:closed.monthly.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
  const revised=await service.get('NVDA','monthly',{count:79,cacheOnly:true});assert.notEqual(revised.seriesId,closed.monthly.seriesId);assert.equal(service.diagnostics().aggregateIncrementalBuilds,before.aggregateIncrementalBuilds);assert.ok(service.diagnostics().aggregateInputRows-before.aggregateInputRows>9000);
 }finally{calendarRegistry.version=version;}
});

for(const change of ['historical-price','split','quality','append'])test('history repair: '+change+' invalidates inherited period aggregates',async t=>{
 let at=fixtureAt,revision=false;
 const update=data=>{
  if(change==='append')return revision?data:omitDate(data,'2026-09-30');
  if(!revision)return data;
  editDate(data,'2026-09-30',103);
  if(change==='historical-price')editDate(data,'2026-09-28',90);
  if(change==='split')data.events={splits:{one:{date:Date.parse('2026-09-28T16:00Z')/1000,numerator:2,denominator:1}}};
  if(change==='quality')return {...omitDate(data,'2026-09-28'),historyQuality:{reason:'source-invalid-ohlc',missingTradingDates:['2026-09-28']}};
  return data;
 };
 const service=createHistoryService({now:()=>at,fetchChart:fixture([],{floor:'2024-01-01',update})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:39});await readPeriods(service);const before=service.diagnostics();
 revision=true;at+=60001;await service.get('NVDA','yearly',{count:39});const values=await readPeriods(service);
 const control=createHistoryService({now:()=>at,fetchChart:fixture([],{floor:'2024-01-01',update})});t.after(()=>control.close());
 await control.get('NVDA','yearly',{count:39});const expected=await readPeriods(control);
 for(const period of Object.keys(queries)){
  // Tail quality invalidation may retain an older observed row with an explicit
  // partial flag; a cold source can omit it. Compare that path to a full rebuild
  // of its retained raw evidence, rather than silently changing merge semantics.
  if(change!=='quality')assert.deepEqual(values[period].bars,expected[period].bars);
  assert.deepEqual(values[period].historyQuality,expected[period].historyQuality);
 }
 assertFullEquivalent(service,values,at);
 assert.equal(service.diagnostics().aggregateIncrementalBuilds,before.aggregateIncrementalBuilds);
 assert.ok(service.diagnostics().aggregateInputRows-before.aggregateInputRows>2000);
});
