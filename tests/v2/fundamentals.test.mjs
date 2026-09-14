import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {financialNumber,buildBasicMetrics,regularStatistics} from '../../lib/fundamentals.js';
import {normalizeYahooFundamentals,normalizeFinnhubFundamentals,createFundamentalsProvider} from '../../lib/providers/fundamentals.js';
import {NOW,quote,record,summary} from './fundamentals-fixture.mjs';
const metrics=(q=quote(),r=record(),options={})=>buildBasicMetrics(q,r,{now:NOW,...options});

test('financial values distinguish null, zero, numeric strings and invalid input',()=>{
  for(const v of [null,undefined,'',' ','5.3倍','1,000',NaN,Infinity,true,[],{}])assert.equal(financialNumber(v),null,String(v));
  for(const [v,n] of [[0,0],['0',0],[{raw:5.33},5.33],['1e3',1000],['-.25',-.25]])assert.equal(financialNumber(v),n);
});
test('Yahoo maps explicit trailing fields, percentage units and unknown financial dates',()=>{
  const p=summary();p.quoteSummary.result[0].summaryDetail.trailingAnnualDividendYield={raw:.015};
  const r=normalizeYahooFundamentals('AAOI',p,{now:NOW});
  assert.equal(r.fields.dividendYieldTTM.value,1.5);assert.equal(r.fields.dividendTTM.value,0);
  assert.equal(r.fields.priceToBook.value,5.33);assert.equal(r.fields.peTTM.asOf,null);assert.equal(r.fields.peTTM.quoteReferenceAt,NOW);
  assert.equal(r.fields.sharesOutstanding.asOf,null);assert.equal(r.financialPeriod,'2026-06-30');
});
test('Yahoo rejects mismatched symbols and never replaces annual PE with forward PE',()=>{
  assert.throws(()=>normalizeYahooFundamentals('NVDA',summary()),{code:'FUNDAMENTALS_IDENTITY'});
  const p=summary();p.quoteSummary.result[0].summaryDetail={forwardPE:30,dividendRate:10,dividendYield:.2};
  const r=normalizeYahooFundamentals('AAOI',p,{now:NOW});
  assert.equal(r.fields.peLYR,undefined);assert.equal(r.fields.dividendTTM,undefined);assert.equal(r.fields.dividendYieldTTM,undefined);
});
test('negative earnings and nonpositive book value are distinct from missing values',()=>{
  const p=summary();p.quoteSummary.result[0].summaryDetail={};p.quoteSummary.result[0].defaultKeyStatistics={trailingEps:-2,bookValue:0};
  const r=normalizeYahooFundamentals('AAOI',p,{now:NOW}),m=metrics(quote(),r);
  assert.equal(m.fields.peTTM.status,'loss');assert.equal(m.fields.priceToBook.status,'nonpositive-book');
  assert.equal(metrics(quote(),null).fields.peTTM.status,'unavailable');
});
test('turnover uses float shares, amplitude uses regular range and quote remains immutable',()=>{
  const q=quote(),r=record(),before=JSON.stringify(q),m=metrics(q,r);
  assert.ok(Math.abs(m.fields.turnoverRate.value-5001400/80880800*100)<1e-10);
  assert.equal(m.fields.turnoverRate.basis,'float-shares');assert.equal(m.fields.turnoverRate.denominator,80880800);
  assert.ok(Math.abs(m.fields.amplitude.value-(108.669-104.08)/103.29*100)<1e-10);
  assert.equal(m.fields.floatMarketCap.estimated,true);assert.equal(m.fields.floatMarketCap.value,105.36*80880800);assert.equal(JSON.stringify(q),before);
});
test('total shares fallback is explicit; float above total disables related calculations',()=>{
  const r=record();delete r.fields.floatShares;let m=metrics(quote(),r);
  assert.equal(m.fields.turnoverRate.basis,'total-shares');assert.equal(m.fields.floatMarketCap.value,null);
  r.fields.floatShares={value:999999999,status:'available'};m=metrics(quote(),r);
  assert.equal(m.fields.floatShares.status,'conflict');assert.equal(m.fields.turnoverRate.value,null);assert.equal(m.fields.floatMarketCap.value,null);
});
test('zero volume is valid; lot-based or nonregular volume never becomes share turnover',()=>{
  assert.equal(metrics(quote('AAOI',{volume:0})).fields.turnoverRate.value,0);
  assert.equal(metrics(quote('AAOI',{volumeUnit:'lots'})).fields.turnoverRate.value,null);
  assert.equal(metrics(quote('AAOI',{ohlcSession:'POST'})).fields.turnoverRate.value,null);
  assert.equal(metrics(quote('AAOI',{prevClose:0})).fields.amplitude.value,null);
  assert.equal(metrics(quote('AAOI',{dayHigh:10,dayLow:20})).fields.amplitude.value,null);
});
test('turnover amount, volume ratio, order imbalance and lot size are never fabricated',()=>{
  const m=metrics();for(const k of ['turnoverAmount','volumeRatio','orderImbalance','lotSize'])assert.equal(m.fields[k].value,null,k);
  assert.equal(metrics(quote('AAOI',{turnoverAmount:123456})).fields.turnoverAmount.value,123456);
  const q=quote('AAOI',{tradingStats:{session:'REGULAR',volume:100,source:'fixture',asOf:NOW,volumeRatio:{value:2,basis:'five-day-per-minute',asOf:NOW},orderImbalance:{value:-42.98,basis:'full-displayed-book',asOf:NOW}}});
  assert.equal(metrics(q).fields.volumeRatio.value,2);assert.equal(metrics(q).fields.orderImbalance.value,-42.98);
  q.tradingStats.volumeRatio.basis='daily-average';q.tradingStats.orderImbalance.basis='top-of-book';
  assert.equal(metrics(q).fields.volumeRatio.value,null);assert.equal(metrics(q).fields.orderImbalance.value,null);
});
test('regular statistics retain their own timestamp during extended hours',()=>{
  const q=quote('AAOI',{quoteAt:NOW+5000,priceSession:'POST'}),s=regularStatistics(q);
  assert.equal(s.asOf,NOW);assert.equal(metrics(q).fields.turnoverRate.asOf,NOW);
});
test('funds and indices do not inherit company valuations; inferred identity can be refined',()=>{
  for(const kind of ['ETF','MUTUALFUND','INDEX','FUTURE']){
    const m=metrics(quote('AAOI',{instrumentType:kind}));for(const key of ['peTTM','peLYR','priceToBook','marketCap','psTTM'])assert.equal(m.fields[key].status,'not-applicable',kind+':'+key);
  }
  const r=record();r.instrumentType='ETF';const m=metrics(quote('AAOI',{instrumentTypeSource:'inferred'}),r);assert.equal(m.instrumentType,'ETF');
});
test('expired or mismatched records disappear, stale fields remain explicitly flagged',()=>{
  const r=record();assert.equal(metrics(quote(),r,{now:NOW+60000,ttlMs:60000}).status,'stale');
  assert.equal(metrics(quote(),r,{now:NOW+60000,ttlMs:60000}).fields.priceToBook.stale,true);
  const expired=metrics(quote(),r,{now:NOW+120000,ttlMs:60000,maxAgeMs:120000});assert.equal(expired.status,'expired');assert.equal(expired.fields.priceToBook.value,null);
  assert.equal(metrics(quote('NVDA'),r).fields.priceToBook.value,null);
  assert.equal(metrics(quote(),r,{enabled:false}).fields.priceToBook.value,null);
});
test('pence quotes produce base-currency float capitalization without a hundredfold error',()=>{
  const m=metrics(quote('AAOI',{price:125,currency:'GBp'}));assert.equal(m.fields.floatMarketCap.value,1.25*80880800);assert.equal(m.fields.floatMarketCap.currency,'GBP');
  const p=summary();p.quoteSummary.result[0].price.currency='GBp';assert.equal(normalizeYahooFundamentals('AAOI',p).fields.marketCap.currency,'GBP');
});
test('Finnhub uses explicit fiscal, trailing and book metrics only',()=>{
  const r=normalizeFinnhubFundamentals('AAOI',{symbol:'AAOI',metric:{peAnnual:20,peTTM:25,pbQuarterly:3,psTTM:4,marketCapitalization:99}},{now:NOW});
  assert.equal(r.fields.peLYR.value,20);assert.equal(r.fields.peLYR.basis,'last-fiscal-year');assert.equal(r.fields.marketCap,undefined);
  assert.throws(()=>normalizeFinnhubFundamentals('NVDA',{symbol:'AAOI',metric:{peTTM:5}}),{code:'FUNDAMENTALS_IDENTITY'});
});
test('optional financial fallback requires a private token and preserves primary values',async()=>{
  let calls=0;
  const httpsGet=async(url,headers)=>{calls++;assert.equal(headers['X-Finnhub-Token'],'test-only-token');assert.ok(!url.includes('test-only-token'));return {status:200,body:JSON.stringify({symbol:'AAOI',metric:{peAnnual:21,pbQuarterly:99}})};};
  const primary=createFundamentalsProvider({fetchYahooSummary:async()=>summary(),httpsGet,now:()=>NOW});assert.equal((await primary('AAOI')).fields.priceToBook.value,5.33);assert.equal(calls,0);
  const both=createFundamentalsProvider({fetchYahooSummary:async()=>summary(),httpsGet,finnhubToken:'test-only-token',now:()=>NOW}),r=await both('AAOI');
  assert.equal(calls,1);assert.equal(r.fields.peLYR.value,21);assert.equal(r.fields.priceToBook.value,5.33);
});
test('rate limits preserve retry-after and cancellation never triggers fallback',async()=>{
  const provider=createFundamentalsProvider({fetchYahooSummary:async()=>{throw new Error('unavailable');},httpsGet:async()=>({status:429,headers:{'retry-after':'600'}}),finnhubToken:'test-only-token',now:()=>NOW});
  await assert.rejects(provider('AAOI'),e=>e.retryAt>=NOW+600000);
  let fallback=0;const controller=new AbortController();controller.abort();
  const aborted=createFundamentalsProvider({fetchYahooSummary:async()=>{throw new Error('aborted');},httpsGet:async()=>{fallback++;},finnhubToken:'test-only-token'});
  await assert.rejects(aborted('AAOI',{signal:controller.signal}));assert.equal(fallback,0);
});
test('real UI definitions have stable 16/24 cells and total-share fallback label',()=>{
  const ctx={window:{},console};vm.createContext(ctx);
  for(const name of ['panel-format.js','panel-currency.js','panel-fundamentals.js'])vm.runInContext(fs.readFileSync(new URL('../../public/modules/'+name,import.meta.url),'utf8'),ctx);
  const ui=ctx.window.PANEL_FUNDAMENTALS;assert.equal(ui.definitions.length,24);assert.equal(ui.definitions.filter(d=>!d.extra).length,16);
  const r=record();delete r.fields.floatShares;const q=quote();q.fundamentals=metrics(q,r);
  const f={unit:'USD',money:v=>Number(v).toFixed(2),convert:v=>v};
  assert.equal(ui.formatMetric(ui.definitions.find(d=>d.key==='turnoverRate'),q,f).label,'换手率·总股本');
  assert.equal(ui.formatMetric(ui.definitions.find(d=>d.key==='priceToBook'),q,f).text,'5.33');
  assert.equal(ui.formatMetric(ui.definitions.find(d=>d.key==='dividendTTM'),q,f).text,'0.00 USD');
});
