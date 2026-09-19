import test from 'node:test';import assert from 'node:assert/strict';
import {instrumentTypeFor,providerCapabilities} from '../../lib/instruments.js';
import {createNaverIndexProvider,parseNaverIndexQuote,parseNaverIndexHistory} from '../../lib/providers/naver-index.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {nikkeiUpstream,nikkeiNow} from './nikkei-fixture.mjs';
import {semiNow,soxRow,soxBasic,soxIntraday,soxDaily,semiUpstream} from './semiconductor-fixture.mjs';

test('SOXX is an authoritative ETF before any quote, even if a source calls it an equity',async()=>{
 assert.equal(instrumentTypeFor('SOXX'),'ETF');assert.equal(instrumentTypeFor('SOXX','EQUITY'),'ETF');
 const urls=[],fallback=createPublicHistory({now:()=>semiNow,httpsGet:async url=>{urls.push(url);return semiUpstream(url);}});
 const source=createHistorySource({primary:async()=>{throw Object.assign(Error('limited'),{status:429});},alternative:fallback,now:()=>semiNow});
 for(const query of ['?interval=5m&range=1d','?interval=1d&range=2y']){
  const chart=await source('SOXX',query);assert.equal(chart.meta.instrumentType,'ETF');assert.ok(chart.timestamp.length);assert.ok(chart.source.startsWith('nasdaq'));
 }
 assert.ok(urls.every(u=>new URL(u).searchParams.get('assetclass')==='etf'));
});
test('SOX index has its own verified route, unit and accurate summer/winter times',()=>{
 assert.equal(providerCapabilities('^SOX').batchGroup,'index');
 const q=parseNaverIndexQuote(soxRow,'^SOX',{now:semiNow,pollAfterMs:7000});
 assert.equal(q.price,11752.61);assert.equal(q.instrumentType,'INDEX');assert.equal(q.currency,'USD');assert.equal(q.volume,null);assert.equal(q.quoteAt,Date.parse(soxRow.localTradedAt));assert.equal(q.feedDelayMinutes,0);
 const summer=parseNaverIndexHistory(soxIntraday,'^SOX',{minute:true,now:semiNow});assert.equal(summer.timestamp[0],Date.parse('2026-09-18T13:30:00Z')/1000);
 const winter=parseNaverIndexHistory({...soxIntraday,priceInfos:[{localDateTime:'20260115093000',currentPrice:6500}]},'^SOX',{minute:true,now:semiNow});assert.equal(winter.timestamp[0],Date.parse('2026-01-15T14:30:00Z')/1000);
 const d=parseNaverIndexHistory(soxDaily,'^SOX',{now:semiNow,identity:soxBasic});assert.equal(d.meta.exchangeTimezoneName,'America/New_York');assert.equal(d.meta.instrumentType,'INDEX');
 assert.throws(()=>parseNaverIndexQuote({...soxRow,reutersCode:'.N225'},'^SOX',{now:semiNow}));
 assert.throws(()=>parseNaverIndexQuote({...soxRow,localTradedAt:'2026-09-18T10:15:34-05:00'},'^SOX',{now:semiNow}));
 assert.throws(()=>parseNaverIndexHistory({...soxIntraday,stockExchangeType:'TOKYO'},'^SOX',{minute:true,now:semiNow}));
});
test('SOX and Nikkei share the service without mixing identity, caches or 7s/70s cadence',async()=>{
 let clock=semiNow;const calls=[];
 const index=createNaverIndexProvider({now:()=>clock,httpsGet:async url=>{calls.push(url);return url.includes('.SOX')?semiUpstream(url):nikkeiUpstream(url);}});
 try{
  const first=await index.fetchSnapshotBatch(['^N225','^SOX']);assert.equal(first.quotes.length,2);assert.equal(first.quotes.find(q=>q.symbol==='^SOX').price,11752.61);assert.equal(first.nextPollAtBySymbol['^SOX'],clock+7000);assert.equal(first.nextPollAtBySymbol['^N225'],clock+70000);
  clock+=7100;await index.fetchSnapshotBatch(['^N225','^SOX']);assert.equal(calls.filter(u=>u.includes('.SOX')).length,2);assert.equal(calls.filter(u=>u.includes('.N225')).length,1);
  assert.equal((await index.fetchChart('^SOX','?interval=5m')).meta.symbol,'^SOX');assert.equal((await index.fetchChart('^N225','?interval=5m')).meta.symbol,'^N225');
 }finally{index.close();}
});
test('one failed index cannot block a healthy sibling; failure keeps its retry deadline',async()=>{
 const index=createNaverIndexProvider({now:()=>semiNow,httpsGet:async url=>url.includes('.SOX')?{status:429,headers:{'retry-after':'120'},body:'{}'}:nikkeiUpstream(url)});
 try{const r=await index.fetchSnapshotBatch(['^N225','^SOX']);assert.equal(r.quotes.find(q=>q.symbol==='^N225').price,64136.25);assert.equal(r.quotes.find(q=>q.symbol==='^SOX').code,'RATE_LIMITED');assert.ok(r.quotes.find(q=>q.symbol==='^SOX').pollAfterMs>=120000);}finally{index.close();}
});
test('a failed SOX quote can recover through the existing Yahoo fallback alongside healthy Nikkei',async()=>{
 const index=createNaverIndexProvider({now:()=>semiNow,httpsGet:async url=>url.includes('.SOX')?{status:503,body:'{}'}:nikkeiUpstream(url)});
 const calls=[],batch=createBatchProvider({now:()=>semiNow,indexProvider:index,fallbackQuote:async symbol=>{calls.push(symbol);return {symbol,price:11755,quoteAt:semiNow-1000,sourceCheckedAt:semiNow,instrumentType:'INDEX',currency:'USD',src:'yahoo'};}});
 try{const r=await batch.fetchSnapshotBatch(['^N225','^SOX'],{group:'index'});assert.equal(r.quotes.find(q=>q.symbol==='^SOX').src,'yahoo');assert.equal(r.quotes.find(q=>q.symbol==='^N225').src,'naver-index');assert.deepEqual(calls,['^SOX']);}finally{index.close();}
});
