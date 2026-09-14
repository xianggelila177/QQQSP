import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createHistoryService} from '../../lib/history-service.js';
import {dailyData,fixtureNow} from './history-v28-fixture.mjs';

test('prepared four periods share one raw read; hydration reuses arrays and rejects an older source snapshot',async()=>{
 let calls=0;const history=createHistoryService({now:()=>fixtureNow,fetchChart:async s=>{calls++;return dailyData(s);}});
 try{
  const periods=await history.prepare('NVDA');assert.equal(calls,1);assert.equal(Object.keys(periods).length,4);
  const s={window:{},URLSearchParams,AbortController,Date,setTimeout,clearTimeout};
  for(const name of ['panel-timeframes','panel-scheduler','panel-network','panel-history-store'])vm.runInNewContext(await fs.readFile(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),s);
  const store=s.window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',fetchImpl:()=>{throw Error('unexpected network');}});
  const p=periods.daily;assert.ok(store.hydrate('daily30',p));const bars=store.getSeries('daily30');
  assert.ok(store.hydrate('daily30',{...p,sourceCheckedAt:p.sourceCheckedAt+1000}));assert.equal(store.getSeries('daily30'),bars);
  assert.equal(store.hydrate('daily30',p),false);assert.equal(store.getSeries('daily30'),bars);
 }finally{history.close();}
});
test('stopping a never-started service does not overwrite an existing checkpoint',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-stop-')),file=path.join(dir,'history.json');
 const sentinel='existing cache';await fs.writeFile(file,sentinel);
 const history=createHistoryService({fetchChart:async()=>dailyData()});
 const worker=createHistoryPrewarm({history,statePath:file});
 try{await worker.stop();assert.equal(await fs.readFile(file,'utf8'),sentinel);}finally{history.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('serial worker chooses the oldest due entry, so one slow symbol cannot starve later symbols',async()=>{
 let now=fixtureNow;const order=[];
 const history={prepare:async s=>{order.push(s);now+=90000;return {};},exportState:()=>({schemaVersion:1,entries:[]}),cache:new Map()};
 const w=createHistoryPrewarm({history,now:()=>now,tickMs:600000});
 try{w.retain(['NVDA','MRVL','LITE']);await w.start();await w.settled();await w.runDue();await w.runDue();assert.deepEqual(order.slice(0,3),['NVDA','MRVL','LITE']);}finally{await w.stop();}
});
test('explicitly clearing the last watchlist survives a restart and does not resurrect old symbols',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-empty-')),file=path.join(dir,'history.json');
 const make=()=>{const history=createHistoryService({now:()=>fixtureNow,fetchChart:async s=>dailyData(s)});return {history,worker:createHistoryPrewarm({history,now:()=>fixtureNow,statePath:file,tickMs:600000})};};
 const a=make();a.worker.retain(['NVDA']);await a.worker.start();await a.worker.settled();a.worker.retain([]);await a.worker.stop();a.history.close();
 const b=make();try{await b.worker.start();assert.deepEqual(b.worker.status().watchlist,[]);}finally{await b.worker.stop();b.history.close();await fs.rm(dir,{recursive:true,force:true});}
});
