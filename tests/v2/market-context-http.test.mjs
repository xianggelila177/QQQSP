import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import http from 'node:http';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
import {createContextLimiter,createMarketContextHttp} from '../../lib/market-context-http.js';
import {loadConfig} from '../../config.js';
const token='test'.repeat(10),now=Date.parse('2026-09-18T14:00:00Z');
test('read-only key cannot reuse the administrator token',()=>{assert.throws(()=>loadConfig({LLM_API_KEY:token,STATS_TOKEN:token}),/must differ/);assert.throws(()=>loadConfig({LLM_API_KEY:'short'}),/32-256/);assert.equal(loadConfig({LLM_API_KEY:token}).LLM_API_KEY,token);});
async function fixture(t){let calls=0;const app=createApplication({now:()=>now,env:{PORT:0,LOG_FILE:'',LLM_API_KEY:token,FUNDAMENTALS_ENABLED:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:''},telemetry:createTelemetry(),upstream:async()=>{throw Error('unexpected external IO');},providerOverrides:{fetchQuote:async symbol=>{calls++;return {symbol,price:100,currency:'USD',instrumentType:'EQUITY',quoteAt:now-1000,sourceCheckedAt:now,src:'fixture'};}}});app.start();await once(app.httpServer,'listening');t.after(()=>app.stop());return {app,url:'http://127.0.0.1:'+app.httpServer.address().port+'/api/v1/market-context',calls:()=>calls};}
test('auth precedes expensive work and only the dedicated header key is accepted',async t=>{
 const f=await fixture(t);for(const headers of [{},{Authorization:'Bearer wrong'},{'X-Admin-Token':token}]){const r=await fetch(f.url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{"symbol":"NVDA"}'});assert.equal(r.status,401);assert.ok(!JSON.stringify(await r.json()).includes(token));}assert.equal(f.calls(),0);
 const r=await fetch(f.url+'?api_key='+token,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"symbol":"NVDA"}'});assert.equal(r.status,401);assert.equal(f.calls(),0);
});
test('authenticated native HTTP returns complete JSON and preserves saved watchlist',async t=>{
 const f=await fixture(t),before=f.app.services.historyPrewarm.status().persistentWatchlist;
 const r=await fetch(f.url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({symbol:'NVDA',include:['quote'],max_wait_ms:200})});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const data=await r.json();assert.equal(data.schema_version,1);assert.equal(data.sections.quote.data.price,100);assert.ok(data.request_id);assert.equal(data.status,'complete');assert.deepEqual(f.app.services.historyPrewarm.status().persistentWatchlist,before);assert.equal(f.app.services.engine.diagnostics().subscribers,0);
});
test('strict payload and method handling keep malformed clients out of data services',async t=>{
 const f=await fixture(t),auth={Authorization:'Bearer '+token};// v94 adds authenticated GET; a missing query remains invalid and starts no work.
 assert.equal((await fetch(f.url,{headers:auth})).status,400);
 assert.equal((await fetch(f.url,{method:'PUT',headers:auth})).status,405);
 assert.equal((await fetch(f.url,{method:'POST',headers:auth,body:'{}'})).status,415);
 assert.equal((await fetch(f.url,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{"symbol":'})).status,400);
 assert.equal((await fetch(f.url,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'x'.repeat(8193)})).status,413);assert.equal(f.calls(),0);
});
test('token bucket allows burst3 and enforces a separate rolling20-per-minute bound',()=>{
 let clock=0;const limit=createContextLimiter({now:()=>clock});assert.ok(limit.consume().ok);assert.ok(limit.consume().ok);assert.ok(limit.consume().ok);assert.equal(limit.consume().ok,false);
 for(let i=0;i<17;i++){clock+=3000;assert.ok(limit.consume().ok);}clock+=3000;const rejected=limit.consume();assert.equal(rejected.ok,false);assert.ok(rejected.retryAfter>=6);clock=60001;assert.ok(limit.consume().ok);
});
test('wire response cap and chunked request cap are enforced without silent truncation',async t=>{
 let calls=0;const handler=createMarketContextHttp({apiKey:token,service:{query:async()=>{calls++;return {status:'complete',data:'x'.repeat(2*1024*1024)};}}}),server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const url='http://127.0.0.1:'+server.address().port;
 const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{"symbol":"NVDA"}'});assert.equal(r.status,422);assert.equal((await r.json()).error.code,'RESULT_TOO_LARGE');assert.equal(calls,1);
 const result=await new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,data}));});req.on('error',reject);req.write('x'.repeat(4100));req.end('x'.repeat(4100));});assert.equal(result.status,413);assert.equal(calls,1);
});
