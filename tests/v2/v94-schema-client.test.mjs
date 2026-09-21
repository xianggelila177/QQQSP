import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Validator from '../support/schema-validator.mjs';
import {querySchema,responseSchema,batchSchema,auxiliarySchemas,openapi,buildContextDocs} from '../../scripts/build-context-docs.mjs';
import {detailQuerySchema,detailResponseSchema,buildDetailDocs} from '../../scripts/build-detail-docs.mjs';
import {parseContextQuery} from '../../lib/context-query.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {buildMarketDetail,parseDetailQuery} from '../../lib/market-detail.js';
import {marketStatus,tradingCalendar} from '../../lib/market-calendar-api.js';
import {queryMarketApi,advancedCliOptions,apiEndpoint,streamQuotes} from '../../scripts/market-api-client.mjs';
const now=Date.parse('2026-09-21T16:00Z'),key='fixture_readonly_'.repeat(3);
const validator=new Validator({allErrors:true});
// Validate multiple cases in one standard-validation call, reducing Python startup cost offline.
function validateCases(schema,values){const v=validator.compile({type:'array',items:schema});assert.equal(v(values),true,JSON.stringify(v.errors)?.slice(0,1200));}
const root=new URL('../..',import.meta.url).pathname;
test('v94 query schemas represent all optional controls and reject unknown controls',()=>{
 const cases=[{symbol:'NVDA'},{symbols:['NVDA','SPY'],include:['quote']},{symbol:'NVDA',include:['daily'],adjustment:'split_dividend',daily_granularity:'monthly'},{symbol:'NVDA',include:['intraday'],intraday_date:'2026-09-18',aggregate_minutes:15},{symbol:'NVDA',include:['samples'],aggregate_source:'samples',aggregate_minutes:5},{symbol:'NVDA',include:['corporate_actions'],format:'csv',actions_start:'2024-06-01',actions_end:'2024-07-01'}];
 validateCases(querySchema,cases);for(const c of cases)parseContextQuery(c);
 const invalid=[{symbol:'NVDA',symbols:['NVDA']},{symbols:['NVDA'],include:['daily']},{symbol:'NVDA',aggregate_minutes:2},{symbol:'NVDA',format:'csv'},{symbol:'NVDA',actions_start:'2024-01-01'},{symbol:'NVDA',invented:true}];
 validateCases({not:querySchema},invalid);for(const c of invalid)assert.throws(()=>parseContextQuery(c));
});
test('v94 published row/object schemas validate historical, aggregated, adjusted and action sections',()=>{
 const outputs=[],details=[];for(const controls of [{include:['daily'],adjustment:'split',daily_granularity:'weekly'},{include:['intraday'],intraday_date:'2026-09-18'},{include:['intraday'],intraday_date:'2026-09-18',aggregate_minutes:15},{include:['corporate_actions']}]){
  const query=parseContextQuery({symbol:'NVDA',...controls}),values={requestId:'fixture',generatedAt:now,daily:{symbol:'NVDA',currency:'USD',source:'fixture',adjustmentBasis:'split',bars:[{t:Date.parse('2026-09-14T00:00Z')/1000,periodStart:'2026-09-14',lastTradingDate:'2026-09-18',o:100,h:110,l:99,c:105,v:10,adjustedClose:105}]},intraday:{symbol:'NVDA',source:'fixture',currency:'USD',volumeUnit:'shares',points:[{t:Date.parse('2026-09-18T13:30Z')/1000,o:100,h:101,l:99,c:100,v:50}],start:'2026-09-18',end:'2026-09-18',sourceCheckedAt:now},corporate_actions:{symbol:'NVDA',source:'fixture',events:[{id:'fixture-event',type:'split',ex_date:'2024-06-10',ratio:10,source:'fixture',amount_basis:'not_applicable'}],start:'2024-06-01',end:'2024-07-01',filterBasis:'ex_date',sourceCheckedAt:now}};
  const out=buildMarketContext({query,...values});outputs.push(out);for(const format of ['objects','compact']){const q=parseDetailQuery({symbol:'NVDA',profile:'analysis',format,...controls});details.push(buildMarketDetail(out,q));}
 }
 validateCases(responseSchema,outputs);validateCases(detailResponseSchema,details);
 const invalid=structuredClone(outputs);invalid[1].sections.intraday.rows[0].push('extra');const v=validator.compile({type:'array',items:responseSchema});assert.equal(v(invalid),false);
});
test('v94 published envelope schema validates batch and denies missing batch identities',()=>{
 const query=parseContextQuery({symbol:'NVDA',include:['quote']}),out=buildMarketContext({query,requestId:'test',generatedAt:now}),batch={schema_version:1,request_id:'test',generated_at_ms:now,status:'unavailable',coverage:{requested_symbols:1,returned_symbols:1,quota_cost:1},results:[out]};
 const published=JSON.parse(fs.readFileSync(root+'/public/market-context.schema.json'));validateCases(published,[out,batch]);const bad=structuredClone(batch);delete bad.results[0].instrument;const v=validator.compile(published);assert.equal(v(bad),false);
});
test('v94 v2 analysis query schema exposes new controls while snapshots reject them',()=>{
 validateCases(detailQuerySchema,[{symbol:'NVDA'},{symbol:'NVDA',profile:'analysis',include:['daily'],adjustment:'raw'},{symbol:'NVDA',profile:'analysis',include:['corporate_actions']}]);
 validateCases({not:detailQuerySchema},[{symbol:'NVDA',adjustment:'raw'},{symbol:'NVDA',include:['quote']},{symbol:'NVDA',symbols:['NVDA']}]);
});
test('v94 calendar and status OpenAPI response shapes match actual responses',()=>{
 validateCases(auxiliarySchemas['market-status'],[{...marketStatus({exchange:'us'},{now}),request_id:'test'}]);validateCases(auxiliarySchemas['trading-calendar'],[{...tradingCalendar({exchange:'us',start:'2026-11-26',end:'2026-11-27'}),request_id:'test'}]);
 for(const route of ['market-status','trading-calendar','movers','quote-stream','capabilities'])assert.ok(openapi.paths['/api/v1/'+route].get.security.length);assert.ok(openapi.paths['/api/v1/market-context'].get.responses['304']);assert.ok(!openapi.paths['/api/v1/market-context'].post.responses['304']);
 buildContextDocs(root,{check:true});buildDetailDocs(root,{check:true});
});
test('v94 advanced CLI preserves optional fields, rejects unsafe queries and exposes batch',()=>{
 const out=advancedCliOptions(['NVDA','--include','daily','--adjustment','split','--granularity','weekly','--daily-bars','20','--get']);assert.equal(out.method,'GET');assert.equal(out.query.daily_granularity,'weekly');
 assert.deepEqual(advancedCliOptions(['NVDA,SPY','--include','quote']).query.symbols,['NVDA','SPY']);
 for(const args of [['NVDA','--minutes','oops'],['NVDA','--unknown','x'],['NVDA','--get','--get'],['NVDA','--stream','--output','x.json']])assert.throws(()=>advancedCliOptions(args));
 for(const url of ['http://example.com','https://user:password@example.com','https://example.com/?token=secret','https://example.com/path'])assert.throws(()=>apiEndpoint(url,'/api/v1/market-context'),{code:'INVALID_BASE_URL'});
});
test('v94 client checks batch identity, version, redirects, conditional reads and response size',async()=>{
 const data={schema_version:1,status:'partial',instrument:{symbol:'NVDA'},sections:{}};
 const respond=x=>async()=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
 await assert.rejects(queryMarketApi({symbol:'NVDA'},{apiKey:key,baseUrl:'https://example.com',fetchImpl:respond({...data,instrument:{symbol:'SPY'}})}),{code:'IDENTITY_MISMATCH'});
 const r=await queryMarketApi({symbol:'NVDA',include:['quote']},{apiKey:key,baseUrl:'https://example.com',method:'GET',etag:'W/"a"',fetchImpl:async(url,o)=>{assert.ok(url.includes('symbol=NVDA'));assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer '+key);return new Response(null,{status:304,headers:{ETag:'W/"a"'}});}});assert.equal(r.notModified,true);
 await assert.rejects(queryMarketApi({symbols:['NVDA','SPY'],include:['quote']},{apiKey:key,baseUrl:'https://example.com',fetchImpl:respond({schema_version:1,status:'complete',results:[data]})}),{code:'IDENTITY_MISMATCH'});
 await assert.rejects(queryMarketApi({symbol:'NVDA'},{apiKey:key,baseUrl:'https://example.com',fetchImpl:async()=>new Response('x'.repeat(2097153),{headers:{'Content-Type':'application/json'}})}),{code:'RESPONSE_TOO_LARGE'});
});
test('v94 streaming client transmits key only in header and yields bounded event frames',async()=>{
 const seen=[];for await(const event of streamQuotes(['NVDA'],{apiKey:key,baseUrl:'https://example.com',fetchImpl:async(url,o)=>{assert.ok(!url.includes(key));assert.equal(o.headers.Authorization,'Bearer '+key);return new Response('event: quote\ndata: {"schema_version":1,"results":[]}\n\nevent: end\ndata: {"code":"LEASE_ENDED"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}}))seen.push(event);
 assert.equal(seen.length,2);assert.equal(seen[1].data.code,'LEASE_ENDED');
});
