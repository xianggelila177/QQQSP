import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinnhubRestPool} from '../../lib/providers/finnhub-rest.js';
import {createFinnhubHistory} from '../../lib/providers/finnhub-history.js';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {normalizeFinnhubQuote} from '../../lib/providers/finnhub-quotes.js';
import {createHistorySource} from '../../lib/history-source.js';
import {projectRegularBars} from '../../lib/regular-chart-service.js';
import {createHostGate} from '../../lib/host-gate.js';
import {createTransport} from '../../lib/transport.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';

const now=Date.parse('2026-09-23T04:00:00Z');
const at=text=>Date.parse(text)/1000;
const naverPayload={reutersCode:'AAOI.O',stockExchangeType:'NASDAQ',hasVolume:true,candleList:[
  {reutersCode:'AAOI.O',stockExchangeType:'NASDAQ',tradeAt:'2026-09-22T13:30Z',openPrice:105,highPrice:106,lowPrice:104,closePrice:105.5,tradingVolume:250072,accumulatedTradingVolume:702662},
  {reutersCode:'AAOI.O',stockExchangeType:'NASDAQ',tradeAt:'2026-09-22T20:00Z',openPrice:106,highPrice:107,lowPrice:105,closePrice:106.5,tradingVolume:695682,accumulatedTradingVolume:7380133},
]};

test('Finnhub candle entitlement denial leaves the same token available for quotes',async()=>{
  const paths=[];
  const gate=createHostGate({now:()=>now,minGap:()=>0});
  const transport=createTransport({now:()=>now,gate,upstream:async url=>{
    paths.push(url);return url.includes('/stock/candle')?{status:403,headers:{},body:'{"error":"denied"}'}:
      {status:200,headers:{},body:JSON.stringify({c:106,t:at('2026-09-22T20:00:00Z'),pc:105})};
  }});
  const pool=createFinnhubRestPool({tokens:['fixture_token_123456789'],now:()=>now,httpsGet:transport.httpsGet});
  const history=createFinnhubHistory({request:pool.request,now:()=>now});
  await assert.rejects(history('AAOI','?interval=5m&range=1d'),{code:'FINNHUB_DATASET_DENIED'});
  assert.equal(pool.diagnostics().availableTokens,1);
  assert.equal((await pool.request('/quote?symbol=AAOI')).status,200);
  await assert.rejects(history('AAOI','?interval=5m&range=1d'),{code:'FINNHUB_DATASET_DENIED'});
  assert.equal(paths.filter(p=>p.includes('/stock/candle')).length,1,'denied candles cool down independently');
  await transport.close();
});

test('a candle-only 403 tries another token without cooling either quote slot',async()=>{
  const pool=createFinnhubRestPool({tokens:['fixture_token_123456789','second_token_123456789'],now:()=>now,
    httpsGet:async(url,headers)=>url.includes('/stock/candle')&&headers['X-Finnhub-Token'].startsWith('fixture')?
      {status:403,headers:{},body:'{"error":"denied"}'}:{status:200,headers:{},body:'{"s":"no_data"}'}});
  assert.equal((await pool.request('/stock/candle?symbol=AAOI')).status,200);
  assert.equal(pool.diagnostics().availableTokens,2);
  assert.equal((await pool.request('/quote?symbol=AAOI')).status,200);
});

test('Naver interval tradingVolume wins over accumulated volume, including the closing bar',async()=>{
  const provider=createNaverWorldHistory({now:()=>now,resolveCode:async()=> 'AAOI.O',httpsGet:async url=>{
    assert.match(url,/\/chart\/foreign\/ITEM\/NASDAQ\/AAOI\.O\/interval\/5/);
    return {status:200,headers:{},body:JSON.stringify(naverPayload)};
  }});
  const start=at('2026-09-22T12:00:00Z'),end=at('2026-09-22T21:00:00Z');
  const chart=await provider('AAOI',`?interval=5m&period1=${start}&period2=${end}`);
  assert.deepEqual(chart.indicators.quote[0].volume,[250072,695682]);
  const q=chart.indicators.quote[0],bars=chart.timestamp.map((t,i)=>({t,o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]}));
  const regular=projectRegularBars('AAOI',bars,{source:chart.source,pointKind:'bar-close',targetDate:'2026-09-22',now});
  assert.equal(regular.volumeQuality.status,'ready');
  assert.equal(regular.volumeUnit,'shares');
  assert.equal(regular.bars.at(-1).t,at('2026-09-22T20:00:00Z'));
});

