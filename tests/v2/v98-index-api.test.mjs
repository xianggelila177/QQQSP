import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,copyFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHttp} from '../../lib/http.js';
import {historyQuery} from '../../lib/history-contract.js';
import {canonicalSymbol,INDEX_SYMBOL_ALIASES} from '../../lib/symbol-canonical.js';
import {parseContextQuery,contextFromSearch} from '../../lib/context-query.js';
import {parseDetailQuery,createMarketDetailService} from '../../lib/market-detail.js';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {createMarketContextHttp} from '../../lib/market-context-http.js';
import {queryMarketApi,streamQuotes} from '../../scripts/market-api-client.mjs';
import {queryMarketContext,queryMarketDetail} from '../../scripts/market-context-client.mjs';
import {querySchema} from '../../scripts/build-context-docs.mjs';
import {detailQuerySchema} from '../../scripts/build-detail-docs.mjs';
const key='v98_index_api_fixture_'.repeat(3),now=Date.parse('2026-09-21T14:00:00Z');
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
const wanted=['NVDA','^GSPC','^SOX'];
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}));return 'http://127.0.0.1:'+s.address().port;}
function contextService(t){const calls=[],service=createMarketContextService({now:()=>now,engine:{read(symbols){calls.push(...symbols);return symbols.map(symbol=>({symbol,price:100,currency:'USD',quoteAt:now,sourceCheckedAt:now,src:'fixture'}));}}});t.after(()=>service.close());return {service,calls};}
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const single=(symbol,version=1)=>({schema_version:version,status:'partial',instrument:{symbol},sections:{}});
const batch=symbols=>({schema_version:1,status:'partial',results:symbols.map(s=>single(s))});
test('v98 API query canonicalizes only verified aliases before identity validation and duplicate checks',()=>{
 assert.deepEqual(parseContextQuery({symbols:['nvda',' ^gspc ','^sox'],include:['quote']}).symbols,wanted);
 assert.deepEqual(parseContextQuery({symbols:['nvda',' ^spx ','^sox'],include:['quote']}).symbols,wanted);
 assert.deepEqual(contextFromSearch(new URLSearchParams('symbols=NVDA%2C%5ESPX%2C%5ESOX&include=quote')).symbols,wanted);
 assert.equal(parseContextQuery({symbol:'^spx'}).symbol,'^GSPC');assert.equal(parseDetailQuery({symbol:'^spx'}).symbol,'^GSPC');
 for(const symbol of ['NVDA','^GSPC','^SPX','^SOX'])for(const schema of [querySchema,detailQuerySchema])assert.ok(new RegExp(schema.properties.symbol.pattern).test(symbol));
 for(const q of [{symbols:['NVDA','^NOTREAL']},{symbol:'^'},{symbol:'^^GSPC'},{symbol:'^GSPC/..'},{symbol:'https://evil.test'},{symbol:'^SPX'.padStart(65,' ')},{symbols:['^SPX','^GSPC']},{symbols:['nvda','NVDA']},{symbols:['NVDA','^SOX'],include:['daily']},{symbol:'NVDA',symbols:['^SOX']}])assert.throws(()=>parseContextQuery(q),{code:'BAD_CONTEXT_QUERY'});
 assert.throws(()=>parseDetailQuery({symbols:['NVDA','^SOX']}),{code:'BAD_CONTEXT_QUERY'});
});
test('v98 real GET and POST mixed index batches preserve canonical order, quota and independent results',async t=>{
 const {service,calls}=contextService(t),base=await server(t,createMarketContextHttp({service,apiKey:key,allowGet:true,now:()=>now}));
 for(const method of ['GET','POST']){
  const query={symbols:['NVDA','^SPX','^SOX'],include:['quote'],max_wait_ms:0},url=base+'/api/v1/market-context'+(method==='GET'?'?'+new URLSearchParams({symbols:query.symbols.join(','),include:'quote',max_wait_ms:'0'}):'');
  const r=await fetch(url,{method,headers,...(method==='POST'?{body:JSON.stringify(query)}:{})});assert.equal(r.status,200);const out=await r.json();
  assert.deepEqual(out.results.map(v=>v.instrument.symbol),wanted);assert.deepEqual(out.results.map(v=>v.instrument.type),['EQUITY','INDEX','INDEX']);assert.equal(out.coverage.quota_cost,3);assert.equal(out.results[1].sections.quote.data.price_unit,'points');
 }
 assert.ok(!calls.includes('^SPX'));assert.ok(calls.includes('^GSPC'));
 const bad=await fetch(base+'/api/v1/market-context',{method:'POST',headers,body:JSON.stringify({symbols:['NVDA','^NOTREAL'],include:['quote']})});assert.equal(bad.status,400);
});
test('v98 v2 single detail accepts the index alias while its single POST contract stays explicit',async t=>{
 const {service}=contextService(t),handler=createMarketContextHttp({service:createMarketDetailService(service),apiKey:key,parseQuery:value=>{parseDetailQuery(value);return value;},scopeQuery:parseDetailQuery,schemaVersion:2,now:()=>now}),base=await server(t,handler);
 const r=await fetch(base+'/api/v2/market-detail',{method:'POST',headers,body:JSON.stringify({symbol:'^SPX',max_wait_ms:0})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.schema_version,2);assert.equal(data.instrument.symbol,'^GSPC');
 const unsupported=await fetch(base+'/api/v2/market-detail',{method:'POST',headers,body:JSON.stringify({symbols:['NVDA','^SOX']})});assert.equal(unsupported.status,400);
 assert.equal((await fetch(base+'/api/v2/market-detail?symbol=%5ESPX',{headers})).status,405);
});
test('v98 both SDK generations and stream URLs use canonical identities and still reject response reordering',async()=>{
 for(const [client,version] of [[queryMarketContext,1],[queryMarketDetail,2]]){
  let sent;const out=await client({symbol:' ^spx '},{apiKey:key,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return response(single('^GSPC',version));}});assert.equal(out.instrument.symbol,'^GSPC');assert.equal(sent.symbol,'^GSPC');
  await assert.rejects(client({symbol:'^SPX'},{apiKey:key,fetchImpl:async()=>response(single('^SOX',version))}),{code:'IDENTITY_MISMATCH'});
 }
 for(const method of ['GET','POST']){
  const result=await queryMarketApi({symbols:['NVDA','^SPX','^SOX'],include:['quote']},{apiKey:key,method,fetchImpl:async(url,options)=>{assert.deepEqual(method==='POST'?JSON.parse(options.body).symbols:new URL(url).searchParams.get('symbols').split(','),wanted);return response(batch(wanted));}});assert.deepEqual(result.data.results.map(v=>v.instrument.symbol),wanted);
 }
 await assert.rejects(queryMarketApi({symbols:['NVDA','^SPX','^SOX'],include:['quote']},{apiKey:key,fetchImpl:async()=>response(batch([...wanted].reverse()))}),{code:'IDENTITY_MISMATCH'});
 let streamed=0;for await(const item of streamQuotes(['NVDA','^SPX','^SOX'],{apiKey:key,fetchImpl:async url=>{assert.deepEqual(new URL(url).searchParams.get('symbols').split(','),wanted);return new Response('event: quote\ndata: '+JSON.stringify(batch(wanted))+'\n\n',{headers:{'content-type':'text/event-stream'}});}})){assert.equal(item.event,'quote');streamed++;}assert.equal(streamed,1);
});

