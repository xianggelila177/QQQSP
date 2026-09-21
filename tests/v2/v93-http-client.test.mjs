import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {adminAuthorized,isDirectLoopback} from '../../lib/http-auth.js';
import {publicSourceHealth} from '../../lib/source-health-public.js';
import {queryMarketDetail} from '../../scripts/market-context-client.mjs';
import {detailCliOptions} from '../../scripts/market-detail-client.mjs';
import Validator from '../support/schema-validator.mjs';
import {detailResponseSchema,detailQuerySchema,buildDetailDocs} from '../../scripts/build-detail-docs.mjs';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {parseDetailQuery,buildMarketDetail} from '../../lib/market-detail.js';
const diagnosticSentinel='SECRET_SENTINEL';
const key='readonly_'.repeat(5),admin='administrator_'.repeat(4),now=Date.parse('2026-09-18T14:00:00Z');
async function fixture(t,extra={}){
 let reads=0;
 const app=createApplication({now:()=>now,env:{PORT:0,LOG_FILE:'',LLM_API_KEY:key,STATS_TOKEN:admin,FUNDAMENTALS_ENABLED:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',...extra},telemetry:createTelemetry(),upstream:async()=>{throw Error('network forbidden');},providerOverrides:{fetchQuote:async symbol=>{reads++;return {symbol,price:100,currency:'USD',instrumentType:'EQUITY',quoteAt:now,sourceCheckedAt:now,src:'fixture'};}}});
 app.start();await once(app.httpServer,'listening');t.after(()=>app.stop());return {app,base:'http://127.0.0.1:'+app.httpServer.address().port,reads:()=>reads};
}
test('v93 administrator authorization rejects forwarding, aliases and duplicate headers',()=>{
 const request={headers:{host:'localhost:8567'},socket:{remoteAddress:'::ffff:127.0.0.1'},rawHeaders:[]};
 assert.ok(isDirectLoopback(request));assert.ok(adminAuthorized(request,''));
 for(const header of ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','cf-connecting-ip','true-client-ip'])assert.equal(isDirectLoopback({...request,headers:{...request.headers,[header]:'127.0.0.1'}}),false);
 assert.equal(isDirectLoopback({...request,headers:{host:'attacker.example'}}),false);
 assert.equal(isDirectLoopback({...request,headers:{host:'localhost','sec-fetch-site':'cross-site'}}),false);
 assert.equal(adminAuthorized(request,admin),false);
 assert.ok(adminAuthorized({...request,headers:{...request.headers,'x-admin-token':admin}},admin));
 assert.equal(adminAuthorized({...request,headers:{...request.headers,'x-admin-token':admin},rawHeaders:['X-Admin-Token',admin,'x-admin-token',admin]},admin),false);
});
test('v93 watchlist writes require an administrator key; read-only key cannot write',async t=>{
 const f=await fixture(t,{HISTORY_BACKGROUND_ENABLED:'1'}),before=f.app.services.historyPrewarm.status().persistentWatchlist;
 for(const headers of [{},{Authorization:'Bearer '+key},{'X-Admin-Token':key}]){
  const r=await fetch(f.base+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{"symbols":["NVDA"]}'});assert.equal(r.status,401);assert.deepEqual(f.app.services.historyPrewarm.status().persistentWatchlist,before);
 }
 const r=await fetch(f.base+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':admin},body:'{"symbols":["NVDA"]}'});assert.equal(r.status,200);assert.deepEqual(f.app.services.historyPrewarm.status().persistentWatchlist,['NVDA']);
});
test('v93 browser details are cache-only and the Agent endpoint is authenticated',async t=>{
 const f=await fixture(t);
 const publicRead=await fetch(f.base+'/api/detail?symbol=NVDA');assert.equal(publicRead.status,200);assert.equal((await publicRead.json()).schema_version,2);assert.equal(f.reads(),0);
 const noKey=await fetch(f.base+'/api/v2/market-detail',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"symbol":"NVDA"}'});assert.equal(noKey.status,401);assert.equal((await noKey.json()).schema_version,2);assert.equal(f.reads(),0);
 const data=await queryMarketDetail({symbol:'NVDA',max_wait_ms:150},{apiKey:key,baseUrl:f.base});assert.equal(data.schema_version,2);assert.equal(data.sections.quote.data.price,100);assert.ok(data.sections.order_book);assert.equal(data.profile,'snapshot');assert.ok(data.quality.missing_fields.includes('fundamentals.volumeRatio'));assert.ok(!data.sections.daily);assert.equal(f.app.services.engine.diagnostics().subscribers,0);
});
test('v93 v1 and v2 share one token bucket instead of doubling provider demand',async t=>{
 const f=await fixture(t);for(let i=0;i<3;i++){
  const endpoint=i%2?'/api/v2/market-detail':'/api/v1/market-context',query=i%2?{symbol:'NVDA',max_wait_ms:0}:{symbol:'NVDA',include:['quote'],max_wait_ms:0};
  const r=await fetch(f.base+endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(query)});assert.ok([200,503].includes(r.status));await r.arrayBuffer();
 }
 const r=await fetch(f.base+'/api/v2/market-detail',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{"symbol":"NVDA"}'});assert.equal(r.status,429);assert.ok(r.headers.get('retry-after'));
});
test('v93 public provider diagnostics do not leak watched security identities or arbitrary metadata',()=>{
 const output=publicSourceHealth({fundamentals:{sources:{source:{ttlMs:1000,securities:{PRIVATE_SYMBOL:{inflight:true,code:'FAIL'}}}}},stream:{status:'open',symbols:['PRIVATE_SYMBOL'],secret:diagnosticSentinel},polling:{secret:diagnosticSentinel}});
 assert.ok(!JSON.stringify(output).includes('PRIVATE_SYMBOL'));assert.ok(!JSON.stringify(output).includes('SECRET_SENTINEL'));assert.equal(output.fundamentals.sources.source.tracked,1);
});
test('v93 published v2 schema validates records, compact rows, empty fields and negative assertions',()=>{
 const validator=new Validator({allErrors:true}),check=validator.compile(detailResponseSchema),input=validator.compile(detailQuerySchema);
 for(const format of ['objects','compact']){
  const query=parseDetailQuery({symbol:'NVDA',profile:'analysis',format}),quote={symbol:'NVDA',price:100,currency:'USD',instrumentType:'EQUITY',quoteAt:now,sourceCheckedAt:now,src:'fixture',charts:{intraday:[{t:now/1000,c:100,v:1}]}};
  const raw=buildMarketContext({query,requestId:'fixture',generatedAt:now,quote});const out=buildMarketDetail(raw,query);
  assert.ok(check(out),JSON.stringify(check.errors));const bad=structuredClone(out);delete bad.sections.fundamentals.data.fields.peTTM;assert.equal(check(bad),false);
  const badRow=structuredClone(out);if(format==='objects')badRow.sections.intraday.records[0].invented=true;else badRow.sections.intraday.rows[0].push(123);assert.equal(check(badRow),false);
 }
 for(const q of [{symbol:'NVDA'},{symbol:'NVDA',profile:'analysis',daily_before:'2026-09-01',daily_series_id:'test'}])assert.ok(input(q),JSON.stringify(input.errors));
 for(const q of [{symbol:'NVDA',profile:'raw'},{symbol:'NVDA',format:'raw'},{symbol:'NVDA',unexpected:true},{symbol:'NVDA',daily_before:'2026-09-01'}])assert.equal(input(q),false);
 buildDetailDocs(new URL('../..',import.meta.url).pathname,{check:true});
});
test('v93 new client preserves safe transport, wrong identity and version failures',async()=>{
 let seen;
 const data={schema_version:2,status:'partial',instrument:{symbol:'NVDA'},sections:{}};
 const fake=async(url,options)=>{seen={url,options};return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});};
 await queryMarketDetail({symbol:'NVDA'},{apiKey:key,baseUrl:'https://example.com',fetchImpl:fake});assert.equal(seen.url,'https://example.com/api/v2/market-detail');assert.equal(seen.options.redirect,'error');
 for(const bad of [{...data,schema_version:1},{...data,instrument:{symbol:'AMD'}}])await assert.rejects(queryMarketDetail({symbol:'NVDA'},{apiKey:key,baseUrl:'https://example.com',fetchImpl:async()=>new Response(JSON.stringify(bad),{headers:{'Content-Type':'application/json'}})}));
 await assert.rejects(queryMarketDetail({symbol:'NVDA'},{apiKey:key,baseUrl:'http://public.example',fetchImpl:fake}),{code:'INVALID_BASE_URL'});
 assert.equal(detailCliOptions(['NVDA','--profile','analysis','--format','compact','--daily-bars','30']).query.daily_bar_count,30);
 assert.throws(()=>detailCliOptions(['NVDA','--output','.env.json']));assert.throws(()=>detailCliOptions(['NVDA','--wait-ms','oops']));
});
