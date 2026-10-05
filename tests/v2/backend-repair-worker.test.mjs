import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {atomicWriteFile} from '../../lib/atomic-file.js';
import {deferred,turn,fixtureAt} from './backend-repair-fixtures.mjs';
const periods=()=>Object.fromEntries(['daily','weekly','monthly','yearly'].map(period=>[period,{period,seriesId:'series',revision:'1',requestedCount:period==='yearly'?39:79,bars:[],status:'ready'}]));
const stub=()=>({exportState:()=>({schemaVersion:1,entries:[]}),cache:new Map(),prepare:async()=>periods()});

test('R6 only the current and latest pending checkpoint are serialized and written',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-repair-')),file=path.join(directory,'history.json');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const blocked=deferred();let writes=0,serializations=0;
 const worker=createHistoryPrewarm({history:stub(),statePath:file,writeFile:async(file,body)=>{if(++writes===1)await blocked.promise;await atomicWriteFile(file,body);}});
 const saved=version=>({toJSON(){serializations++;return {schemaVersion:1,version};}}),pending=[worker.persist(saved(1))];
 await turn();for(let i=2;i<=8;i++)pending.push(worker.persist(saved(i)));
 try{assert.equal(serializations,1,'do not serialize obsolete queued versions');}
 finally{blocked.resolve();await Promise.all(pending);await worker.stop();}
 assert.equal(writes,2);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,8);
});
test('R6 rejected atomic targets preserve state; persist rejects and a later save recovers',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-save-retry-')),file=path.join(directory,'history.json');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(file);const worker=createHistoryPrewarm({history:stub(),statePath:file});
 await assert.rejects(worker.persist({version:1}),{code:'UNSAFE_STATE_TARGET'});await turn();assert.equal(worker.status().saveError,'UNSAFE_STATE_TARGET');
 await fs.rmdir(file);await worker.persist({version:2});assert.equal(worker.status().saveError,null);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,2);
 const circular={};circular.self=circular;await assert.rejects(worker.persist(circular),TypeError);await turn();await worker.persist({version:3});assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,3);await worker.stop();
});
test('R6 stop waits for the latest checkpoint, even after the history cache is closed',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-stop-save-')),file=path.join(directory,'history.json');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let version=1,done=false;const blocked=deferred();let writes=0;
 const history={...stub(),exportState:()=>({schemaVersion:1,version,entries:[]})};
 const worker=createHistoryPrewarm({history,now:()=>fixtureAt,statePath:file,tickMs:600000,writeFile:async(file,body)=>{if(++writes===1)await blocked.promise;await atomicWriteFile(file,body);}});
 worker.retain(['NVDA']);await worker.start();await worker.settled();const first=worker.persist();await turn();version=8;
 const stopping=worker.stop().then(()=>{done=true;});version=0;await turn();assert.equal(done,false);
 blocked.resolve();await first;await stopping;assert.equal(JSON.parse(await fs.readFile(file,'utf8')).history.version,8);assert.equal(writes,2);
});

test('R6 application stop surfaces a checkpoint failure after closing its HTTP listener',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-app-stop-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const app=createApplication({now:()=>fixtureAt,telemetry:createTelemetry(),upstream:async()=>{throw Error('unexpected external IO');},
  env:{PORT:0,LOG_FILE:'',HISTORY_STATE_PATH:directory,RECOVERY_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0'}});
 app.start();await once(app.httpServer,'listening');await app.services.historyPrewarm.settled();
 await assert.rejects(app.stop(),{code:'UNSAFE_STATE_TARGET'});
 assert.equal(app.httpServer.listening,false);assert.equal(app.services.historyPrewarm.status().running,false);
 assert.equal(app.services.history.diagnostics().closed,true);
});
test('R7 slow jobs are bounded; removed then re-added members cannot accept an obsolete completion',async t=>{
 const gates=[deferred(),deferred(),deferred()],calls=[];let clock=fixtureAt;
 const worker=createHistoryPrewarm({maxConcurrent:2,now:()=>clock,tickMs:600000,history:{...stub(),prepare:async(s,o)=>{const index=calls.length;calls.push({s,signal:o.signal});await gates[index].promise;return periods();}}});
 t.after(()=>{for(const gate of gates)gate.resolve();return worker.stop();});
 worker.retain(['AAA','BBB']);assert.equal(worker.status().oldestDueMs,0);clock+=5000;assert.equal(worker.status().oldestDueMs,5000);
 await worker.start();await turn();assert.equal(calls.length,2);assert.equal(worker.status().activeCount,2);
 worker.retain(['BBB']);worker.retain(['AAA','BBB']);gates[0].resolve();await turn();
 assert.equal(worker.snapshot(['AAA']).entries[0].periods,null);assert.equal(calls.filter(c=>c.s==='AAA').length,2);
 const stopping=worker.stop();assert.ok(calls.slice(1).every(c=>c.signal.aborted));gates[1].resolve();gates[2].resolve();await stopping;
 assert.equal(worker.status().activeCount,0);assert.equal(worker.status().ready,0);clock+=120000;worker.runDue();await turn();assert.equal(calls.length,3);
});
test('R7 source Retry-After bounds retries and reports overdue work without busy looping',async()=>{
 let clock=fixtureAt,calls=0;
 const worker=createHistoryPrewarm({now:()=>clock,tickMs:600000,history:{...stub(),prepare:async()=>{calls++;throw Object.assign(Error('cooling'),{retryAt:clock+120000,code:'SOURCE_COOLDOWN'});}}});
 worker.retain(['NVDA']);await worker.start();await worker.settled();
 try{for(let i=0;i<10;i++){worker.runDue();await turn();}assert.equal(calls,1);clock+=119999;await worker.runDue();assert.equal(calls,1);
  clock+=1;await worker.runDue();assert.equal(calls,2);assert.equal(worker.status().entries[0].error,'SOURCE_COOLDOWN');
 }finally{await worker.stop();}
});

test('R7 one hundred immediate prewarm jobs complete without advancing the clock',async()=>{
 let clock=fixtureAt;const calls=[];
 const worker=createHistoryPrewarm({history:{...stub(),prepare:async symbol=>{calls.push(symbol);return periods();}},now:()=>clock,tickMs:600000});
 worker.retain(Array.from({length:100},(_,i)=>'W'+i));await worker.start();
 try{for(let i=0;i<110;i++)await turn();assert.equal(worker.status().ready,100,'completion must drain another due member without a tick');
  assert.equal(new Set(calls).size,100);assert.equal(calls.length,100);
  clock+=60000;worker.runDue();for(let i=0;i<110;i++)await turn();assert.equal(calls.length,200);
 }finally{await worker.stop();}
});
