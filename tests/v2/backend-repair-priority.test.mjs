import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createYahooService} from '../../lib/yahoo.js';
import {createTransport} from '../../lib/transport.js';
import {createHostGate} from '../../lib/host-gate.js';
import {deferred,turn,historyData,fixtureAt} from './backend-repair-fixtures.mjs';
function fixture(){
 const blocked=deferred(),calls=[];const gate=createHostGate({minGap:()=>0});
 const transport=createTransport({gate,upstream:async url=>{const s=new URL(url).pathname.split('/').at(-1);calls.push(s);if(s==='BLOCK')await blocked.promise;return {status:200,body:JSON.stringify({chart:{result:[historyData(s,{start:'2026-09-30'})]}})};}});
 const yahoo=createYahooService({httpsGet:transport.httpsGet,now:()=>fixtureAt});
 const source=createHistorySource({primary:yahoo.fetchChart,now:()=>fixtureAt});
 const history=createHistoryService({fetchChart:source,now:()=>fixtureAt,maxConcurrent:4});
 return {blocked,calls,gate,source,yahoo,history,async close(){history.close();source.close();await yahoo.close();await transport.close();}};
}
test('R8 explicit foreground history passes the background waiter through source Yahoo transport and HostGate',async()=>{
 const f=fixture(),pending=[f.source('BLOCK','?interval=1d',{priority:'background'})];
 try{await turn();pending.push(f.history.get('BACK','daily',{count:1,priority:'background'}));await turn();pending.push(f.history.get('FRONT','daily',{count:1}));await turn();
  f.blocked.resolve();await Promise.all(pending);assert.deepEqual(f.calls,['BLOCK','FRONT','BACK']);
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});
test('R8 transport cancellation does not release the shared host until the network work stops',async()=>{
 const blocked=deferred(),controller=new AbortController();let calls=0;
 const gate=createHostGate({minGap:()=>0});const transport=createTransport({gate,upstream:async()=>{calls++;if(calls===1)await blocked.promise;return {status:200};}});
 const first=transport.httpsGet('https://example.test/one',{}, {signal:controller.signal,priority:'background'});await turn();controller.abort();await assert.rejects(first);
 const second=transport.httpsGet('https://example.test/two',{}, {priority:'foreground'});await turn();assert.equal(calls,1);assert.equal(gate.diagnostics()['example.test'].active,1);
 blocked.resolve();await second;assert.equal(calls,2);await transport.close();
});
test('R8 Yahoo 401 retry preserves role, and Retry-After suppresses both roles',async t=>{
 const blocked=deferred(),backRunning=deferred(),auth=deferred(),gate=createHostGate({minGap:()=>0}),calls=[];let challenged=false;
 const transport=createTransport({gate,upstream:async url=>{
  const s=new URL(url).pathname.split('/').at(-1);calls.push(s);if(s==='BLOCK')await blocked.promise;
  if(s==='BACK1')await backRunning.promise;
  if(s==='FRONT'&&!challenged){challenged=true;return {status:401,body:''};}
  return {status:200,body:JSON.stringify({chart:{result:[historyData(s,{start:'2026-09-30'})]}})};
 }});
 const yahoo=createYahooService({httpsGet:transport.httpsGet,getCrumb:async()=>{await auth.promise;return {crumb:'fixture',cookie:'fixture'};}});
 t.after(async()=>{blocked.resolve();backRunning.resolve();auth.resolve();await yahoo.close();await transport.close();});
 const first=yahoo.fetchChart('BLOCK','?interval=1d');await turn();const backs=['BACK1','BACK2'].map(s=>yahoo.fetchChart(s,'?interval=1d',{priority:'background'})),front=yahoo.fetchChart('FRONT','?interval=1d',{priority:'foreground'});
 await turn();blocked.resolve();await turn();assert.deepEqual(calls,['BLOCK','FRONT','BACK1']);
 auth.resolve();await turn();backRunning.resolve();await Promise.all([first,...backs,front]);assert.deepEqual(calls,['BLOCK','FRONT','BACK1','FRONT','BACK2']);
 await yahoo.close();await transport.close();
 let at=1000,network=0;const cooling=createHostGate({now:()=>at,minGap:()=>0});
 await cooling.run('https://example.test',()=>{network++;return {status:429,headers:{'retry-after':'120'}};});
 for(const priority of ['foreground','background'])await assert.rejects(cooling.run('https://example.test',()=>{network++;return {status:200};},{priority}),{code:'SOURCE_COOLDOWN'});
 assert.equal(network,1);at+=120000;await cooling.run('https://example.test',()=>({status:200}));cooling.close();
});
test('R8 continuous foreground arrivals cannot starve the oldest background request',async()=>{
 const f=fixture(),pending=[f.source('BLOCK','?interval=1d',{priority:'foreground'})];
 try{await turn();pending.push(f.source('BACK','?interval=1d',{priority:'background'}));
  for(let i=0;i<12;i++)pending.push(f.source('FRONT'+i,'?interval=1d',{priority:'foreground'}));
  await turn();f.blocked.resolve();await Promise.all(pending);
  assert.equal(f.calls[1],'FRONT0');assert.ok(f.calls.indexOf('BACK')<=5,'bounded priority burst must give background a turn');
  assert.deepEqual(f.calls.filter(s=>s.startsWith('FRONT')),Array.from({length:12},(_,i)=>'FRONT'+i));
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});