test('v98 legacy SDK remains a standalone copied file with canonical aliases matching the server',async t=>{
 const parent=await realpath(tmpdir()),dir=await mkdtemp(path.join(parent,'qqqsp-client-v98-'));
 t.after(async()=>{assert.equal(path.dirname(await realpath(dir)),parent);await rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'client.mjs');await copyFile(new URL('../../scripts/market-context-client.mjs',import.meta.url),file);const client=await import(pathToFileURL(file).href);
 for(const symbol of [...Object.keys(INDEX_SYMBOL_ALIASES),' ^spx ','ｓｐｘ','^SOX','NVDA','^UNRECOGNIZED']){
  const query={symbol},expected=canonicalSymbol(symbol);let sent;
  const data=await client.queryMarketContext(query,{apiKey:key,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return response(single(expected));}});
  assert.equal(data.instrument.symbol,expected);assert.equal(sent.symbol,expected);assert.equal(query.symbol,symbol);
 }
});
test('v98 public quote, news, samples and stream routes share canonical index identities',async t=>{
 const watches=[],activated=[],requested=[],reads=[];
 const quote=symbol=>({symbol,price:100,currency:'USD',quoteAt:now,sourceCheckedAt:now,src:'fixture'});
 const service=createHttp({getCachedQuote:async symbol=>{reads.push(symbol);return quote(symbol);},activateNews:s=>activated.push(s),requestNews:async s=>{requested.push(s);return {items:[],updatedAt:now};},samples:{snapshot:s=>({symbol:s}),subscribe:()=>()=>{}},
  engine:{read:symbols=>symbols.map(quote),watch:symbols=>{watches.push(symbols);return()=>{};},subscribe:()=>()=>{},diagnostics:()=>({active:[]})}},
  {env:{PORT:0,SYMBOLS:'^SPX,NVDA',LOG_FILE:''},now:()=>now,monitorCore:false});
 service.startListen();await once(service.httpServer,'listening');t.after(()=>service.stop());const base='http://127.0.0.1:'+service.httpServer.address().port;
 const params=new URLSearchParams({symbols:'NVDA,^SPX,^GSPC'}),r=await fetch(base+'/api/market?'+params);assert.equal(r.status,200);assert.deepEqual((await r.json()).map(q=>q.symbol),['NVDA','^GSPC']);
 assert.deepEqual((await(await fetch(base+'/api/quote')).json()).map(q=>q.symbol),['^GSPC','NVDA']);
 const news=await(await fetch(base+'/api/news?'+params)).json();assert.deepEqual(Object.keys(news),['NVDA','^GSPC']);assert.deepEqual(activated,['NVDA','^GSPC']);assert.deepEqual(requested,activated);
 const sample=await(await fetch(base+'/api/samples?symbol=%5ESPX')).json();assert.equal(sample.symbol,'^GSPC');
 const controller=new AbortController(),stream=await fetch(base+'/api/stream?symbols=%5ESPX&history=off',{signal:controller.signal});assert.equal(stream.status,200);assert.deepEqual(watches.at(-1),['^GSPC']);await stream.body.cancel();controller.abort();
 assert.ok(!reads.includes('^SPX'));assert.equal((await fetch(base+'/api/market?symbols=%5EGSPC%2F..')).status,400);
});
test('v98 historical query canonicalizes identity while retaining continuation and source metadata',()=>{
 const q=historyQuery(' ^spx ','daily',{count:17,before:'2026-09-18',seriesId:'naver-index-history:verified'});
 assert.deepEqual(q,{symbol:'^GSPC',period:'daily',count:17,before:'2026-09-18',seriesId:'naver-index-history:verified'});
 assert.throws(()=>historyQuery('^SPX','unsupported'),{code:'BAD_HISTORY_QUERY'});
});
