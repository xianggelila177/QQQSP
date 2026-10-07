import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeNaverStatements} from '../../lib/providers/financial-details.js';
import {normalizeFinancialRecord,selectFinancialRecord,deriveFinancialFields} from '../../lib/financial-candidates.js';
import {financialContentFreshness} from '../../lib/financial-quality.js';
import {createFinancialSources} from '../../lib/providers/financial-sources.js';
import {buildContextFinancials} from '../../lib/context-financials.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';
import {quote} from './fundamentals-fixture.mjs';

const NOW=Date.parse('2026-10-07T08:00:00Z'),DAY=86400000;
const fixture=name=>JSON.parse(fs.readFileSync(new URL('../fixtures/fundamentals-v88/'+name+'.json',import.meta.url),'utf8'));
const field=(value,extra={})=>({value,status:'available',...extra});
function entry(id,fields,extra={}){
  return {id,data:normalizeFinancialRecord('NVDA',{symbol:'NVDA',fields,...extra},{source:id,now:NOW,ttlMs:300000,maxAgeMs:7*DAY})};
}
const select=(rows,now=NOW)=>selectFinancialRecord('NVDA',rows,rows.map((row,priority)=>({id:row.id,priority})),{now,maxAgeMs:7*DAY});

test('Naver verifies identity on every returned statement and labels missing identity conservatively',()=>{
  const rows=()=>['statements-NVDA','quarter-NVDA','annual-NVDA','basic-NVDA'].map(fixture);
  for(const index of [0,1,2])for(const key of ['reutersCode','symbolCode']){
    const payloads=rows();payloads[index][key]=key==='reutersCode'?'WRONG.O':'WRONG';
    assert.throws(()=>normalizeNaverStatements('NVDA',...payloads,{now:NOW}),{code:'FUNDAMENTALS_IDENTITY'});
  }
  const payloads=rows(),record=normalizeNaverStatements('NVDA',...payloads,{now:NOW});
  assert.ok(record.fields.trailingEps.value>0);
  assert.equal(record.fields.trailingEps.identityBasis,'requested-symbol-route');
  for(const payload of payloads.slice(0,3))payload.reutersCode='NVDA.O';
  assert.equal(normalizeNaverStatements('NVDA',...payloads,{now:NOW}).fields.trailingEps.identityBasis,'provider-symbol-identity');
  assert.ok(normalizeNaverStatements('NVDA',null,null,payloads[2],payloads[3],{now:NOW}).fields.peLYR);
});

test('a repeated successful fetch cannot renew an obsolete reporting period',()=>{
  const facts={trailingEps:field(5,{currency:'USD',unit:'money-per-share',basis:'trailing-twelve-months',financialPeriod:'2020-12-31'})};
  const old=entry('a',facts),first=select([old]);
  assert.equal(first.fields.trailingEps.fetchedAt,NOW);assert.equal(first.fields.trailingEps.cacheStale,false);
  assert.equal(first.fields.trailingEps.stale,true);assert.equal(first.fields.trailingEps.contentFreshness.reason,'report-period-old');
  const renewed={id:'a',data:normalizeFinancialRecord('NVDA',{symbol:'NVDA',fields:facts},{source:'a',now:NOW+DAY,ttlMs:300000,maxAgeMs:7*DAY,previous:old.data})};
  assert.equal(select([renewed],NOW+DAY).fields.trailingEps.stale,true);
  const current=entry('b',{trailingEps:{...facts.trailingEps,financialPeriod:'2026-06-30'}});
  assert.equal(select([renewed,current],NOW+DAY).fields.trailingEps.providerId,'b');
});

