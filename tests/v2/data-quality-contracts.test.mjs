import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from '../support/schema-validator.mjs';
import {responseSchema} from '../../scripts/build-context-docs.mjs';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {parseContextQuery} from '../../lib/market-context-service.js';
import {createNewsService} from '../../lib/news.js';
import {normalizeTwseValuations,normalizeTwseCompany} from '../../lib/providers/twse-financials.js';
import {normalizeFinancialRecord,selectFinancialRecord} from '../../lib/financial-candidates.js';

test('public schema accepts merged news provenance and dated official financial evidence together',async()=>{
 const now=Date.parse('2026-10-07T08:45:00Z'),symbol='2330.TW';
 const specs=[{id:'twse-valuations',ttlMs:300000},{id:'twse-company',ttlMs:21600000}];
 const raw=[normalizeTwseValuations(symbol,[{Code:'2330',Date:'20261006',PEratio:'29.96',PBratio:'10.42',FiscalYearQuarter:'2026Q2'}],{now}),
  normalizeTwseCompany(symbol,[{'公司代號':'2330','出表日期':'1151006','已發行普通股數或TDR原股發行股數':'25932370067'}],{now})];
 const entries=raw.map((record,i)=>({id:specs[i].id,data:normalizeFinancialRecord(symbol,record,{source:specs[i].id,now,ttlMs:specs[i].ttlMs,maxAgeMs:604800000})}));
 const fundamentals=selectFinancialRecord(symbol,entries,specs,{now,maxAgeMs:604800000});
 const newsService=createNewsService({now:()=>now,httpsGet:async()=>({status:200,body:'<rss><channel></channel></rss>'}),
  yahooNews:async()=>[{title:'TSMC earnings report',tickers:[symbol],src:'Reuters',link:'https://www.reuters.com/technology/tsmc-test-story',t:now-1000}],eastmoneyNews:async()=>[]});
 try{
  const news=await newsService.requestNews(symbol);
  const out=buildMarketContext({query:parseContextQuery({symbol,include:['quote','fundamentals','news']}),requestId:'offline-contract-test',generatedAt:now,
   quote:{symbol,instrumentType:'EQUITY',currency:'TWD',price:2585,quoteAt:Date.parse('2026-10-07T05:30:00Z'),sourceCheckedAt:now,src:'twse-mis',priceSession:'REGULAR',marketState:'CLOSED',fundamentals},news});
  const validate=new Ajv2020({allErrors:true}).compile(responseSchema);
  assert.ok(validate(out),JSON.stringify(validate.errors));
  assert.equal(out.sections.news.coverage.quality.source_attempts.length,2);
  assert.equal(out.sections.news.data.items[0].headline_tone.target_direction,'unknown');
  const fields=out.sections.fundamentals.data.fields;
  assert.equal(fields.peTTM.business_date,'2026-10-06');
  assert.equal(fields.peTTM.content_freshness.status,'within-age-window');
  assert.equal(fields.sharesOutstanding.as_of_ms,null);
  assert.equal(fields.sharesOutstanding.date_basis,'dataset-publication');
  assert.equal(fields.sharesOutstanding.content_freshness.status,'unverified');
 }finally{newsService.stopNews();}
});