test('Finnhub quote carries source time and prior close without inventing volume',()=>{
  const q=normalizeFinnhubQuote('AAOI',{c:107,t:at('2026-09-22T23:59:00Z'),pc:105,o:106,h:110,l:103},{now});
  assert.equal(q.src,'finnhub-quote');assert.equal(q.priceSession,'POST');
  assert.equal(q.prevClose,105);assert.equal(q.previousCloseStatus,'source-aligned');
  assert.equal(q.volume,null);assert.equal(q.quoteAt,at('2026-09-22T23:59:00Z')*1000);
});

test('batch polling selects an available Finnhub quote before website backups',async()=>{
  const live=Date.parse('2026-09-22T15:00:00Z');
  const quote=normalizeFinnhubQuote('AAOI',{c:107,t:live/1000,pc:105},{now:live});
  const polling=createFastPolling({now:()=>live,pollMs:1000,httpsGet:async()=>({status:503,headers:{},body:''}),
    finnhubQuotes:async()=>[quote],legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})}});
  const result=await polling.fetchSnapshotBatch(['AAOI'],{group:'us'});
  assert.equal(result.quotes[0].src,'finnhub-quote');
  polling.reset();
});

test('manual source check bypasses a cached Finnhub quote and compares newer backup timestamps',async()=>{
  const live=Date.parse('2026-09-22T15:00:00Z');let calls=0;
  const finnhubQuotes=async()=>{
    calls++;return [normalizeFinnhubQuote('AAOI',{c:107,t:live/1000,pc:105},{now:live})];
  };
  const polling=createFastPolling({now:()=>live,pollMs:1000,httpsGet:async()=>({status:503,headers:{},body:''}),finnhubQuotes,
    legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})}});
  await polling.fetchSnapshotBatch(['AAOI'],{group:'us'});
  await polling.fetchSnapshotBatch(['AAOI'],{group:'us'});
  assert.equal(calls,1,'ordinary reads respect the source cache');
  await polling.fetchSnapshotBatch(['AAOI'],{group:'us',force:true});
  assert.equal(calls,2,'manual refresh rechecks the upstream');
  polling.reset();
});

test('US chart sequence prefers Finnhub; if denied, verified Naver interval volume beats Nasdaq price points',async()=>{
  const calls=[];
  const nasdaq={source:'nasdaq-intraday',retrievalLimited:true,meta:{symbol:'AAOI',currency:'USD',dataGranularity:'1m'},
    timestamp:[at('2026-09-22T13:30:00Z')],indicators:{quote:[{close:[105.5],volume:[null]}]}};
  const naver={source:'naver-world-chart',retrievalLimited:true,meta:{symbol:'AAOI',currency:'USD',dataGranularity:'5m'},
    timestamp:[at('2026-09-22T13:30:00Z')],indicators:{quote:[{close:[105.5],volume:[250072]}]}};
  const finnhub=async()=>{calls.push('finnhub');throw Object.assign(new Error('403'),{code:'FINNHUB_DATASET_DENIED',retryAt:now+900000});};
  finnhub.supports=()=>true;
  const world=async()=>{calls.push('naver');return naver;};world.supports=()=>true;
  const alternative=async()=>{calls.push('nasdaq');return nasdaq;};alternative.supports=()=>true;
  const history=createHistorySource({finnhub,world,alternative,primary:async()=>{calls.push('yahoo');throw Error('blocked');},now:()=>now});
  const result=await history('AAOI','?interval=5m&range=1d');
  assert.equal(result.source,'naver-world-chart');
  assert.deepEqual(calls.slice(0,3),['finnhub','nasdaq','naver']);
});
