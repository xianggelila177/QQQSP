import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {readSseEvent} from '../support/read-sse.mjs';
const pause=()=>new Promise(r=>setImmediate(r));
test('samples API is read-only; durable watchlist collects with no client and SSE resynchronizes',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'samples-http-'));let clock=Date.parse('2026-09-11T14:00:00Z'),calls=0;
 const app=createApplication({now:()=>clock,env:{PORT:0,HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',SAMPLES_STATE_PATH:directory,RECOVERY_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0',CACHE_MS:1},telemetry:createTelemetry(),upstream:async()=>{throw Error('unstubbed');},providerOverrides:{fetchChart:async()=>{throw Error('no history');},fetchQuote:async symbol=>{calls++;return {symbol,price:218.26,quoteAt:clock,sourceCheckedAt:clock,src:'fixture',currency:'USD',marketState:'REGULAR'};}}});
 t.after(async()=>{await app.stop();await fs.rm(directory,{recursive:true,force:true});});
 app.start();await once(app.httpServer,'listening');const url='http://127.0.0.1:'+app.httpServer.address().port;
 const cold=await fetch(url+'/api/samples?symbol=NVDA');assert.equal(cold.status,200);assert.equal(cold.headers.get('cache-control'),'no-store');assert.equal((await cold.json()).points.length,0);assert.equal(calls,0);
 assert.equal((await fetch(url+'/api/samples?symbol=../../etc/passwd')).status,400);assert.equal((await fetch(url+'/api/samples')).status,400);
 const saved=await fetch(url+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:['NVDA']})});assert.equal(saved.status,200);
 await pause();await pause();app.services.samples.runDue();
 const first=await fetch(url+'/api/samples?symbol=NVDA').then(r=>r.json());assert.equal(first.points.length,1);assert.equal(first.collecting,true);const before=calls;
 await fetch(url+'/api/samples?symbol=AAPL');assert.equal(calls,before);assert.deepEqual(app.services.samples.diagnostics().watchlist,['NVDA']);
 const controller=new AbortController();const response=await fetch(url+'/api/stream?symbols=NVDA',{signal:controller.signal});const reader=response.body.getReader();
 try{const reset=await readSseEvent(reader,{event:'samples'});assert.match(reset,/"reset":true/);assert.ok(reset.length<1000);}finally{controller.abort();await reader.cancel().catch(()=>{});}
 clock+=60000;app.services.engine.poke('NVDA');await pause();await pause();app.services.samples.runDue();assert.equal(app.services.samples.snapshot('NVDA').points.length,2);
 await app.stop();assert.ok((await fs.readdir(directory)).some(x=>x.endsWith('.json')));
});
