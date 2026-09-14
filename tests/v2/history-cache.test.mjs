import test from 'node:test';import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
const now=Date.parse('2026-09-10T08:00:00Z');
const raw={meta:{symbol:'600000.SS',exchangeName:'SHH',exchangeTimezoneName:'Asia/Shanghai',currency:'CNY',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp:[Date.parse('2026-09-08T07:00:00Z')/1000,Date.parse('2026-09-09T07:00:00Z')/1000],indicators:{quote:[{open:[10,11],high:[12,13],low:[9,10],close:[11,12],volume:[100,120]}]}};
test('historical aggregation reused; optional source identity changes produce 409',async()=>{
 let source='yahoo',calls=0;const service=createHistoryService({now:()=>now,fetchChart:async()=>{calls++;return {...raw,source};}});
 const a=await service.get('600000.SS','weekly',{count:10});const b=await service.get('600000.SS','weekly',{count:10});
 assert.equal(a.revision,b.revision);assert.equal(calls,1);assert.equal(service.diagnostics().aggregateBuilds,1);assert.equal(service.diagnostics().byteAccounting,'raw+four-aggregate-reservation');
 source='sina';await assert.rejects(service.get('600000.SS','weekly',{count:10,force:true,seriesId:a.seriesId}),{code:'HISTORY_SERIES_CHANGED'});service.close();
});
test('A-share history can fall back to Sina without pretending full historical coverage',async()=>{
 const source=createHistorySource({primary:async()=>{throw Object.assign(new Error('429'),{status:429});},sina:async()=>[{t:1788937200,o:10,h:12,l:9,c:11,v:100}]});
 const result=await source('600000.SS','?interval=1d');assert.equal(result.source,'sina');assert.equal(result.retrievalLimited,true);
 assert.equal((await source('000001.SS','?interval=1d')).meta.instrumentType,'INDEX');
 await assert.rejects(source('QQQ','?interval=1d'));
});
