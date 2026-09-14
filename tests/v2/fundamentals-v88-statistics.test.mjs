import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {mergeTradingStatistics,regularTradingStatistics} from '../../lib/trading-statistics.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';
const friday=Date.parse('2026-09-11T20:00:00Z'),monday=Date.parse('2026-09-14T07:30:00Z');
const q=(extra={})=>({symbol:'AAOI',currency:'USD',src:'fixture',price:105.36,regularPrice:105.36,quoteAt:friday,regularQuoteAt:friday,priceSession:'REGULAR',ohlcSession:'REGULAR',marketState:'CLOSED',volume:5001360,volumeUnit:'shares',open:104.51,dayHigh:108.67,dayLow:104.08,prevClose:103.29,turnoverAmount:530156000,...extra});
test('new-day blanks retain the last complete regular statistics without mixing previous close',()=>{
 const next=q({quoteAt:monday,regularQuoteAt:null,priceSession:'PRE',prevClose:105.36,volume:null,open:null,dayHigh:null,dayLow:null,turnoverAmount:0});
 const out=mergeTradingStatistics(next,q(),{now:monday});assert.equal(out.tradingStats.volume,5001360);assert.equal(out.tradingStats.prevClose,103.29);assert.equal(out.prevClose,105.36);assert.equal(out.tradingStats.tradeDate,'2026-09-11');assert.equal(out.tradingStats.retained,true);assert.equal(out.tradingStats.asOf,friday);assert.equal(out.quoteAt,monday);assert.equal(buildBasicMetrics(out).fields.turnoverAmount.value,530156000);
});
test('a valid new trading day switches the whole group; an isolated empty field cannot blend days',()=>{
 const open=Date.parse('2026-09-14T13:30:00Z'),next=q({quoteAt:open,regularQuoteAt:open,marketState:'REGULAR',volume:0,turnoverAmount:0,open:106,dayHigh:106,dayLow:106,prevClose:105.36});
 const out=mergeTradingStatistics(next,q(),{now:open});assert.equal(out.tradingStats.volume,0);assert.equal(out.tradingStats.turnoverAmount,0);assert.equal(out.tradingStats.prevClose,105.36);assert.equal(out.tradingStats.tradeDate,'2026-09-14');assert.equal(out.tradingStats.retained,false);
 const noAmount=mergeTradingStatistics({...next,turnoverAmount:null},q(),{now:open});assert.equal(noAmount.tradingStats.turnoverAmount,null,'no Friday amount on Monday');
});
test('same-session backup may fill money but wrong symbol, currency and old day cannot',()=>{
 const out=mergeTradingStatistics(q({turnoverAmount:null}),q({src:'backup'}),{now:monday});assert.equal(out.tradingStats.turnoverAmount,530156000);assert.equal(out.tradingStats.amountSource,'backup');
 for(const other of [q({symbol:'NVDA'}),q({currency:'CNY'}),q({quoteAt:friday-86400000,regularQuoteAt:friday-86400000})])assert.equal(mergeTradingStatistics(q({turnoverAmount:null}),other,{now:monday}).tradingStats.turnoverAmount,null);
 assert.equal(regularTradingStatistics(q({volumeUnit:'lots'})),null);
});
test('real Naver day-rollover housekeeping is not a new trade timestamp',()=>{
 const raw=JSON.parse(fs.readFileSync(new URL('../fixtures/fundamentals-v88/rollover-naver.json',import.meta.url),'utf8'));
 const batch=createBatchProvider({now:()=>Date.parse('2026-09-14T10:00:00Z')});
 for(const row of raw.datas)assert.equal(batch.parseNaverQuote(row,row.symbolCode,70000),null);
});
test('Tencent official mainland mapping supplies 52-week prices, correct share columns and five-level imbalance',()=>{
 const raw=fs.readFileSync(new URL('../fixtures/fundamentals-v88/tencent.raw',import.meta.url)).toString('latin1');
 const parser=createBatchProvider({now:()=>Date.parse('2026-09-14T10:00:00Z')});
 const fund=parser.parseTencentBatch(raw,['161128.SZ'])[0];assert.equal(fund.week52High,7.662);assert.equal(fund.week52Low,5.201);assert.equal(fund.financials.fields.week52High.value,7.662);
 const fields=raw.match(/v_sz161128="([^"]*)"/)[1].split('~');fields[2]='600000';fields[61]='GP';fields[72]='600000000';fields[73]='1000000000';
 const stock=parser.parseTencentBatch('v_sh600000="'+fields.join('~')+'";',['600000.SS'])[0];assert.equal(stock.financials.fields.sharesOutstanding.value,1000000000);assert.equal(stock.financials.fields.floatShares.value,600000000);
 assert.equal(stock.tradingStats.orderImbalance.depth,5);assert.ok(Math.abs(stock.tradingStats.orderImbalance.value)<=100);
});
