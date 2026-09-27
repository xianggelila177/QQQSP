import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {instrumentTypeFor} from '../../lib/instruments.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createNasdaqPublicTrades} from '../../lib/providers/nasdaq-public-trades.js';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {createChartDetailService} from '../../lib/chart-detail-service.js';

const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/jepq.json',import.meta.url)));
const now=()=>Date.parse('2026-09-27T02:00:00Z');
const response=body=>({status:200,body:JSON.stringify(body)});
const dailyQuery='?interval=1d&period1='+Date.parse('2026-09-15T00:00Z')/1000+'&period2='+now()/1000;

test('JEPQ resolves to the verified Nasdaq ETF identity and uses the fund name',async()=>{
 assert.equal(instrumentTypeFor('JEPQ'),'ETF');
 const batch=createBatchProvider({now,httpsGet:async url=>{
  assert.match(url,/\/worldstock\/stock\/JEPQ\.O$/);return response(fixture.quote);
 }});
 try{
  const id=await batch.resolveNaverIdentity('JEPQ');
  assert.equal(id.code,'JEPQ.O');assert.equal(id.exchange,'NSQ');assert.equal(id.instrumentType,'ETF');
  const {quotes}=await batch.fetchSnapshotBatch(['JEPQ'],{group:'us'});
  assert.equal(quotes[0].name,'JPMorgan Nasdaq Equity Premium Income ETF');
  assert.equal(quotes[0].regularPrice,61.24);assert.equal(quotes[0].instrumentType,'ETF');
 }finally{batch.close();}
});

test('JEPQ daily and intraday Nasdaq routes use ETF, and changing type bypasses the old class failure cache',async()=>{
 let quoteType='EQUITY';const calls=[];
 const history=createPublicHistory({now,getQuote:()=>({instrumentType:quoteType}),httpsGet:async url=>{
  calls.push(url);const u=new URL(url),symbol=u.pathname.split('/')[3];
  assert.equal(u.hostname,'api.nasdaq.com');
  if(u.searchParams.get('assetclass')!=='etf')return response({data:null});
  const body=structuredClone(u.pathname.endsWith('/chart')?fixture.nasdaqChart:fixture.daily);
  body.data.symbol=symbol;return response(body);
 }});
 try{
  const daily=await history('JEPQ',dailyQuery);
  assert.equal(daily.meta.instrumentType,'ETF');assert.equal(daily.indicators.quote[0].close.at(-1),61.24);
  assert.equal((await history('JEPQ','?interval=5m&range=1d')).meta.instrumentType,'ETF');
  await assert.rejects(history('QNEW',dailyQuery));quoteType='ETF';
  const fixed=await history('QNEW',dailyQuery);
  assert.equal(fixed.meta.instrumentType,'ETF');assert.equal(fixed.timestamp.length,9);
  assert.ok(calls.filter(u=>u.includes('/JEPQ/')).every(u=>new URL(u).searchParams.get('assetclass')==='etf'));
 }finally{history.close();}
});

test('JEPQ verified Naver candles restore the latest regular chart and interval volume',async()=>{
 const world=createNaverWorldHistory({now,resolveCode:async()=>({code:'JEPQ.O',exchange:'NSQ',instrumentType:'ETF'}),
  httpsGet:async url=>{assert.match(url,/ITEM\/NASDAQ\/JEPQ\.O\/interval\/5/);return response(fixture.naverChart);}});
 const enrich=createChartEnricher({now,includeDaily:false,fetchChart:world,fetchHistoricalChart:world});
 try{
  const q=await enrich('JEPQ',{symbol:'JEPQ',instrumentType:'ETF',currency:'USD',price:61.26,regularPrice:61.24,
   regularQuoteAt:Date.parse('2026-09-25T20:00Z'),quoteAt:Date.parse('2026-09-26T00:00Z'),priceSession:'POST'});
  assert.equal(q.regularChart.tradeDate,'2026-09-25');assert.equal(q.regularChart.bars.length,78);
  assert.equal(q.regularChart.volumeQuality.knownBars,78);assert.equal(q.regularChart.source,'naver-world-chart');
 }finally{world.close();}
});

test('a newly observed ETF type reaches the chart source and detail tape before it is in the catalog',async()=>{
 const seen=[];
 const enrich=createChartEnricher({now,includeDaily:false,fetchChart:async(symbol,query,opts)=>{
  seen.push(opts.instrumentType);return {source:'naver-world-chart',meta:{symbol,currency:'USD',dataGranularity:'5m'},
   timestamp:[Date.parse('2026-09-25T14:00Z')/1000],indicators:{quote:[{open:[61],high:[62],low:[60],close:[61],volume:[1]}]}};
 }});
 await enrich('QNEW',{symbol:'QNEW',instrumentType:'ETF',currency:'USD',price:61});
 assert.deepEqual(seen,['ETF']);
 const detail=createChartDetailService({now,readQuote:()=>({symbol:'QNEW',instrumentType:'ETF'}),publicTape:{read:async(symbol,opts)=>{
  assert.equal(opts.instrumentType,'ETF');return {events:[]};}}});
 await detail.read('QNEW');
});

test('ETF tape routes correctly but rejects the real provider response dated one day too early',async()=>{
 const calls=[],tape=createNasdaqPublicTrades({now,httpsGet:async url=>{calls.push(url);return response(fixture.post);}});
 try{
  const stale=await tape.read('JEPQ',{session:'post',tradeDate:'2026-09-25'});
  assert.equal(new URL(calls[0]).searchParams.get('assetclass'),'etf');
  assert.equal(stale.reason,'SOURCE_DATE_MISMATCH');assert.equal(stale.events.length,0);assert.equal(stale.sourceTradeDate,'2026-09-24');
  await tape.read('QNEW',{session:'post',tradeDate:'2026-09-25',instrumentType:'ETF'});
  assert.equal(new URL(calls[1]).searchParams.get('assetclass'),'etf');
 }finally{tape.close();}
});
