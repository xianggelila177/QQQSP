import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {parseSinaQuotes} from '../../lib/providers/sina-quotes.js';
import {publishQuote} from '../../lib/quote-contract.js';
import {createQuoteService} from '../../lib/quote.js';
import {regularTradingStatistics,mergeTradingStatistics} from '../../lib/trading-statistics.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';
import {sinaRow} from './source-fixtures.mjs';

const now=Date.parse('2026-09-25T08:25:00Z');
const raw=readFileSync(new URL('../fixtures/fundamentals-live/tencent.raw',import.meta.url)).toString('latin1');
const naver=JSON.parse(readFileSync(new URL('../fixtures/tsmc-naver.json',import.meta.url),'utf8')).quote.datas[0];
const parser=createBatchProvider({now:()=>now});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('Tencent regular snapshots retain source close, change and mainland book statistics',()=>{
  const quotes=parser.parseTencentBatch(raw,['161128.SZ','AAOI','LITE']);
  for(const [i,previous] of [7.173,103.29,935.7].entries()){
    const quote=quotes[i];
    assert.equal(quote.regularQuoteAt,quote.quoteAt);
    assert.equal(quote.prevClose,previous);
    assert.equal(quote.previousCloseStatus,'source-aligned');
    close(quote.changePct,(quote.price/previous-1)*100);
    assert.equal(regularTradingStatistics(quote).prevClose,previous);
  }
  assert.equal(quotes[0].tradingStats.orderImbalance.depth,5);
  const closing=parser.parseTencentBatch(raw.replace('20260914145406','20260914154139'),['161128.SZ'])[0];
  assert.equal(closing.prevClose,7.173);
  assert.equal(closing.previousCloseStatus,'source-aligned');
  assert.equal(closing.quoteTimeBasis,'provider-published');
  const fields=Array(90).fill('');
  Object.assign(fields,{1:'Tencent',2:'00700',3:400,4:399,5:398,6:100,30:'20260910140000',33:402,34:395});
  const hongKong=parser.parseTencentBatch(`v_hk00700="${fields.join('~')}";`,['0700.HK'])[0];
  assert.equal(hongKong.prevClose,399);
  assert.equal(hongKong.regularQuoteAt,hongKong.quoteAt);
});

test('Tencent PRE and CN auction timestamps do not become a confirmed regular reference',()=>{
  const pre=parser.parseTencentBatch(raw.replaceAll('2026-09-11 16:00:01','2026-09-14 08:30:00'),['AAOI'])[0];
  assert.equal(pre.priceSession,'PRE');
  assert.equal(pre.regularQuoteAt,null);
  assert.equal(pre.prevClose,null);
  const auction=parser.parseTencentBatch(raw.replace('20260914145406','20260914091500'),['161128.SZ'])[0];
  assert.equal(auction.regularQuoteAt,null);
  assert.equal(auction.prevClose,null);
});

test('Tencent legacy fallback retains verified regular references without requiring history',async()=>{
  let instant=Date.parse('2026-09-11T20:00:01Z');
  const cnAt=Date.parse('2026-09-14T06:54:06Z');
  const service=createQuoteService({now:()=>now,log:{info(){},debug(){},warn(){}},
    txQuoteSnapshot:async()=>({price:7.02,prevClose:7.173,ts:cnAt}),
    txMinuteBarsCn:async()=>[],txDailyBarsCn:async()=>[],getNasdaqDaily:async()=>[],
    usSnapshot:async()=>({price:105.36,prevClose:103.29,code:'AAOI.OQ',ts:instant,currency:'USD'})});
  const cn=await service.fallbackQuote('161128.SZ');
  assert.equal(cn.prevClose,7.173);assert.equal(cn.regularQuoteAt,cnAt);
  const regular=await service.fallbackQuote('AAOI');
  assert.equal(regular.prevClose,103.29);assert.equal(regular.regularQuoteAt,instant);
  instant=Date.parse('2026-09-14T12:30:00Z');
  const pre=await service.fallbackQuote('AAOI');
  assert.equal(pre.priceSession,'PRE');assert.equal(pre.prevClose,null);assert.equal(pre.regularQuoteAt,null);
});

test('Naver PRE headline and previous regular statistics retain separate close dates and values',()=>{
  const pre=parser.parseNaverQuote(naver,'TSM',7000);
  const regular=parser.parseNaverQuote({...naver,overMarketPriceInfo:null},'TSM',7000);
  for(const quote of [pre,publishQuote(pre),mergeTradingStatistics(pre,regular,{now})]){
    assert.equal(quote.price,453.97);assert.equal(quote.prevClose,451.15);
    assert.equal(quote.previousCloseTradeDate,'2026-09-24');
    const stats=regularTradingStatistics(quote);
    assert.equal(stats.prevClose,446.57);assert.equal(stats.tradeDate,'2026-09-24');
    assert.equal(stats.asOf,Date.parse('2026-09-24T20:00:00Z'));
    close(buildBasicMetrics(quote).fields.amplitude.value,(452.56-440.60)/446.57*100);
  }
  const shifted={...pre,regularQuoteAt:Date.parse('2026-09-25T20:00:00Z')};
  assert.equal(regularTradingStatistics(shifted),null,'the old comparison cannot be attached to new-day regular statistics');
  assert.equal(buildBasicMetrics(shifted).fields.amplitude.value,null);
});

test('Sina PRE regular statistics use their own source comparison after headline normalization',()=>{
  const quote=parseSinaQuotes(sinaRow('NVDA',{date:'2026-09-10 19:00:00',trade:'Sep 09 04:00PM EDT',ext:'Sep 10 07:00AM EDT',extPrice:103}),['NVDA'],{now:Date.parse('2026-09-10T14:00:00Z')})[0];
  assert.equal(quote.prevClose,100);
  assert.equal(quote.previousCloseTradeDate,'2026-09-09');
  assert.equal(regularTradingStatistics(quote).prevClose,99);
  assert.equal(regularTradingStatistics(quote).tradeDate,'2026-09-09');
  close(buildBasicMetrics(quote).fields.amplitude.value,5/99*100);
});

test('republishing a quote preserves reference evidence and missing-reference reasons',()=>{
  const aligned=parser.parseNaverQuote({...naver,overMarketPriceInfo:null},'TSM',7000);
  const pre=parser.parseNaverQuote(naver,'TSM',7000);
  const missing=publishQuote({symbol:'NVDA',instrumentType:'EQUITY',currency:'USD',src:'test',
    price:226.08,quoteAt:Date.parse('2026-09-22T13:12:00Z'),priceSession:'PRE',
    prevClose:222.27,previousCloseTradeDate:'2026-09-18'});
  const dated=publishQuote({...aligned,previousCloseStatus:'source-dated',previousCloseSource:'daily-fixture'});
  for(const quote of [aligned,pre,missing,dated]){
    assert.deepEqual(publishQuote(quote),quote);
    assert.deepEqual(publishQuote(publishQuote(quote)),quote);
  }
  assert.equal(aligned.previousCloseStatus,'source-aligned');
  assert.equal(pre.previousCloseStatus,'regular-close');
  assert.equal(missing.previousCloseMissingReason,'PREVIOUS_CLOSE_DATE_MISMATCH');
});
