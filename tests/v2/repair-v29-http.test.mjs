import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createHttp} from '../../lib/http.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createTelemetry} from '../../log.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await wait(5);}assert.fail('condition not reached');}
async function fixture(t,{deps={},env={}}={}){
 const listeners=new Set(),macroListeners=new Set();let watches=0;
 const history={cache:new Map(),exportState:()=>({schemaVersion:1,entries:[]})},prewarm=createHistoryPrewarm({history});
 const engine={read:symbols=>symbols.map(symbol=>({symbol,price:100,quoteAt:Date.now(),currency:'USD'})),diagnostics:()=>({active:[]}),watch(){watches++;return()=>watches--;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 const macroMonitor={subscribe(fn){macroListeners.add(fn);return()=>macroListeners.delete(fn);},snapshot:()=>({revision:1,items:[]})};
 const service=createHttp({engine,macroMonitor,historyPrewarm:prewarm,getCachedQuote:async symbol=>({symbol,price:100,quoteAt:Date.now()}),yahooSearch:async()=>[],tencentSuggest:async()=>[],...deps},{env:{PORT:0,HTTP_REQUEST_DEADLINE_MS:1000,HTTP_SEARCH_DEADLINE_MS:1000,...env},monitorCore:false,telemetry:createTelemetry()});
 service.startListen();await once(service.httpServer,'listening');t.after(()=>service.stop());return {service,prewarm,url:'http://127.0.0.1:'+service.httpServer.address().port,counts:()=>({watches,listeners:listeners.size,macro:macroListeners.size,owners:prewarm.status().owners})};
}
async function stream(url,headers={}){const request=http.get(url,{headers});request.on('error',()=>{});const [res]=await once(request,'response');res.resume();return {request,res,close:()=>request.destroy()};}
test('R03 real quote HTTP admission rejects overflow and never starts a cancelled queued request',async t=>{
 let finish,calls=0;const held=new Promise(r=>finish=r);const f=await fixture(t,{env:{HTTP_QUOTE_ACTIVE_MAX:1,HTTP_QUOTE_QUEUE_MAX:1},deps:{getCachedQuote:async symbol=>{calls++;await held;return {symbol,price:100};}}});
 const first=fetch(f.url+'/api/market?symbols=QQQ');await until(()=>calls===1);const ctrl=new AbortController();const queued=fetch(f.url+'/api/market?symbols=SPY',{signal:ctrl.signal});const cancellation=assert.rejects(queued);await until(()=>f.service.diagnostics().admission.quotes.queued===1);
 const rejected=await fetch(f.url+'/api/market?symbols=AAPL');assert.equal(rejected.status,503);assert.equal(rejected.headers.get('retry-after'),'1');ctrl.abort();await cancellation;await until(()=>f.service.diagnostics().admission.quotes.queued===0);finish();assert.equal((await first).status,200);await wait(10);assert.equal(calls,1);
});
test('R03 client search disconnect aborts the actual dependency signal',async t=>{
 let signal;const f=await fixture(t,{deps:{yahooSearch:async(q,options)=>{signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));}}});
 const ctrl=new AbortController(),response=fetch(f.url+'/api/search?q=zzzxq&more=1',{signal:ctrl.signal}),failure=assert.rejects(response);await until(()=>signal);ctrl.abort();await failure;await until(()=>signal.aborted);await until(()=>f.service.diagnostics().admission.active===0);
});
test('R03 quote and macro streams share one connection budget; HEAD never consumes it',async t=>{
 const f=await fixture(t,{env:{SSE_MAX_CONNECTIONS:2}}),a=await stream(f.url+'/api/stream?symbols=QQQ'),b=await stream(f.url+'/api/macro/stream');t.after(()=>{a.close();b.close();});
 assert.equal(a.res.statusCode,200);assert.equal(b.res.statusCode,200);assert.equal((await fetch(f.url+'/api/stream?symbols=SPY',{method:'HEAD'})).status,200);assert.equal(f.service.diagnostics().streams.connections??f.service.diagnostics().streams.connections,2);
 const overflow=await fetch(f.url+'/api/stream?symbols=AAPL');assert.equal(overflow.status,503);assert.equal(overflow.headers.get('retry-after'),'5');a.close();b.close();await until(()=>f.service.diagnostics().streams.connections===0);assert.deepEqual(f.counts(),{watches:0,listeners:0,macro:0,owners:0});
});
test('R03 fifty stream open/close cycles return all subscriptions, owners and buffers to baseline',async t=>{
 const f=await fixture(t);for(let n=0;n<50;n++){const s=await stream(f.url+(n%2?'/api/macro/stream':'/api/stream?symbols=NVDA'));s.close();await until(()=>f.service.diagnostics().streams.connections===0);}
 assert.deepEqual(f.counts(),{watches:0,listeners:0,macro:0,owners:0});assert.equal(f.service.diagnostics().streams.bufferedBytes,0);
});
test('R13 allowed/rejected origins have consistent CORS on new GET, HEAD, OPTIONS and SSE routes',async t=>{
 const origin='http://frontend.test',f=await fixture(t,{env:{PUBLIC_ORIGIN:origin}});
 for(const route of ['/api/market?symbols=QQQ','/api/history/bundle?symbols=QQQ','/api/history/status','/readyz'])for(const method of ['GET','HEAD','OPTIONS']){
  const allowed=await fetch(f.url+route,{method,headers:{Origin:origin}});await allowed.text();assert.equal(allowed.headers.get('access-control-allow-origin'),origin);assert.match(allowed.headers.get('vary'),/Origin/);
  const denied=await fetch(f.url+route,{method,headers:{Origin:'http://wrong.test'}});await denied.text();assert.equal(denied.headers.get('access-control-allow-origin'),null);
 }
 for(const route of ['/api/stream?symbols=QQQ','/api/macro/stream']){const s=await stream(f.url+route,{Origin:origin});assert.equal(s.res.headers['access-control-allow-origin'],origin);assert.match(s.res.headers.vary,/Origin/);s.close();const head=await fetch(f.url+route,{method:'HEAD',headers:{Origin:origin}});assert.equal(head.headers.get('access-control-allow-origin'),origin);}
});
test('R11 read-only APIs preserve durable membership; explicit save is validated and origin-protected',async t=>{
 const f=await fixture(t);f.prewarm.retain(['QQQ','SPY']);for(const route of ['/api/market?symbols=AAPL','/api/AAPL','/api/history/bundle?symbols=AAPL'])await (await fetch(f.url+route)).text();assert.deepEqual(f.prewarm.status().persistentWatchlist,['QQQ','SPY']);
 const post=body=>fetch(f.url+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(null)).status,400);assert.equal((await post({symbols:['bad;symbol']})).status,400);assert.equal((await post({symbols:Array.from({length:101},(_,n)=>'A'+n)})).status,400);
 assert.equal((await fetch(f.url+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://wrong.test'},body:'{"symbols":[]}'})).status,403);
 assert.equal((await post({symbols:['NVDA']})).status,200);assert.deepEqual(f.prewarm.status().persistentWatchlist,['NVDA']);assert.equal((await post({symbols:[]})).status,200);assert.deepEqual(f.prewarm.status().watchlist,[]);
});
test('R02 a stalled POST body times out without later mutating persistent membership',async t=>{
 const f=await fixture(t,{env:{HTTP_REQUEST_DEADLINE_MS:40}});f.prewarm.retain(['QQQ']);const req=http.request(f.url+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}});req.on('error',()=>{});req.write('{"symbols":');const [res]=await once(req,'response');res.resume();assert.equal(res.statusCode,504);req.end('[]}');await wait(25);assert.deepEqual(f.prewarm.status().persistentWatchlist,['QQQ']);req.destroy();
});
test('R15 configured per-client quota is enforced on the actual HTTP path',async t=>{const f=await fixture(t,{env:{HTTP_SNAPSHOT_QUOTA:1}});assert.equal((await fetch(f.url+'/api/market?symbols=QQQ')).status,200);const second=await fetch(f.url+'/api/market?symbols=QQQ');assert.equal(second.status,429);assert.ok(Number(second.headers.get('retry-after'))>0);});
test('R18 container probe reads a custom PORT and rejects non-ready JSON even with HTTP 200',async t=>{
 let ready=true;const server=http.createServer((req,res)=>{assert.equal(req.url,'/readyz');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready,dataReady:false}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const run=async()=>{const child=spawn(process.execPath,['ops/healthcheck.mjs'],{env:{...process.env,PORT:String(server.address().port)},stdio:'ignore'});return (await once(child,'exit'))[0];};assert.equal(await run(),0);ready=false;assert.equal(await run(),1);
});
