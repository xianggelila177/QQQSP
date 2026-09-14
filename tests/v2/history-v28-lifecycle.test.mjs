import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {dailyData} from './history-v28-fixture.mjs';
const base=Date.parse('2026-09-11T14:16:00Z');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await wait(10);}assert.fail('condition timed out');}
test('background warms without browser; disconnect is not a stop and reselect updates membership',async()=>{
 let now=base,calls=0;const history=createHistoryService({now:()=>now,fetchChart:async s=>{calls++;return dailyData(s);}});
 const worker=createHistoryPrewarm({history,now:()=>now,tickMs:10});
 try{worker.retain(['NVDA','MRVL']);await worker.start();await until(()=>worker.status().ready===2);assert.equal(calls,2);
 now+=61000;await worker.runDue();await worker.settled();assert.ok(calls>2);worker.retain(['NVDA']);assert.deepEqual(worker.status().watchlist,['NVDA']);
 }finally{await worker.stop();history.close();}
});
test('persist raw daily data and watchlist; restart serves four periods while network fails',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-v28-'));const statePath=path.join(dir,'history.json');let now=base;
 const a=createHistoryService({now:()=>now,fetchChart:async s=>dailyData(s)}),wa=createHistoryPrewarm({history:a,now:()=>now,statePath,tickMs:10});
 wa.retain(['NVDA']);await wa.start();await until(()=>wa.status().ready===1);now+=5001;await wa.runDue();await wa.settled();assert.equal(wa.status().entries[0].tier,'long');await wa.stop();a.close();
 const b=createHistoryService({now:()=>now,fetchChart:async()=>{throw Object.assign(Error('offline'),{code:'OFFLINE'});}}),wb=createHistoryPrewarm({history:b,now:()=>now,statePath,tickMs:10});
 try{await wb.start();assert.equal(wb.status().restored,true);assert.deepEqual(wb.status().watchlist,['NVDA']);
 for(const p of ['daily','weekly','monthly','yearly'])assert.ok(wb.read('NVDA',p).bars.length>=20);
 await wb.settled();now+=61000;await wb.runDue();await wb.settled();assert.equal(wb.status().entries[0].status,'stale');assert.ok(wb.read('NVDA','daily').bars.length);assert.ok(wb.status().entries[0].retryAt>now);
 }finally{const stopped=wb.stop();b.close();await stopped;await fs.rm(dir,{recursive:true,force:true});}
});
test('one worker does not overlap cycles or bypass 429 cooldown',async()=>{
 let now=base,calls=0,active=0,max=0;
 const history=createHistoryService({now:()=>now,fetchChart:async()=>{calls++;max=Math.max(max,++active);await wait(30);active--;throw Object.assign(Error('rate limited'),{code:'HISTORY_RATE_LIMITED',statusCode:429,retryAt:now+120000});}});
 const worker=createHistoryPrewarm({history,now:()=>now,tickMs:10});
 try{worker.retain(['NVDA']);await worker.start();for(let i=0;i<10;i++)worker.runDue();await worker.settled();assert.equal(calls,1);assert.equal(max,1);
 now+=61000;worker.runDue();await worker.settled();assert.equal(calls,1);assert.ok(worker.status().entries[0].retryAt>now);
 }finally{await worker.stop();history.close();}
});
test('real HTTP cache bundle and four tab endpoints return without upstream on warm path',async t=>{
 let calls=0;const app=createApplication({now:()=>base,env:{PORT:0,MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',RECOVERY_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0'},telemetry:createTelemetry(),providerOverrides:{fetchChart:async s=>{calls++;return dailyData(s);},fetchQuote:async s=>({symbol:s,price:100,quoteAt:base,currency:'USD',charts:{}})}});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 const cold=await fetch(origin+'/api/history/bundle?symbols=NVDA').then(r=>r.json());assert.equal(cold.entries[0].periods,null);assert.deepEqual(app.services.historyPrewarm.status().watchlist,[],'GET must not edit the background watchlist');
 const saved=await fetch(origin+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:['NVDA']})});assert.equal(saved.status,200);
 await until(()=>app.services.historyPrewarm.status().ready===1);const before=calls;
 for(const period of ['daily','weekly','monthly','yearly']){const start=performance.now(),data=await fetch(origin+'/api/history?symbol=NVDA&period='+period).then(r=>r.json());assert.ok(data.prewarmed);assert.ok(data.bars.length);assert.ok(performance.now()-start<500);}
 assert.equal(calls,before);const status=await fetch(origin+'/api/history/status').then(r=>r.json());assert.equal(status.ready,1);
});
test('SSE publishes history without a dedicated history stream or clicking tabs',async t=>{
 const app=createApplication({now:()=>base,env:{PORT:0,MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',RECOVERY_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0'},telemetry:createTelemetry(),providerOverrides:{fetchChart:async s=>dailyData(s),fetchQuote:async s=>({symbol:s,price:100,quoteAt:base,currency:'USD',charts:{}})}});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const controller=new AbortController();t.after(()=>controller.abort());
 const r=await fetch('http://127.0.0.1:'+app.httpServer.address().port+'/api/stream?symbols=NVDA',{signal:controller.signal}),reader=r.body.getReader();let body='';
 try{let prepared;
 while(!prepared){const {value,done}=await reader.read();assert.ok(!done);body+=new TextDecoder().decode(value);if(body.length>2000000)assert.fail('no history');
  const frames=body.split('\n\n');for(const f of frames.slice(0,-1))if(f.startsWith('event: history\n')){const p=JSON.parse(f.split('\ndata: ')[1]);if(p.entries[0]?.periods)prepared=p;}
 }
 assert.deepEqual(Object.keys(prepared.entries[0].periods),['daily','weekly','monthly','yearly']);assert.equal(app.services.historyPrewarm.status().ready,1);
 }finally{controller.abort();await reader.cancel().catch(()=>{});}
});
