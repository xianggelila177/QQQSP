import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {contentHash} from '../../lib/history-contract.js';
import {normalizeVolume} from '../../lib/volume-normalizer.js';

const now=Date.parse('2026-09-23T01:30:00Z');
const source={source:'nasdaq-history',meta:{symbol:'NVDA',currency:'USD',exchangeName:'NASDAQ',
  exchangeTimezoneName:'America/New_York',instrumentType:'EQUITY',dataGranularity:'1d'},
  timestamp:[Date.parse('2026-09-21T12:00:00Z')/1000,Date.parse('2026-09-22T12:00:00Z')/1000],
  indicators:{quote:[{open:[100,101],high:[102,103],low:[99,100],close:[101,102],volume:[109806100,0]}]}};

test('verified US daily shares survive daily/weekly aggregation and legacy checkpoint restore',async t=>{
  const service=createHistoryService({now:()=>now,fetchChart:async()=>source});t.after(()=>service.close());
  const daily=await service.get('NVDA','daily',{count:2});
  assert.equal(daily.volumeUnit,'shares');
  assert.deepEqual(daily.bars.map(b=>b.v),[109806100,0]);
  const weekly=await service.get('NVDA','weekly',{count:1,cacheOnly:true});
  assert.equal(weekly.bars[0].v,109806100);
  assert.equal(weekly.bars[0].volumeCoverage.knownBars,2);
  const old=service.exportState();
  for(const item of old.entries){item.meta.identity.volumeUnit='source-unit-unverified';
    delete item.meta.identity.volumeRevision;item.meta.seriesId=contentHash(item.meta.identity);}
  const recovered=createHistoryService({now:()=>now,fetchChart:async()=>{throw new Error('must use checkpoint');}});
  t.after(()=>recovered.close());recovered.restore(old);
  const fromDisk=await recovered.get('NVDA','daily',{count:2,cacheOnly:true});
  assert.deepEqual(fromDisk.bars.map(b=>b.v),[109806100,0]);
  assert.equal(fromDisk.volumeUnit,'shares');
  assert.notEqual(fromDisk.seriesId,old.entries[0].meta.seriesId);
});

test('zero interval volume differs from missing and unknown unit is not relabeled shares',()=>{
  const args={source:'yahoo',market:'us',instrumentType:'ETF',kind:'interval'};
  assert.deepEqual([normalizeVolume({...args,rawVolume:0}).value,
    normalizeVolume({...args,rawVolume:null}).value],[0,null]);
  const unknown=normalizeVolume({...args,source:'eastmoney-history',rawVolume:100});
  assert.equal(unknown.value,null);
  assert.equal(unknown.missingReason,'VOLUME_UNIT_UNVERIFIED');
});
