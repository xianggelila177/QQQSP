import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeFinancialRecord,selectFinancialRecord,deriveFinancialFields,usableFinancialField} from '../../lib/financial-candidates.js';
import {mergeTradingStatistics,regularTradingStatistics,tradingDate} from '../../lib/trading-statistics.js';
import {quote,NOW} from './fundamentals-fixture.mjs';
const value=(n,extra={})=>({value:n,status:'available',currency:'USD',...extra});
test('candidate validation preserves semantic loss but rejects malformed values and wrong identity',()=>{
 for(const f of [null,{},value('1junk'),value(Infinity),value(true)])assert.equal(usableFinancialField('priceToBook',f),false);
 assert.equal(usableFinancialField('peTTM',{value:null,status:'loss'}),true);assert.equal(usableFinancialField('floatShares',{value:null,status:'loss'}),false);assert.equal(usableFinancialField('dividendTTM',value(-1)),false);
 assert.throws(()=>normalizeFinancialRecord('AAOI',{symbol:'LITE',fields:{}}),{code:'FUNDAMENTALS_IDENTITY'});assert.throws(()=>normalizeFinancialRecord('AAOI',{symbol:'AAOI',fields:{}}),{code:'FUNDAMENTALS_EMPTY'});
 const prior=normalizeFinancialRecord('AAOI',{symbol:'AAOI',fields:{priceToBook:value(5),sharesOutstanding:value(100)}},{source:'a',now:NOW,ttlMs:60,maxAgeMs:1000});
 const next=normalizeFinancialRecord('AAOI',{symbol:'AAOI',fields:{priceToBook:value(6),sharesOutstanding:value(null)}},{previous:prior,source:'a',now:NOW+100,ttlMs:60,maxAgeMs:1000});assert.equal(next.fields.sharesOutstanding.fetchedAt,NOW);
});
test('fresh fallback beats stale primary and invalid, future or mixed-range records cannot win',()=>{
 const sources=[{id:'a',priority:1,ttlMs:60},{id:'b',priority:2,ttlMs:60}];
 const data=(source,stamp,fields)=>({id:source,data:normalizeFinancialRecord('AAOI',{symbol:'AAOI',fields},{source,now:stamp,ttlMs:60,maxAgeMs:1000})});
 const a=data('a',NOW-100,{priceToBook:value(5),week52High:value(200),week52Low:value(10)}),b=data('b',NOW,{priceToBook:value(6),week52High:value(300),week52Low:value(20)});
 let r=selectFinancialRecord('AAOI',[a,b],sources,{now:NOW,maxAgeMs:1000});assert.equal(r.fields.priceToBook.value,6);assert.equal(r.fields.week52High.value,300);assert.equal(r.fields.week52Low.value,20);
 r=selectFinancialRecord('AAOI',[b,{id:'a',data:{symbol:'OTHER',fields:{}}},{id:'unknown',data:{symbol:'AAOI',fetchedAt:NOW+10000,fields:{priceToBook:value(999)}}}],sources,{now:NOW,maxAgeMs:1000});assert.equal(r.fields.priceToBook.value,6);
 const incomplete=data('a',NOW,{week52High:value(999)});r=selectFinancialRecord('AAOI',[incomplete,b],sources,{now:NOW,maxAgeMs:1000});assert.equal(r.fields.week52High.value,300);
 assert.equal(selectFinancialRecord('AAOI',[a,b],sources,{now:NOW+1000,maxAgeMs:1000}),null);
});
test('ratios use compatible currencies, actual EPS and explicit formulas, preserving valid direct values',()=>{
 const q=quote('AAOI',{regularPrice:100}),fields={trailingEps:value(5),annualEps:value(4),revenueTTM:value(1000),marketCap:value(20000),bookValue:value(20),dividendTTM:value(2)};
 let r=deriveFinancialFields(q,{fields});assert.equal(r.fields.peTTM.value,20);assert.equal(r.fields.peLYR.value,25);assert.equal(r.fields.priceToBook.value,5);assert.equal(r.fields.psTTM.value,20);assert.equal(r.fields.dividendYieldTTM.value,2);assert.equal(r.fields.peTTM.calculated,true);
 assert.equal(deriveFinancialFields(q,{fields:{...fields,peTTM:value(30)}}).fields.peTTM.value,30);
 r=deriveFinancialFields(q,{fields:{trailingEps:value(-2),bookValue:value(0)}});assert.equal(r.fields.peTTM.status,'loss');assert.equal(r.fields.priceToBook.status,'nonpositive-book');
 assert.equal(deriveFinancialFields(q,{fields:{trailingEps:value(5,{currency:'EUR'})}}).fields.peTTM,undefined);
 assert.equal(deriveFinancialFields(q,null),null);assert.equal(deriveFinancialFields({...q,regularPrice:0},{fields}).fields.peTTM,undefined);
 assert.equal(deriveFinancialFields({...q,currency:'GBp'},{fields:{trailingEps:value(.5,{currency:'GBP'})}}).fields.peTTM.value,2);
 assert.equal(deriveFinancialFields({...q,currency:'ZAc'},{fields:{trailingEps:value(.5,{currency:'ZAR'})}}).fields.peTTM.value,2);
 const income=deriveFinancialFields(q,{fields:{marketCap:value(1000),netIncomeTTM:value(-10),netIncomeAnnual:value(20),peLYR:value(99,{historical:true})}});assert.equal(income.fields.peTTM.status,'loss');assert.equal(income.fields.peLYR.value,50);assert.equal(income.fields.peLYR.historical,undefined);
});
test('statistics reject bad identity/time/range, future totals, negative volume and wrong units',()=>{
 assert.equal(regularTradingStatistics(null),null);assert.equal(tradingDate('UNKNOWN.XY',NOW),null);assert.equal(mergeTradingStatistics(null,quote()),null);
 for(const extra of [{volume:-1},{dayHigh:1},{open:999},{volumeUnit:'lots'},{ohlcSession:'POST'},{regularQuoteAt:0,quoteAt:0,ts:0},{tradingStats:{session:'REGULAR',currency:'EUR'}}])assert.equal(regularTradingStatistics(quote('AAOI',extra)),null);
 const q=quote(),future=quote('AAOI',{regularQuoteAt:NOW+10000});assert.equal(mergeTradingStatistics(future,q,{now:NOW}).tradingStats.asOf,NOW);
 const missing=quote('AAOI',{volume:null});assert.equal(mergeTradingStatistics(missing,quote('NVDA'),{now:NOW}).tradingStats,undefined);
});
