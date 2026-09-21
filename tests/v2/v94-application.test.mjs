import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createApplication} from '../../app.js';
const at=Date.parse('2026-09-18T14:00:00Z'),readKey='application_read_'.repeat(3),admin='application_admin_'.repeat(3);
async function application(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-v94-app-')),calls=[];
 const app=createApplication({now:()=>at,env:{HOST:'127.0.0.1',PORT:0,LOG_FILE:'',SYMBOLS:'NVDA',LLM_API_KEY:readKey,STATS_TOKEN:admin,LLM_KEY_STORE_PATH:path.join(dir,'keys.json'),REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',FUNDAMENTALS_ENABLED:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:''},
  providerOverrides:{fetchQuote:async symbol=>({symbol,price:100,quoteAt:at,sourceCheckedAt:at,src:'offline-application-fixture',instrumentType:'EQUITY',currency:'USD',priceSession:'REGULAR'}),advancedMarketData:{
   daily:async q=>{calls.push('daily');return {symbol:q.symbol,currency:'USD',source:'offline-application-fixture',sourceCheckedAt:at,adjustmentBasis:q.adjustment,seriesId:'fixture-series',nextBefore:'2026-09-18',volumeUnit:'shares',bars:[{t:Date.parse('2026-09-18T00:00Z')/1000,sessionDate:'2026-09-18',periodStart:'2026-09-18',lastTradingDate:'2026-09-18',o:99,h:101,l:98,c:100,v:10,adjustedClose:100}]};},
   intraday:async q=>{calls.push('intraday');return {symbol:q.symbol,source:'offline-application-fixture',sourceCheckedAt:at,currency:'USD',adjustment:'raw',volumeUnit:'shares',start:'2026-09-18',end:'2026-09-18',points:[{t:at/1000-60,o:99,h:101,l:98,c:100,v:10}]};},
   actions:async q=>{calls.push('actions');return {symbol:q.symbol,source:'offline-application-fixture',sourceCheckedAt:at,start:'2024-06-01',end:'2024-07-01',filterBasis:'ex_date',events:[{id:'fixture-split',type:'split',ex_date:'2024-06-10',ratio:10,source:'offline-application-fixture'}]};},
   capabilities:()=>({fixture:true})}},upstream:async()=>{throw Error('No network permitted in this test');}});
 app.start();await once(app.httpServer,'listening');t.after(async()=>{await app.stop();await fs.rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.httpServer.address().port;
 const post=(route,body,key=readKey)=>fetch(base+route,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const manage=async body=>{const r=await fetch(base+'/api/admin/keys',{method:'POST',headers:{'X-Admin-Token':admin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};return {app,base,post,manage,calls,dir};
}
test('v94 production composition routes optional history/actions and v2 objects through the same services',async t=>{
 const {post,calls}=await application(t);const r=await post('/api/v1/market-context',{symbol:'NVDA',include:['daily','corporate_actions'],adjustment:'split',daily_bar_count:1,max_wait_ms:1000});assert.equal(r.status,200);const data=await r.json();assert.equal(data.sections.daily.rows[0][9],100);assert.equal(data.sections.corporate_actions.rows[0][3],10);assert.deepEqual(calls.sort(),['actions','daily']);
 const d=await post('/api/v2/market-detail',{symbol:'NVDA',profile:'analysis',include:['intraday'],intraday_date:'2026-09-18',aggregate_minutes:15,max_wait_ms:1000});assert.equal(d.status,200);const value=await d.json();assert.equal(value.schema_version,2);assert.equal(value.sections.intraday.records[0].close,100);assert.equal(value.sections.intraday.records[0].volume,10);assert.equal(value.sections.order_book,undefined);
});
test('v94 production batch keeps quote identities, weighted quota and no lasting membership',async t=>{
 const {post,app}=await application(t);const r=await post('/api/v1/market-context',{symbols:['NVDA','SPY','QQQ'],include:['quote'],max_wait_ms:1000});assert.equal(r.status,200);assert.equal(r.headers.get('x-ratelimit-remaining'),'17');const out=await r.json();assert.deepEqual(out.results.map(x=>x.instrument.symbol),['NVDA','SPY','QQQ']);assert.ok(out.results.every(x=>x.sections.quote.data.price===100));assert.equal(app.services.engine.diagnostics().subscribers,0);
});
test('v94 management-created scoped key works on real routes and family revocation persists',async t=>{
 const {manage,post,base,dir}=await application(t);const made=await manage({action:'create',label:'history-only',scopes:['history']});let r=await post('/api/v1/market-context',{symbol:'NVDA',include:['quote'],max_wait_ms:0},made.secret);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'INSUFFICIENT_SCOPE');
 r=await fetch(base+'/api/v1/trading-calendar?exchange=US&start=2026-09-07&end=2026-09-08',{headers:{Authorization:'Bearer '+made.secret}});assert.equal(r.status,200);const c=await r.json();assert.equal(c.days[0].is_open,false);assert.equal(c.days[1].is_open,true);
 await manage({action:'revoke',id:made.id});r=await post('/api/v1/market-context',{symbol:'NVDA',include:['corporate_actions'],max_wait_ms:0},made.secret);assert.equal(r.status,401);const state=await fs.readFile(path.join(dir,'keys.json'),'utf8');assert.ok(!state.includes(made.secret));assert.ok(state.includes('revoked'));
});
test('v94 production document routes serve the new contract and auxiliary routes require auth',async t=>{
 const {base}=await application(t);const doc=await (await fetch(base+'/api/v1/openapi.json')).json();assert.ok(doc.paths['/api/v1/market-status']);assert.ok(doc.paths['/api/v1/market-context'].get);
 assert.equal((await fetch(base+'/api/v1/capabilities')).status,401);assert.equal((await fetch(base+'/api-keys.html')).status,200);assert.equal((await fetch(base+'/api/admin/keys')).status,403);
});
