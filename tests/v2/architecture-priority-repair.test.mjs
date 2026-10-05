import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createYahooService} from '../../lib/yahoo.js';
import {createTransport} from '../../lib/transport.js';
import {createHostGate} from '../../lib/host-gate.js';
import {deferred,turn,historyData,fixtureAt} from './backend-repair-fixtures.mjs';

function fixture(maxConcurrent=4){
 const blocked=deferred(),calls=[],gate=createHostGate({minGap:()=>0});
 const transport=createTransport({gate,upstream:async(url,_headers,opts)=>{
  assert.equal(Object.hasOwn(opts,'priority'),false);const s=new URL(url).pathname.split('/').at(-1);calls.push(s);if(s==='BLOCK')await blocked.promise;
  return {status:200,body:JSON.stringify({chart:{result:[historyData(s,{start:'2026-09-30'})]}})};
 }});
 const yahoo=createYahooService({httpsGet:transport.httpsGet,now:()=>fixtureAt});
 const source=createHistorySource({primary:yahoo.fetchChart,now:()=>fixtureAt});
 const history=createHistoryService({fetchChart:source,now:()=>fixtureAt,maxConcurrent});
 return {blocked,calls,gate,source,history,async close(){blocked.resolve();history.close();source.close();await yahoo.close();await transport.close();}};
}

test('G joining foreground history promotes the same producer already waiting at HostGate',async()=>{
 const f=fixture(),pending=[f.source('BLOCK','?interval=1d',{priority:'foreground'})];
 try{await turn();pending.push(f.history.get('BACK0','daily',{count:1,priority:'background'}));await turn();
  pending.push(f.history.get('SHARED','daily',{count:1,priority:'background'}));await turn();
  pending.push(f.history.get('SHARED','daily',{count:1,priority:'foreground'}));await turn();
  pending.push(f.history.get('FRONT','daily',{count:1,priority:'foreground'}));await turn();
  f.blocked.resolve();await Promise.all(pending);
  assert.deepEqual(f.calls,['BLOCK','SHARED','FRONT','BACK0']);assert.equal(f.calls.filter(s=>s==='SHARED').length,1);
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});

test('G joining foreground history promotes a producer still waiting in the history queue',async()=>{
 const f=fixture(1),pending=[f.history.get('BLOCK','daily',{count:1})];
 try{await turn();pending.push(f.history.get('BACK0','daily',{count:1,priority:'background'}));await turn();
  pending.push(f.history.get('SHARED','daily',{count:1,priority:'background'}));await turn();
  pending.push(f.history.get('SHARED','daily',{count:1}));await turn();
  pending.push(f.history.get('FRONT','daily',{count:1}));await turn();
  f.blocked.resolve();await Promise.all(pending);assert.deepEqual(f.calls,['BLOCK','SHARED','FRONT','BACK0']);
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});

test('G promotion preserves shared-reader cancellation and source single-flight',async()=>{
 const f=fixture(),controller=new AbortController(),pending=[f.source('BLOCK','?interval=1d')];
 try{await turn();const background=f.history.get('SHARED','daily',{count:1,priority:'background',signal:controller.signal});background.catch(()=>{});await turn();
  pending.push(f.history.get('SHARED','daily',{count:1}));await turn();controller.abort();await assert.rejects(background);
  assert.deepEqual(f.calls,['BLOCK']);f.blocked.resolve();await Promise.all(pending);assert.deepEqual(f.calls,['BLOCK','SHARED']);
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});

test('G promoted shared tasks retain bounded fairness for the oldest background task',async()=>{
 const f=fixture(16),pending=[f.source('BLOCK','?interval=1d')];
 try{await turn();pending.push(f.history.get('BACK0','daily',{count:1,priority:'background'}));await turn();
  for(let i=0;i<8;i++){pending.push(f.history.get('JOIN'+i,'daily',{count:1,priority:'background'}));await turn();}
  for(let i=0;i<8;i++){pending.push(f.history.get('JOIN'+i,'daily',{count:1}));await turn();}
  f.blocked.resolve();await Promise.all(pending);
  assert.equal(f.calls[1],'JOIN0');assert.ok(f.calls.indexOf('BACK0')<=5);
  assert.deepEqual(f.calls.filter(s=>s.startsWith('JOIN')),Array.from({length:8},(_,i)=>'JOIN'+i));
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});

test('G cancelling all readers removes a promoted host waiter before any source call',async()=>{
 const f=fixture(),a=new AbortController(),b=new AbortController(),pending=[f.source('BLOCK','?interval=1d')];
 try{await turn();const first=f.history.get('SHARED','daily',{count:1,priority:'background',signal:a.signal});first.catch(()=>{});await turn();
  const second=f.history.get('SHARED','daily',{count:1,signal:b.signal});second.catch(()=>{});await turn();
  a.abort();b.abort();await Promise.all([assert.rejects(first),assert.rejects(second)]);await turn();
  f.blocked.resolve();await Promise.all(pending);assert.deepEqual(f.calls,['BLOCK']);
  await f.history.get('SHARED','daily',{count:1});assert.deepEqual(f.calls,['BLOCK','SHARED']);
 }finally{f.blocked.resolve();await Promise.allSettled(pending);await f.close();}
});