test('financial freshness keeps acquisition, report periods and effective dates separate',()=>{
  assert.equal(financialContentFreshness('annualEps',{financialPeriod:'2025-12',basis:'last-fiscal-year'},NOW).status,'within-age-window');
  assert.equal(financialContentFreshness('trailingEps',{financialPeriod:'2026-06-30',basis:'trailing-twelve-months'},NOW).latestReportVerified,false);
  assert.equal(financialContentFreshness('peTTM',{asOf:NOW,basis:'trailing-twelve-months'},NOW).reason,'report-period-unknown');
  assert.equal(financialContentFreshness('peTTM',{financialPeriod:'2026-06-30',asOf:null,basis:'trailing-twelve-months'},NOW).reason,'valuation-effective-date-unknown');
  assert.equal(financialContentFreshness('peTTM',{financialPeriod:'2026-06-30',asOf:NOW-30*DAY,basis:'trailing-twelve-months'},NOW).reason,'valuation-effective-date-old');
  const twse=financialContentFreshness('peTTM',{financialPeriod:'2026Q2',asOf:NOW-DAY,basis:'twse-reference-four-quarters-daily-close'},NOW);
  assert.equal(twse.status,'within-age-window');assert.equal(twse.maxAgeDays,240);assert.equal(twse.referenceAt,Date.parse('2026-06-30T00:00:00Z'));
  assert.equal(financialContentFreshness('peTTM',{financialPeriod:'2025Q2',asOf:NOW,basis:'twse-reference-four-quarters-daily-close'},NOW).reason,'report-period-old');
  for(const financialPeriod of ['2026-02-31','2027-06-30'])assert.equal(financialContentFreshness('trailingEps',{financialPeriod},NOW).status,'invalid');
  const result=select([entry('a',{marketCap:field(1000),trailingEps:field(5)},{financialPeriod:'2026-06-30'})]);
  assert.equal(result.fields.marketCap.financialPeriod,null,'company recent-quarter metadata is not a market-cap effective date');
  assert.equal(result.fields.marketCap.contentFreshness.status,'unverified');
  assert.equal(result.fields.trailingEps.financialPeriod,'2026-06-30');
});

test('only matching accounting, currency, report and valuation-time bases generate a conflict',()=>{
  const base={currency:'USD',unit:'money-per-share',basis:'trailing-twelve-months',accountingBasis:'US-GAAP',financialPeriod:'2026-06-30'};
  const first=entry('a',{trailingEps:field(5,base)}),second=entry('b',{trailingEps:field(10,base)});
  const result=select([first,second]),selected=result.fields.trailingEps;
  assert.equal(selected.value,5);assert.equal(selected.comparison.status,'disagreement');
  assert.deepEqual(selected.comparison.candidates.map(row=>row.value),[5,10]);
  assert.ok(selected.qualityWarnings.includes('source-disagreement'));
  assert.equal(deriveFinancialFields({currency:'USD',regularPrice:100,quoteAt:NOW,priceSession:'REGULAR'},result).fields.peTTM,undefined,'conflicting earnings cannot feed an estimated valuation');
  for(const extra of [{currency:'EUR'},{financialPeriod:'2026-03-31'},{accountingBasis:'adjusted'},{accountingBasis:undefined}]){
    assert.equal(select([first,entry('b',{trailingEps:field(10,{...base,...extra})})]).fields.trailingEps.comparison.status,'not-comparable');
  }
  const ratio={...base,unit:'ratio',asOf:NOW};
  assert.equal(select([entry('a',{peTTM:field(20,ratio)}),entry('b',{peTTM:field(40,{...ratio,asOf:NOW-120000})})]).fields.peTTM.comparison.status,'not-comparable');
  assert.equal(select([entry('a',{peTTM:field(20,ratio)}),entry('b',{peTTM:field(40,ratio)})]).fields.peTTM.comparison.status,'disagreement');
});

test('mixed financial sources refresh valuations sooner while maintaining independent statement clocks',()=>{
  const sources=createFinancialSources({finnhubRequest:async()=>{},statementTtlMs:21600000});
  const yahoo=sources.find(source=>source.id==='yahoo-summary'),finnhub=sources.find(source=>source.id==='finnhub-metric'),statements=sources.find(source=>source.id==='naver-statements');
  assert.equal(yahoo.ttlMs,300000);assert.equal(finnhub.ttlMs,300000);assert.equal(statements.ttlMs,21600000);
  const data=normalizeFinancialRecord('NVDA',{symbol:'NVDA',fields:{peTTM:field(20),trailingEps:field(5),sharesOutstanding:field(100)}},{source:yahoo.id,now:NOW,ttlMs:yahoo.ttlMs,fieldTtlMs:yahoo.fieldTtlMs,maxAgeMs:7*DAY});
  assert.equal(data.fields.peTTM.freshUntil,NOW+300000);assert.equal(data.fields.trailingEps.freshUntil,NOW+21600000);
  const partial=normalizeFinancialRecord('NVDA',{symbol:'NVDA',fields:{peTTM:field(21)}},{source:yahoo.id,now:NOW+300001,ttlMs:yahoo.ttlMs,fieldTtlMs:yahoo.fieldTtlMs,maxAgeMs:7*DAY,previous:data});
  assert.equal(partial.fields.trailingEps.fetchedAt,NOW);assert.equal(partial.fields.trailingEps.freshUntil,NOW+21600000);
  const changedPeriod={id:yahoo.id,data:{...partial,financialPeriod:'2026-06-30'}};
  assert.equal(select([changedPeriod]).fields.trailingEps.financialPeriod,null,'a newer partial response cannot attach its report period to an absent older field');
});

