// Actual provider outputs cross the JSON boundary into the actual card renderer.
import assert from 'node:assert/strict';
import {createBatchProvider} from '../lib/providers/batch-snapshot.js';
import {createQuoteService} from '../lib/quote.js';
import {extSessions} from '../lib/sessions.js';
import {loadApp} from './_harness.mjs';
const now=()=>Date.parse('2026-09-05T12:00:00Z');
const at=Date.parse('2026-09-04T19:55:00-04:00');
const batch=createBatchProvider({now});
const naver=batch.parseNaverQuote({symbolCode:'QQQ',stockName:'QQQ',stockExchangeType:{code:'NSQ',nameEng:'NASDAQ',nationType:'USA'},closePrice:'100',compareToPreviousClosePrice:'1',localTradedAt:'2026-09-04T16:00:00-04:00',overMarketPriceInfo:{overPrice:'101',localTradedAt:'2026-09-04T20:00:00-04:00',tradingSessionType:'AFTER_MARKET'},currencyType:{code:'USD'}},'QQQ',70000);
const yahoo=await createQuoteService({now,extSessions,providers:{fetchChart:async()=>({meta:{symbol:'QQQ',currency:'USD',gmtoffset:-14400,regularMarketPrice:100,regularMarketTime:Date.parse('2026-09-04T16:00:00-04:00')/1000,instrumentType:'ETF'},timestamp:[at/1000],indicators:{quote:[{open:[101],high:[101],low:[101],close:[101],volume:[1]}]}}),getDayOhlc:async()=>({prevClose:99}),getFxRates:async()=>({}),getNasdaqDaily:async()=>[],getYahooDaily:async()=>[]}}).fetchQuote('QQQ');
const fields=Array(60).fill('');Object.assign(fields,{1:'QQQ',2:'QQQ.OQ',3:'101',4:'99',5:'100',6:'1000',30:'2026-09-04 19:55:00',33:'102',34:'99',35:'USD'});
const tencent=batch.parseTencentBatch('v_usQQQ="'+fields.join('~')+'";',['QQQ'])[0];
const env=await loadApp({watchlist:['QQQ']});await env.drain();const hooks=env.hooks();
for(const source of [naver,yahoo,tencent]) {
  const serialized=JSON.parse(JSON.stringify(source));
  assert.equal(serialized.marketState,'CLOSED');assert.equal(serialized.priceSession,'POST');
  env.fetch.push('market',{body:[serialized]});await hooks.refresh(false);
  const card=hooks.cardCache.get('QQQ');assert.equal(card.phasetag.textContent,'最近盘后报价');assert.equal(card.phasetag.hidden,false);
  if(source.src!=='tx-batch'){assert.equal(source.regularPrice,100);assert.match(card.extRow.innerHTML,/常规(?:时段)?收盘 100\.00/);assert.equal((card.extRow.innerHTML.match(/100\.00/g)||[]).length,1,'verified reference appears once');}
  if(source===naver)assert.match(card.extRow.innerHTML,/较本交易日常规收盘 100\.00/);
  if(source===yahoo)assert.match(card.extRow.innerHTML,/较昨收基准 99\.00/);
  if(source===tencent)assert.equal(source.regularPrice,null,'Tencent lacks a separately verified regular close in this snapshot');
}
console.log('PASS Naver/Yahoo/Tencent provider JSON preserves weekend quote sessions and verified regular price through actual card rendering');
