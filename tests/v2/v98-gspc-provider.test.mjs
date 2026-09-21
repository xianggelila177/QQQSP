import test from 'node:test';
import assert from 'node:assert/strict';
import {providerCapabilities} from '../../lib/instruments.js';
import {createNaverIndexProvider,parseNaverIndexQuote,parseNaverIndexHistory} from '../../lib/providers/naver-index.js';
import {soxRow,json} from './semiconductor-fixture.mjs';

// Identity and the empty PREOPEN chart reproduce the public Naver responses
// observed on 2026-09-21. Other price bars below are explicit parser fixtures.
const now=Date.parse('2026-09-21T13:16:40Z');
const exchange={code:'NYS',zoneId:'EST5EDT',nationCode:'USA',delayTime:0};
const row={reutersCode:'.INX',symbolCode:'SPX',stockExchangeType:exchange,closePrice:'7,650.50',compareToPreviousClosePrice:'0.00',compareToPreviousPrice:{name:'UNCHANGED'},openPrice:'-',highPrice:'-',lowPrice:'-',marketStatus:'PREOPEN',localTradedAt:'2026-09-21T09:16:34-04:00'};
const basic={stockEndType:'index',reutersCode:'.INX',stockExchangeType:exchange,indexType:{symbolCode:'SPX',currencyType:null}};
const preopen={code:'.INX',infoType:'index',periodType:'day',stockExchangeType:'NYSE',lastClosePrice:7650.5,priceInfos:[],lastPriceInfos:[{localDateTime:'20260918160000',currentPrice:7650.5}]};
const daily=[{localDate:'20260918',openPrice:7600,highPrice:7700,lowPrice:7500,closePrice:7650.5}];

test('GSPC routes to the verified cash index and separates publication from retrieval time',()=>{
 assert.equal(providerCapabilities('^GSPC').batchGroup,'index');
 assert.deepEqual(providerCapabilities('^GSPC').batchProviders,['naver-index']);
 const q=parseNaverIndexQuote(row,'^GSPC',{now,pollAfterMs:70000});
 assert.equal(q.symbol,'^GSPC');assert.equal(q.price,7650.5);assert.equal(q.instrumentType,'INDEX');assert.equal(q.currency,'USD');
 assert.equal(q.src,'naver-index');assert.equal(q.quoteTimeBasis,'provider-published');assert.equal(q.quoteAt,Date.parse(row.localTradedAt));assert.equal(q.sourceCheckedAt,now);
 assert.equal(q.marketState,'PRE');assert.equal(q.providerMarketState,'PREOPEN');assert.equal(q.publicationSession,undefined,'SOX publishing hours must not apply to the S&P 500');
 for(const field of ['open','dayHigh','dayLow','volume'])assert.equal(q[field],null,field);
 assert.equal(q.feedDelayMinutes,0);assert.equal(q.pollAfterMs,70000);
});

test('GSPC rejects mismatched index identity and timezone without guessing other symbols',()=>{
 const q=override=>()=>parseNaverIndexQuote({...row,...override},'^GSPC',{now});
 for(const override of [{reutersCode:'.SOX'},{symbolCode:'SOX'},{stockExchangeType:{...exchange,code:'NSQ'}},{stockExchangeType:{...exchange,nationCode:'JPN'}}])assert.throws(q(override),/identity mismatch/);
 assert.throws(q({localTradedAt:'2026-09-21T09:16:34-05:00'}),/quote time zone mismatch/);
 assert.throws(()=>parseNaverIndexQuote(row,'^SPX',{now}),/unsupported symbol/);
 assert.throws(()=>parseNaverIndexHistory(daily,'^GSPC',{now,identity:{...basic,indexType:{...basic.indexType,currencyType:{code:'JPY'}}}}),/identity mismatch/);
 assert.throws(()=>parseNaverIndexHistory({...preopen,stockExchangeType:'NASDAQ'},'^GSPC',{now,minute:true}),/history identity mismatch/);
 const history=parseNaverIndexHistory(daily,'^GSPC',{now,identity:basic});
 assert.equal(history.meta.symbol,'^GSPC');assert.equal(history.meta.exchangeTimezoneName,'America/New_York');assert.equal(history.meta.currency,'USD');
});

test('GSPC preopen empty chart never promotes the previous session into current intraday bars',()=>{
 assert.throws(()=>parseNaverIndexHistory(preopen,'^GSPC',{now,minute:true}),/empty history/);
 const data={...preopen,priceInfos:[{localDateTime:'20260918093000',currentPrice:7600}]};
 const history=parseNaverIndexHistory(data,'^GSPC',{now,minute:true});
 assert.equal(history.timestamp[0],Date.parse('2026-09-18T13:30:00Z')/1000);assert.deepEqual(history.indicators.quote[0].volume,[null]);
});

test('GSPC uses .INX endpoints and follows source cadence only after the previous cache expires',async()=>{
 let clock=now,pollingInterval=70000;const urls=[];
 const provider=createNaverIndexProvider({now:()=>clock,httpsGet:async url=>{
  urls.push(url);
  if(url.includes('/worldstock/index/.INX'))return json({pollingInterval,datas:[row]});
  if(url.includes('/worldstock/index/.SOX'))return json({pollingInterval:7000,datas:[soxRow]});
  if(url.endsWith('/index/.INX/basic'))return json(basic);
  if(url.includes('/index/.INX/day?'))return json(daily);
  if(url.endsWith('/index/.INX?periodType=day'))return json(preopen);
  throw Error('Unexpected fixture endpoint '+url);
 }});
 try{
  assert.equal(provider.fetchChart.supports('^GSPC'),true);assert.equal(provider.fetchChart.supports('^SPX'),false);
  const initial=await provider.fetchSnapshotBatch(['^GSPC','^SOX']);
  assert.equal(initial.nextPollAtBySymbol['^GSPC'],clock+70000);assert.equal(initial.nextPollAtBySymbol['^SOX'],clock+7000);
  pollingInterval=7000;
  clock+=7100;const cached=await provider.fetchSnapshotBatch(['^GSPC','^SOX']);
  assert.equal(cached.nextPollAtBySymbol['^GSPC'],now+70000,'existing 70s cache must not be shortened');
  assert.equal(urls.filter(u=>u.includes('/worldstock/index/.INX')).length,1);assert.equal(urls.filter(u=>u.includes('/worldstock/index/.SOX')).length,2);
  clock=now+70001;const faster=await provider.fetchSnapshotBatch(['^GSPC']);assert.equal(urls.filter(u=>u.includes('/worldstock/index/.INX')).length,2);
  assert.equal(faster.pollAfterMs,7000);assert.equal(faster.nextPollAtBySymbol['^GSPC'],clock+7000);
  clock+=6999;await provider.fetchSnapshotBatch(['^GSPC']);assert.equal(urls.filter(u=>u.includes('/worldstock/index/.INX')).length,2);
  clock+=2;await provider.fetchSnapshotBatch(['^GSPC']);assert.equal(urls.filter(u=>u.includes('/worldstock/index/.INX')).length,3);
  assert.equal((await provider.fetchChart('^GSPC','?interval=1d&range=2y')).meta.symbol,'^GSPC');
  await assert.rejects(provider.fetchChart('^GSPC','?interval=5m&range=1d'),/empty history/);
 }finally{provider.close();}
});
