import test from 'node:test';
import assert from 'node:assert/strict';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {createHistoryService} from '../../lib/history-service.js';

const now=Date.parse('2026-09-23T12:00:00Z');
const barAt=Date.parse('2026-09-22T13:30:00Z')/1000;
const quote=symbol=>({symbol,src:'fixture',price:100,currency:'USD',instrumentType:'EQUITY',
  quoteAt:now,priceSession:'PRE',charts:{}});

test('one symbol historical 429 does not cool another symbol or target date',async()=>{
 const calls=[];
 const enrich=createChartEnricher({now:()=>now,includeDaily:false,fetchChart:async()=>{throw new Error('current chart unavailable');},
  fetchHistoricalChart:async symbol=>{
   calls.push(symbol);
   if(symbol==='TSM')throw Object.assign(new Error('rate limited'),{status:429,retryAt:now+600000});
   return {source:'naver-world-chart',meta:{symbol,currency:'USD',dataGranularity:'5m',chartTimeBasis:'bar-start',chartIntervalSeconds:300},
    timestamp:[barAt],indicators:{quote:[{open:[100],high:[101],low:[99],close:[100],volume:[100]}]}};
  }});
 const tsm=await enrich('TSM',quote('TSM'));
 assert.equal(tsm.regularChart.status,'unavailable');
 const nvda=await enrich('NVDA',quote('NVDA'));
 assert.equal(nvda.regularChart.status,'ready');
 await enrich('TSM',quote('TSM'));
 assert.deepEqual(calls,['TSM','NVDA']);
 enrich.invalidate('TSM');await enrich('TSM',quote('TSM'));
 assert.deepEqual(calls,['TSM','NVDA','TSM']);
});

test('TWSE quote retains honest minute-history empty state and official daily bars',async()=>{
 const at=Date.parse('2026-09-25T08:00:00Z');
 const daily=[{t:Date.parse('2026-09-24T04:00:00Z')/1000,o:2480,h:2490,l:2470,c:2475,v:null}];
 const enrich=createChartEnricher({now:()=>at,includeDaily:false,
  fetchChart:async()=>{throw new Error('TWSE quote must not issue a minute history request');},
  fetchHistoricalChart:async()=>{throw new Error('No verified historical minute source');}});
 const result=await enrich('2330.TW',{symbol:'2330.TW',src:'twse-mis',price:2475,currency:'TWD',quoteAt:at,
  instrumentType:'EQUITY',priceSession:'REGULAR',charts:{intraday:[],daily30:daily},
  slowFields:{intraday:{source:'twse-mis',status:'no-history',unsupported:true,stale:false,retryable:false,
   updatedAt:null,missingReason:'NO_VERIFIED_MINUTE_HISTORY'},
   daily30:{source:'twse-stock-day',status:'ready',stale:false,updatedAt:at}}});
 assert.equal(result.slowFields.intraday.status,'no-history');
 assert.equal(result.regularChart.missingReason,'NO_VERIFIED_MINUTE_HISTORY');
 assert.equal(result.charts.daily30[0].c,2475);
 assert.equal(result.slowFields.daily30.source,'twse-stock-day');
});

test('TWSE daily history states its mixed-session source coverage without a fabricated volume',async()=>{
 const at=Date.parse('2026-09-25T08:00:00Z'),volumeScope='ordinary, odd-lot, after-hours fixed-price and block trades; not regular-only';
 const service=createHistoryService({now:()=>at,fetchChart:async()=>({source:'twse-stock-day',retrievalLimited:true,
  coverage:{firstTradingDate:'2026-09-24'},
  meta:{symbol:'2330.TW',currency:'TWD',exchangeName:'TWSE',exchangeTimezoneName:'Asia/Taipei',
   instrumentType:'EQUITY',dataGranularity:'1d',sourceVolumeCoverage:volumeScope},
  timestamp:[Date.parse('2026-09-24T04:00:00Z')/1000],
  indicators:{quote:[{open:[2480],high:[2490],low:[2470],close:[2475],volume:[null]}]}})});
 try{
  const result=await service.get('2330.TW','daily',{count:5});
  assert.equal(result.sessionScope,'source-mixed-sessions');
  assert.equal(result.coverage.sourceVolumeCoverage,volumeScope);
  assert.equal(result.coverage.firstTradingDate,'2026-09-24');
  assert.equal(result.bars[0].v,null);
 }finally{service.close();}
});

test('TWSE yearly before-page extends the same series without losing recent months',async()=>{
 let clock=Date.parse('2026-09-25T08:00:00Z');const calls=[];
 const dates=[];for(let year=2022;year<=2026;year++)for(let month=1;month<=12;month++){
  const date=`${year}-${String(month).padStart(2,'0')}-15`;
  if(date<='2026-09-15')dates.push(date);
 }
 const service=createHistoryService({now:()=>clock,fetchChart:async(_symbol,_query,options)=>{
  calls.push(options.pageBefore);
  const rows=dates.filter(date=>!options.pageBefore||date<options.pageBefore).slice(-12);
  const hasMore=dates.some(date=>date<rows[0]);
  return {source:'twse-stock-day',retrievalLimited:hasMore,hasMore,
   coverage:{firstTradingDate:rows[0]},
   meta:{symbol:'2330.TW',currency:'TWD',exchangeName:'TWSE',exchangeTimezoneName:'Asia/Taipei',
    instrumentType:'EQUITY',dataGranularity:'1d'},
   timestamp:rows.map(date=>Date.parse(date+'T04:00:00Z')/1000),
   indicators:{quote:[{open:rows.map(()=>100),high:rows.map(()=>101),low:rows.map(()=>99),
    close:rows.map(()=>100),volume:rows.map(()=>null)}]}};
 }});
 try{
  const recent=await service.get('2330.TW','yearly',{count:3});
  assert.equal(recent.hasMore,true);assert.equal(recent.nextBefore,'2025-01-01');
  const older=await service.get('2330.TW','yearly',{count:1,before:recent.nextBefore});
  assert.equal(older.bars[0].periodStart,'2024-01-01');
  assert.equal(older.seriesId,recent.seriesId);
  const combined=await service.get('2330.TW','yearly',{count:3});
  assert.deepEqual(combined.bars.map(bar=>bar.periodStart),['2024-01-01','2025-01-01','2026-01-01']);
  clock+=86400001;
  const refreshed=await service.get('2330.TW','yearly',{count:3});
  assert.deepEqual(refreshed.bars.map(bar=>bar.periodStart),['2024-01-01','2025-01-01','2026-01-01']);
  assert.deepEqual(calls,[null,'2025-10-15',null]);
 }finally{service.close();}
});
