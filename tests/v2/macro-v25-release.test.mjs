import test from 'node:test';import assert from 'node:assert/strict';
import {createMacroMonitor} from '../../lib/macro-monitor.js';
function setup({notify=null}={}){
 let clock=Date.parse('2026-09-11T08:00:00Z'),value={items:[],analysisVersion:1,updatedAt:clock};
 const context={getContext:async()=>({factors:[]}),snapshot:()=>({factors:[]}),exportState:()=>({}),restore(){}};
 const calendar={getCalendar:async()=>({status:'disabled'}),snapshot:()=>({enabled:false}),exportState:()=>({})};
 const monitor=createMacroMonitor({macro:{getMacro:async()=>value},context,calendar,now:()=>clock,tickMs:100000,notify});
 return {monitor,set:x=>value=x,advance:ms=>clock+=ms,now:()=>clock};
}
test('macro initial HTTP snapshot preserves analysisVersion before slow upstream completes',()=>{
 const s=setup();assert.equal(s.monitor.snapshot().news.analysisVersion,1);
});
test('stale news cache is retained without advancing the last successful source collection',async t=>{
 const s=setup();t.after(()=>s.monitor.stop());const item={title:'市场背景',t:s.now()};s.set({items:[item],updatedAt:s.now()});
 await s.monitor.start();await s.monitor.settled();const success=s.monitor.status().lanes.news.successAt;
 s.advance(60000);s.set({items:[item],updatedAt:success,stale:true,error:'all sources unavailable'});s.monitor.runDue();await s.monitor.settled();
 assert.equal(s.monitor.status().lanes.news.successAt,success);assert.equal(s.monitor.snapshot().news.items.length,1);
});
test('failed webhook is abandoned after five attempts and cannot be silently re-enqueued each news cycle',async t=>{
 let attempts=0;const s=setup({notify:async()=>{attempts++;throw Error('HTTP 503');}});t.after(()=>s.monitor.stop());
 s.set({items:[{title:'市场背景',t:s.now()}],updatedAt:s.now()});await s.monitor.start();await s.monitor.settled();s.advance(60000);
 s.set({items:[{title:'OPEC announces oil production cuts',t:s.now()}],updatedAt:s.now()});
 for(let i=0;i<7;i++){s.monitor.runDue();await s.monitor.settled();await new Promise(r=>setTimeout(r,0));s.advance(900000);}
 assert.equal(attempts,5);assert.equal(s.monitor.status().delivery.pending,0);
});
