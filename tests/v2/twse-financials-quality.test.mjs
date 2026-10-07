import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTwseValuations,normalizeTwseCompany,createTwseFinancialSources} from '../../lib/providers/twse-financials.js';
import {normalizeFinancialRecord,selectFinancialRecord} from '../../lib/financial-candidates.js';
const NOW=Date.parse('2026-10-07T08:30:00Z'),AS_OF=Date.parse('2026-10-06T00:00:00+08:00');
// Reduced fields observed in official BWIBBU_d / t187ap03_L responses on Oct 7.
const valuation=(extra={})=>({Date:'20261006',Code:'2330',Name:'台積電',PEratio:'29.96',PBratio:'10.42',FiscalYearQuarter:'2026Q2',DividendYield:'0.89',...extra});
const company=(extra={})=>({'出表日期':'1151006','公司代號':'2330','公司名稱':'台灣積體電路製造股份有限公司','已發行普通股數或TDR原股發行股數':'25932370067',...extra});
const response=rows=>({status:200,headers:{},body:JSON.stringify(rows)});
function select(value,now=NOW){const spec={id:value.source,ttlMs:300000,priority:10};return selectFinancialRecord('2330.TW',[{id:spec.id,data:normalizeFinancialRecord('2330.TW',value,{source:spec.id,now,ttlMs:300000,maxAgeMs:7*864e5})}],[spec],{now,maxAgeMs:7*864e5});}
test('official Taiwan rows retain native PE/PB, ordinary shares, ROC date and business-date precision',()=>{
 const ratios=normalizeTwseValuations('2330.TW',[valuation()],{now:NOW}),shares=normalizeTwseCompany('2330.TW',[company()],{now:NOW});
 assert.equal(ratios.fields.peTTM.value,29.96);assert.equal(ratios.fields.priceToBook.value,10.42);assert.equal(ratios.fields.peTTM.currency,'TWD');assert.equal(ratios.fields.peTTM.asOf,AS_OF);assert.equal(ratios.fields.peTTM.datePrecision,'day');assert.equal(ratios.fields.peTTM.businessDate,'2026-10-06');assert.equal(ratios.fields.peTTM.identityBasis,'twse-listing-code');
 assert.equal(shares.fields.sharesOutstanding.value,25932370067);assert.equal(shares.fields.sharesOutstanding.unit,'shares');assert.equal(shares.fields.sharesOutstanding.asOf,null);assert.equal(shares.fields.sharesOutstanding.sourcePublishedAt,AS_OF);assert.equal(shares.fields.sharesOutstanding.dateBasis,'dataset-publication');assert.equal(shares.fields.sharesOutstanding.businessDate,'2026-10-06');assert.equal(select(shares).fields.sharesOutstanding.contentFreshness.status,'unverified');assert.equal(Object.hasOwn(ratios.fields,'dividendYieldTTM'),false,'TWSE stock-and-cash yield is not paid cash TTM yield');
 const selected=select(ratios);assert.equal(selected.fields.peTTM.stale,false);assert.equal(selected.fields.peTTM.contentFreshness.status,'within-age-window');assert.equal(selected.fields.peTTM.contentFreshness.latestReportVerified,false);
});
test('Taiwan identity selection rejects missing/duplicate rows and never routes TSM ADR or unknown listings',()=>{
 for(const [normalize,row,key] of [[normalizeTwseValuations,valuation(),'Code'],[normalizeTwseCompany,company(),'公司代號']]){
  assert.throws(()=>normalize('2330.TW',[{...row,[key]:'2317'}],{now:NOW}),{code:'FUNDAMENTALS_EMPTY'});
  assert.throws(()=>normalize('2330.TW',[row,{...row}],{now:NOW}),{code:'FUNDAMENTALS_IDENTITY'});
  for(const symbol of ['TSM','0050.TW','2317.TW'])assert.throws(()=>normalize(symbol,[row],{now:NOW}),{code:'FUNDAMENTALS_UNSUPPORTED'});
 }
 const sources=createTwseFinancialSources({now:()=>NOW,httpsGet:async()=>{throw Error('should not load');}});
 for(const source of sources){assert.equal(source.match({symbol:'2330.TW',currency:'TWD',instrumentType:'EQUITY'}),true);for(const quote of [{symbol:'TSM',currency:'USD',instrumentType:'EQUITY'},{symbol:'2317.TW',currency:'TWD',instrumentType:'EQUITY'},{symbol:'2330.TW',currency:'USD',instrumentType:'EQUITY'},{symbol:'2330.TW',currency:'TWD',instrumentType:'ETF'}])assert.equal(source.match(quote),false);}
});
test('invalid calendar dates, future snapshots and future report quarters cannot produce Taiwan facts',()=>{
 for(const date of ['20260230','20261301','20261008','2026/10/06',''])assert.throws(()=>normalizeTwseValuations('2330.TW',[valuation({Date:date})],{now:NOW}),{code:'FUNDAMENTALS_DATE'},date);
 for(const date of ['1150230','1151301','1151008','20261006',''])assert.throws(()=>normalizeTwseCompany('2330.TW',[company({'出表日期':date})],{now:NOW}),{code:'FUNDAMENTALS_DATE'},date);
 assert.throws(()=>normalizeTwseValuations('2330.TW',[valuation({FiscalYearQuarter:'2026Q4'})],{now:NOW}),{code:'FUNDAMENTALS_DATE'});
 assert.throws(()=>normalizeTwseValuations('2330.TW',[valuation({Date:'20260401',FiscalYearQuarter:'2026Q2'})],{now:NOW}),{code:'FUNDAMENTALS_DATE'});
});
test('a new fetch cannot make an obsolete business-date valuation current',()=>{
 const fresh=select(normalizeTwseValuations('2330.TW',[valuation()],{now:NOW}));assert.equal(fresh.fields.priceToBook.cacheStale,false);
 const older=select(normalizeTwseValuations('2330.TW',[valuation({Date:'20260701'})],{now:NOW}));assert.equal(older.fields.peTTM.cacheStale,false);assert.equal(older.fields.peTTM.stale,true);assert.equal(older.fields.peTTM.contentFreshness.status,'stale');
 const missing=normalizeTwseValuations('2330.TW',[valuation({PEratio:'-',PBratio:'0'})],{now:NOW});assert.deepEqual(missing.fields,{});
 assert.deepEqual(normalizeTwseCompany('2330.TW',[company({'已發行普通股數或TDR原股發行股數':'9007199254740992'})],{now:NOW}).fields,{});
});
test('concurrent Taiwan readers share the dataset, one cancellation preserves the other, TTL expires normally',async()=>{
 let now=NOW,calls=0,release,producerSignal;
 const [source]=createTwseFinancialSources({now:()=>now,httpsGet:async(_url,_headers,{signal})=>{calls++;producerSignal=signal;return new Promise(resolve=>release=resolve);}}),a=new AbortController(),b=new AbortController();
 const first=source.load('2330.TW',{signal:a.signal}),second=source.load('2330.TW',{signal:b.signal});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);a.abort();await assert.rejects(first);assert.equal(producerSignal.aborted,false);release(response([valuation()]));assert.equal((await second).fields.peTTM.value,29.96);
 await source.load('2330.TW',{});assert.equal(calls,1);now+=300001;const refreshed=source.load('2330.TW',{});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);release(response([valuation()]));await refreshed;
});
test('last-reader cancellation prevents a late dataset response from entering cache',async()=>{
 let calls=0,release,producerSignal;const [source]=createTwseFinancialSources({now:()=>NOW,httpsGet:async(_url,_headers,{signal})=>{calls++;producerSignal=signal;if(calls>1)return response([valuation()]);return new Promise(resolve=>release=resolve);}}),controller=new AbortController();
 const pending=source.load('2330.TW',{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending);assert.equal(producerSignal.aborted,true);release(response([valuation()]));await new Promise(resolve=>setImmediate(resolve));await source.load('2330.TW',{});assert.equal(calls,2);
});
test('TWSE malformed responses fail closed and rate-limit retry time is preserved',async()=>{
 for(const bad of [{status:200,body:'{}'},{status:200,body:'not JSON'},{status:200,body:'[]'}]){const [source]=createTwseFinancialSources({now:()=>NOW,httpsGet:async()=>bad});await assert.rejects(source.load('2330.TW',{}),{code:'FUNDAMENTALS_SOURCE'});}
 const [limited]=createTwseFinancialSources({now:()=>NOW,httpsGet:async()=>({status:429,headers:{'retry-after':'120'},body:''})});await assert.rejects(limited.load('2330.TW',{}),error=>error.code==='RATE_LIMITED'&&error.retryAt===NOW+120000);
});
