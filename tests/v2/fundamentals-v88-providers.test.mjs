import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {normalizeNaverBasic,normalizeNaverStatements,normalizeNasdaqSummary,normalizeNasdaqDividends,normalizeNasdaqStatements} from '../../lib/providers/financial-details.js';
import {normalizeNaverCompanyFinancials} from '../../lib/providers/financial-details.js';
const fixture=name=>JSON.parse(fs.readFileSync(new URL('../fixtures/fundamentals-v88/'+name+'.json',import.meta.url),'utf8'));
const now=Date.parse('2026-09-14T08:00:00Z');
test('real ETF basic responses expose shares and 52-week pairs without company valuations',()=>{
 for(const symbol of ['QQQ','SPY','XLK']){const r=normalizeNaverBasic(symbol,fixture('basic-'+symbol),{now});assert.ok(r.fields.sharesOutstanding.value>0);assert.ok(r.fields.week52High.value>r.fields.week52Low.value);assert.equal(r.instrumentType,'ETF');assert.equal(r.fields.peTTM,undefined);assert.equal(r.fields.priceToBook,undefined);}
 const r=normalizeNaverBasic('NVDA',fixture('basic-NVDA'),{now});assert.equal(r.fields.priceToBook.value,23.02);assert.equal(r.fields.dividendTTM,undefined,'unspecified/forward dividend is not TTM');
});
test('identity, currency, malformed ratios and incomplete ranges are rejected or omitted',()=>{
 const x=fixture('basic-QQQ');assert.throws(()=>normalizeNaverBasic('SPY',x),{code:'FUNDAMENTALS_IDENTITY'});x.countOfListedStock='N/A';x.stockItemTotalInfos.find(v=>v.code==='highPriceOf52Weeks').value='N/A';const r=normalizeNaverBasic('QQQ',x,{now});assert.equal(r.fields.sharesOutstanding,undefined);assert.equal(r.fields.week52High,undefined);assert.equal(r.fields.week52Low,undefined);
 const n=fixture('basic-NVDA');n.stockItemTotalInfos.find(v=>v.code==='pbr').value='23.02garbage';assert.equal(normalizeNaverBasic('NVDA',n,{now}).fields.priceToBook,undefined);
});
test('Naver actual four-quarter EPS and revenue permit explicitly identified TTM calculations',()=>{
 const r=normalizeNaverStatements('NVDA',fixture('statements-NVDA'),fixture('quarter-NVDA'),fixture('annual-NVDA'),fixture('basic-NVDA'),{now});
 assert.ok(Math.abs(r.fields.trailingEps.value-7.91)<.001);assert.equal(r.fields.trailingEps.currency,'USD');assert.equal(r.fields.trailingEps.periods.length,4);assert.ok(r.fields.revenueTTM.value>300000000000);
 assert.equal(r.fields.annualEps,undefined,'never substitute TTM for missing fiscal-year EPS');
 const forecast=fixture('statements-NVDA');forecast.chartEps.trTitleList.at(-1).isConsensus='Y';const invalid=normalizeNaverStatements('NVDA',forecast,fixture('quarter-NVDA'),fixture('annual-NVDA'),fixture('basic-NVDA'),{now});assert.equal(invalid.fields.trailingEps,undefined);
});
test('Nasdaq summary keeps named 52-week values but not annualized dividends under a TTM label',()=>{
 const r=normalizeNasdaqSummary('NVDA',fixture('nasdaq-NVDA'),{currency:'USD',now});assert.equal(r.fields.week52High.value,236.54);assert.equal(r.fields.week52Low.value,164.27);assert.equal(r.fields.dividendTTM,undefined);assert.throws(()=>normalizeNasdaqSummary('AAOI',fixture('nasdaq-NVDA')),{code:'FUNDAMENTALS_IDENTITY'});
});
test('actual cash payments in the trailing year exclude future payments and require complete history',()=>{
 const r=normalizeNasdaqDividends('NVDA',fixture('dividends-NVDA'),{currency:'USD',now});assert.ok(Math.abs(r.fields.dividendTTM.value-.28)<1e-9);assert.equal(r.fields.dividendTTM.calculated,true);
 const q=normalizeNasdaqDividends('QQQ',fixture('dividends-QQQ'),{currency:'USD',now});assert.ok(Math.abs(q.fields.dividendTTM.value-3.03434)<1e-9);
 const x=fixture('dividends-NVDA');x.data.dividends.rows=x.data.dividends.rows.slice(0,2);assert.throws(()=>normalizeNasdaqDividends('NVDA',x,{currency:'USD',now}),{code:'FUNDAMENTALS_INCOMPLETE'});
 const y=fixture('dividends-NVDA');y.data.dividends.rows[1].currency='EUR';assert.throws(()=>normalizeNasdaqDividends('NVDA',y,{currency:'USD',now}),{code:'FUNDAMENTALS_CURRENCY'});
});
test('Nasdaq explicitly identified common-shareholder income supports TTM and annual calculations in USD',()=>{
 const r=normalizeNasdaqStatements('AMD',fixture('amd-financials'),fixture('annual-AMD-nasdaq'),{now});
 assert.equal(r.fields.netIncomeTTM.value,(2297000+1383000+1511000+1243000)*1000);assert.equal(r.fields.netIncomeTTM.currency,'USD');assert.ok(r.fields.netIncomeAnnual.value>0);
 const loss=normalizeNasdaqStatements('AAOI',fixture('quarter-AAOI-nasdaq'),null,{now});assert.ok(loss.fields.netIncomeTTM.value<0);assert.equal(loss.fields.netIncomeAnnual,undefined);
 assert.throws(()=>normalizeNasdaqStatements('NVDA',fixture('amd-financials'),null,{now}),{code:'FUNDAMENTALS_IDENTITY'});
 const missing=fixture('amd-financials');missing.data.incomeStatementTable.rows=missing.data.incomeStatementTable.rows.filter(r=>r.value1!=='Net Income Applicable to Common Shareholders');assert.equal(normalizeNasdaqStatements('AMD',missing,null,{now}).fields.netIncomeTTM,undefined);
});
test('old unknown payment dates do not erase an explicitly dated last payment outside the trailing year',()=>{
 const r=normalizeNasdaqDividends('INTC',fixture('intc-dividends'),{currency:'USD',now});assert.equal(r.fields.dividendTTM.value,0);
 assert.throws(()=>normalizeNasdaqDividends('SPY',fixture('spy-dividends'),{currency:'USD',now}),{code:'FUNDAMENTALS_UNSUPPORTED'});
});
test('partial and invalid statement observations never fabricate earnings or future periods',()=>{
 const s=fixture('statements-NVDA'),q=fixture('quarter-NVDA'),a=fixture('annual-NVDA'),b=fixture('basic-NVDA');
 assert.throws(()=>normalizeNaverStatements('AMD',s,q,a,b,{now}),{code:'FUNDAMENTALS_IDENTITY'});
 s.chartEps.columns[1][4]='garbage';assert.equal(normalizeNaverStatements('NVDA',s,q,a,b,{now}).fields.trailingEps,undefined);
 q.unit='EUR(백만)';assert.equal(normalizeNaverStatements('NVDA',s,q,a,b,{now}).fields.revenueTTM,undefined);
 const x=fixture('amd-financials');x.data.incomeStatementTable.headers.value1='Unknown';assert.deepEqual(normalizeNasdaqStatements('AMD',x,null,{now}).fields,{});
 delete x.data.incomeStatementTable;assert.deepEqual(normalizeNasdaqStatements('AMD',x,null,{now}).fields,{});
 const y=fixture('amd-financials');y.data.incomeStatementTable.headers.value2='12/01/2099';assert.deepEqual(normalizeNasdaqStatements('AMD',y,null,{now}).fields,{});
 const k=fixture('basic-NVDA');k.currencyType.code='INVALID';assert.equal(normalizeNaverBasic('NVDA',k,{now}).fields.marketCap,undefined);
 const n=fixture('nasdaq-NVDA');n.data.summaryData.FiftTwoWeekHighLow.value='$10/$100';assert.equal(normalizeNasdaqSummary('NVDA',n,{now}).fields.week52High,undefined);
 const d=fixture('dividends-NVDA');d.data.symbol='AMD';assert.throws(()=>normalizeNasdaqDividends('NVDA',d,{now}),{code:'FUNDAMENTALS_IDENTITY'});
 d.data.symbol='NVDA';d.data.dividends.rows[1].amount='-$1';assert.throws(()=>normalizeNasdaqDividends('NVDA',d,{now}),{code:'FUNDAMENTALS_INCOMPLETE'});
});
test('Korean company actual fiscal EPS is separate from estimates and the declared TTM header',()=>{
 const html=fs.readFileSync(new URL('../fixtures/fundamentals-v88/company-KR.html',import.meta.url),'utf8');
 const r=normalizeNaverCompanyFinancials('000660.KS',html,{now});assert.equal(r.fields.trailingEps.value,224313);assert.equal(r.fields.annualEps.value,58955);assert.equal(r.fields.annualEps.financialPeriod,'2025-12');assert.notEqual(r.fields.annualEps.value,349573);
 const noBasis=normalizeNaverCompanyFinancials('000660.KS',html.replaceAll('EPS(TTM)','EPS'),{now});assert.equal(noBasis.fields.trailingEps,undefined);
 const annualFallback=normalizeNaverCompanyFinancials('000660.KS',html.replace('224,313','58,955'),{now});assert.equal(annualFallback.fields.trailingEps,undefined);
});
