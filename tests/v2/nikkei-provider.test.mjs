import test from 'node:test';import assert from 'node:assert/strict';
import {createNaverIndexProvider,parseNaverIndexQuote,parseNaverIndexHistory} from '../../lib/providers/naver-index.js';
import {providerCapabilities} from '../../lib/instruments.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createHistoryService} from '../../lib/history-service.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {nikkeiNow as now,nikkeiBasic,nikkeiSnapshot,nikkeiIntraday,nikkeiDaily,nikkeiUpstream} from './nikkei-fixture.mjs';

test('Nikkei has a verified index route distinct from Japanese equities, ETFs and futures',()=>{
 assert.equal(providerCapabilities('^N225').batchGroup,'index');assert.deepEqual(providerCapabilities('^N225').batchProviders,['naver-index']);
 for(const symbol of ['7203.T','1329.T','NQ00Y.FUT','^NDX'])assert.notEqual(providerCapabilities(symbol).batchGroup,'index');
});
test('index quote keeps provider timestamp, delay and point identity; no fabricated index-share volume',()=>{
 const q=parseNaverIndexQuote(nikkeiSnapshot().datas[0],'^N225',{now,pollAfterMs:70000});
 assert.equal(q.price,64136.25);assert.equal(q.prevClose,63923);assert.equal(q.instrumentType,'INDEX');assert.equal(q.currency,'JPY');assert.equal(q.currency2cny,null);assert.equal(q.volume,null);
 assert.equal(q.quoteAt,Date.parse('2026-09-17T15:45:03+09:00'));assert.equal(q.sourceCheckedAt,now);assert.equal(q.feedDelayMinutes,15);assert.equal(q.checkIntervalMs,70000);
 for(const patch of [{symbolCode:'TOPIX'},{reutersCode:'.N225.FUT'},{stockExchangeType:{code:'NYQ',zoneId:'America/New_York'}},{closePrice:''},{localTradedAt:'2026-02-30T15:00:00+09:00'},{localTradedAt:'2026-09-18T15:00:00+09:00'},{localTradedAt:'2026-09-17T15:00:00'}]){
  assert.throws(()=>parseNaverIndexQuote({...nikkeiSnapshot().datas[0],...patch},'^N225',{now}),/Naver|index|time|quote/i);
 }
});
test('Tokyo chart times and daily dates stay correct and unknown volumes remain absent',()=>{
 const intra=parseNaverIndexHistory(nikkeiIntraday,'^N225',{minute:true,now});assert.equal(intra.timestamp[0],Date.parse('2026-09-17T09:00:00+09:00')/1000);assert.equal(intra.timestamp.at(-1),Date.parse('2026-09-17T15:30:00+09:00')/1000);
 assert.ok(intra.indicators.quote[0].volume.every(v=>v===null));assert.equal(intra.meta.instrumentType,'INDEX');
 const daily=parseNaverIndexHistory(nikkeiDaily,'^N225',{minute:false,now,identity:nikkeiBasic});assert.equal(daily.meta.dataGranularity,'1d');assert.equal(daily.meta.exchangeTimezoneName,'Asia/Tokyo');
 assert.throws(()=>parseNaverIndexHistory({...nikkeiIntraday,code:'.TOPX'},'^N225',{minute:true,now}));
 assert.throws(()=>parseNaverIndexHistory(nikkeiDaily,'^N225',{minute:false,now,identity:{...nikkeiBasic,reutersCode:'.TOPX'}}));
 assert.throws(()=>parseNaverIndexHistory([{localDate:'20260917',openPrice:60000,highPrice:59000,lowPrice:61000,closePrice:64000}],'^N225',{now,identity:nikkeiBasic}));
});
test('index batch bypasses unsupported stock routes and shares the existing polling path',async()=>{
 const urls=[],index=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{urls.push(url);return nikkeiUpstream(url);}});
 const batch=createBatchProvider({now:()=>now,indexProvider:index,httpsGet:async()=>{throw Error('wrong stock route');}});
 const poll=createFastPolling({legacy:batch,now:()=>now,httpsGet:async()=>{throw Error('wrong Sina route');}});
 try{const r=await poll.fetchSnapshotBatch(['^N225'],{group:'index'});assert.equal(r.quotes[0].price,64136.25);assert.equal(r.quotes[0].pollAfterMs,70000);assert.equal(urls.length,1);}finally{index.close();}
});
test('Yahoo failure cannot block verified Nikkei history and larger ranges fetch correctly',async()=>{
 const urls=[],index=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{urls.push(url);return nikkeiUpstream(url);}});
 const source=createHistorySource({index:index.fetchChart,primary:async()=>{throw Object.assign(Error('rate limited'),{status:429});},now:()=>now});
 const history=createHistoryService({fetchChart:source,now:()=>now});
 try{
  const intra=await source('^N225','?interval=5m&range=1d');assert.equal(intra.source,'naver-index-history');
  for(const period of ['daily','weekly','monthly','yearly']){const r=await history.get('^N225',period,{count:5});assert.ok(r.bars.length>0,period);assert.equal(r.currency,'POINTS');}
  assert.ok(urls.some(u=>u.includes('/day?')));assert.ok(!urls.some(u=>u.includes('timeframe=week')));
 }finally{history.close();index.close();}
});
test('429 cooldown is honored, stop aborts work and malformed responses are rejected',async()=>{
 let clock=now,calls=0;const index=createNaverIndexProvider({now:()=>clock,httpsGet:async()=>{calls++;return {status:429,headers:{'retry-after':'120'},body:'{}'};}});
 try{
  await assert.rejects(index.fetchChart('^N225','?interval=5m'),e=>e.retryAt>=now+120000);
  await assert.rejects(index.fetchChart('^N225','?interval=5m'));assert.equal(calls,1);
  clock+=60000;await assert.rejects(index.fetchChart('^N225','?interval=5m'));assert.equal(calls,1);
  index.close();await assert.rejects(index.fetchChart('^N225','?interval=5m'),{code:'STOPPED'});
  index.reopen();clock+=120000;await assert.rejects(index.fetchChart('^N225','?interval=5m'));assert.equal(calls,2);
 }finally{index.close();}
});
test('cached quotes carry the exact source deadline across network latency and reconnects',async()=>{
 let clock=now,calls=0;
 const index=createNaverIndexProvider({now:()=>clock,httpsGet:async url=>{calls++;clock+=1200;return nikkeiUpstream(url);}});
 try{
  const first=await index.fetchSnapshotBatch(['^N225']);assert.equal(first.nextPollAtBySymbol['^N225'],now+71200);
  clock=now+70000;const cached=await index.fetchSnapshotBatch(['^N225']);assert.equal(calls,1);assert.equal(cached.nextPollAtBySymbol['^N225'],now+71200);assert.equal(cached.quotes[0].sourceCheckedAt,now+1200);
  clock=now+71200;await index.fetchSnapshotBatch(['^N225']);assert.equal(calls,2);
 }finally{index.close();}
});