test('public financial evidence exposes report quality and comparable sources without raw payloads',()=>{
  const basis={currency:'USD',unit:'money-per-share',basis:'trailing-twelve-months',accountingBasis:'US-GAAP',financialPeriod:'2026-06-30'};
  const selected=select([entry('a',{trailingEps:field(5,basis),peTTM:field(20)}),entry('b',{trailingEps:field(10,basis)})]);
  const result=buildContextFinancials({quote:{fundamentals:selected},type:'EQUITY',source:value=>value||null});
  assert.equal(result.status,'partial');assert.ok(result.coverage.conflicting_fields.includes('trailingEps'));assert.ok(result.coverage.freshness_unverified_fields.includes('peTTM'));
  assert.equal(result.data.fields.trailingEps.content_freshness.latest_report_verified,false);
  assert.equal(result.data.fields.trailingEps.comparison.candidates[1].source_id,'b');
  assert.ok(result.source_ids.includes('b'));assert.equal(result.data.fields.peTTM.cache_stale,false);
});

test('derived share metrics stop on comparable share conflicts and retain unknown input-date warnings',()=>{
  const share=field(50,{source:'a',unit:'shares',basis:'float-shares',asOf:NOW,comparison:{status:'disagreement'}});
  let result=buildBasicMetrics(quote('NVDA'),{symbol:'NVDA',fetchedAt:NOW,fields:{floatShares:share,sharesOutstanding:field(100)}},{now:NOW});
  assert.equal(result.fields.turnoverRate.reason,'source-disagreement');assert.equal(result.fields.floatMarketCap.value,null);
  result=buildBasicMetrics(quote('NVDA'),{symbol:'NVDA',fetchedAt:NOW,fields:{floatShares:{...share,comparison:{status:'single-source'},contentFreshness:{status:'unverified',reason:'effective-date-unknown'},qualityWarnings:['effective-date-unknown']}}},{now:NOW});
  assert.equal(result.fields.floatMarketCap.contentFreshness.status,'unverified');
  assert.deepEqual(result.fields.turnoverRate.qualityWarnings,['effective-date-unknown']);
});

test('derived valuations recheck their price time instead of inheriting a fresh denominator clock',()=>{
  const record=select([entry('a',{trailingEps:field(5,{currency:'USD',unit:'money-per-share',basis:'trailing-twelve-months',financialPeriod:'2026-06-30'}),bookValue:field(10,{currency:'USD',unit:'money-per-share',basis:'latest-book',financialPeriod:'2026-06-30'}),dividendTTM:field(2,{currency:'USD',unit:'money-per-share',asOf:NOW})})]);
  const input={currency:'USD',regularPrice:100,priceSession:'PRE',regularQuoteAt:null};
  let result=deriveFinancialFields(input,record,{now:NOW});
  for(const key of ['peTTM','priceToBook','dividendYieldTTM']){
    assert.equal(result.fields[key].asOf,null);assert.equal(result.fields[key].contentFreshness.status,'unverified');
    assert.ok(result.fields[key].qualityWarnings.some(reason=>reason.includes('date-unknown')));
  }
  result=deriveFinancialFields({...input,regularQuoteAt:NOW-30*DAY},record,{now:NOW});
  for(const key of ['peTTM','priceToBook','dividendYieldTTM'])assert.equal(result.fields[key].stale,true);
  result=deriveFinancialFields({...input,regularQuoteAt:NOW},record,{now:NOW});
  for(const key of ['peTTM','priceToBook','dividendYieldTTM'])assert.equal(result.fields[key].contentFreshness.status,'within-age-window');
});
