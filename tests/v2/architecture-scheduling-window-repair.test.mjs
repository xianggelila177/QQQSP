import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostGate} from '../../lib/host-gate.js';
import {createTransport} from '../../lib/transport.js';
import {createPriorityHandle} from '../../lib/request-priority.js';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {fixtureAt,quote,turn} from './backend-repair-fixtures.mjs';

test('host chooses at send eligibility, preserving total capacity, promotion and role FIFO',async()=>{
 const order=[],starts=[],gap=50,gate=createHostGate({minGap:()=>gap,maxQueued:2});
 const transport=createTransport({gate,upstream:async(url,_headers,options)=>{
  assert.equal(Object.hasOwn(options,'priority'),false);
  order.push(new URL(url).pathname.slice(1));starts.push(Date.now());return {status:200};
 }});
 const run=(name,priority)=>transport.httpsGet('https://query1.finance.yahoo.com/'+name,{}, {priority});
 const pending=[];
 try{
  await run('PRIME');await turn();
  pending.push(run('BACK0','background'));await turn();
  const shared=createPriorityHandle('background');pending.push(run('SHARED',shared));
  pending.push(run('FRONT','foreground'));
  await assert.rejects(run('OVERFLOW','foreground'),{code:'CAPACITY_EXCEEDED'});
  shared.promote('foreground');await Promise.all(pending);
  assert.deepEqual(order,['PRIME','SHARED','FRONT','BACK0']);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=gap,'every source start retains the gap');
 }finally{await transport.close();await Promise.allSettled(pending);}
});

test('one delayed task fits maxQueued zero; cancellation, deadlines and reopen never send old work',async()=>{
 const gap=80,gate=createHostGate({minGap:()=>gap,maxQueued:0}),calls=[],times=[];
 const run=(name,options)=>gate.run('https://api.nasdaq.com/'+name,()=>{calls.push(name);times.push(Date.now());return {status:200};},options);
 try{
  await run('PRIME');await turn();const c=new AbortController(),cancelled=run('CANCEL',{signal:c.signal});
  const rejection=assert.rejects(cancelled,{name:'AbortError'});
  await assert.rejects(run('FULL'),{code:'CAPACITY_EXCEEDED'});c.abort();await rejection;await turn();
  await assert.rejects(run('EXPIRE',{deadlineAt:Date.now()+10}),{code:'DEADLINE_EXCEEDED'});await turn();
  const stopped=run('STOP');const stoppedCheck=assert.rejects(stopped,{code:'STOPPED'});gate.close();await stoppedCheck;await turn();
  await assert.rejects(run('CLOSED'),{code:'STOPPED'});gate.reopen();await run('REOPEN');await turn();
  assert.deepEqual(calls,['PRIME','REOPEN']);assert.ok(times[1]-times[0]>=gap);
  assert.equal(gate.diagnostics()['api.nasdaq.com'].active,0);
 }finally{gate.close();}
});

test('cooldown rejection bypasses a remaining host gap and retains Retry-After across reopen',async()=>{
 let at=100000,calls=0;const gate=createHostGate({now:()=>at,minGap:()=>1000});
 try{
  await gate.run('https://api.nasdaq.com/limit',()=>{calls++;return {status:429,headers:{'retry-after':'120'}};});await turn();
  let settled=false;const blocked=gate.run('https://api.nasdaq.com/blocked',()=>{calls++;return {status:200};})
   .then(()=>assert.fail('cooldown must reject'),error=>{assert.equal(error.code,'SOURCE_COOLDOWN');assert.equal(error.retryAt,220000);settled=true;});
  await turn();assert.equal(settled,true,'known cooldown does not wait for the 1000 ms host gap');await blocked;
  gate.close();gate.reopen();at=219999;
  await assert.rejects(gate.run('https://api.nasdaq.com/early',()=>{calls++;}),{code:'SOURCE_COOLDOWN'});
  at=220000;await gate.run('https://api.nasdaq.com/recovered',()=>{calls++;return {status:200};});assert.equal(calls,2);
 }finally{gate.close();}
});

test('a stalled cold batch member leaves time for a later fast cold member without source concurrency growth',async()=>{
 const available=new Map(),listeners=new Set(),pokes=[],timers=[];let active=0,maxActive=0,releases=0;
 const engine={read:([s])=>[available.get(s)||{symbol:s,pending:true}],
  watch(){active++;maxActive=Math.max(maxActive,active);return()=>{active--;releases++;};},
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  poke(s){pokes.push(s);if(s==='NVDA')timers.push(setTimeout(()=>{available.set(s,quote(s));for(const fn of listeners)fn([s]);},10));}};
 const service=createMarketContextService({now:()=>fixtureAt,engine});
 try{
  const out=await service.query({symbols:['QQQ','NVDA'],include:['quote'],max_wait_ms:180});
  assert.equal(out.results[0].sections.quote.status,'unavailable');assert.equal(out.results[1].sections.quote.data?.price,100);
  assert.deepEqual(pokes,['QQQ','NVDA']);assert.equal(maxActive,1);assert.equal(active,0);assert.equal(releases,2);assert.equal(listeners.size,0);
  assert.equal(service.diagnostics().maxActive,1);
 }finally{service.close();for(const timer of timers)clearTimeout(timer);}
});

test('batch keeps later cache hits after budget exhaustion and zero wait never refreshes',async()=>{
 let monotonic=0,watches=0,releases=0;const pokes=[];
 const engine={read:([s])=>[s==='SPY'?quote(s):{symbol:s,pending:true}],watch(){watches++;return()=>releases++;},subscribe:()=>()=>{},poke(s){pokes.push(s);monotonic=1000;}};
 const service=createMarketContextService({now:()=>fixtureAt,clock:()=>monotonic,engine});
 try{
  const out=await service.query({symbols:['QQQ','SPY','NVDA'],include:['quote'],max_wait_ms:1});
  assert.equal(out.results[1].sections.quote.data.price,100);assert.deepEqual(pokes,['QQQ']);assert.equal(watches,releases);
  const cached=await service.query({symbols:['QQQ','SPY'],include:['quote'],max_wait_ms:0});
  assert.equal(cached.results[1].sections.quote.data.price,100);assert.deepEqual(pokes,['QQQ']);
 }finally{service.close();}
});
