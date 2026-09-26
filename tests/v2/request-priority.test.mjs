import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskQueue} from '../../lib/task-queue.js';
import {createHostGate} from '../../lib/host-gate.js';
import {createTransport} from '../../lib/transport.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('user priority advances only waiting requests, preserves FIFO and the host minimum gap',async()=>{
  const first=deferred(),order=[],starts=[],gate=createHostGate({minGap:()=>20});
  const transport=createTransport({gate,upstream:async(url,headers,opts)=>{
    assert.equal(Object.hasOwn(opts,'priority'),false,'queue metadata must not reach network options');
    order.push(new URL(url).pathname);starts.push(Date.now());
    if(order.length===1)await first.promise;
    return {status:200,body:'ok'};
  }});
  try{
    const run=(path,priority)=>transport.httpsGet('https://api.nasdaq.com/'+path,{},priority==null?{}:{priority});
    const active=run('active');await tick();
    const normal1=run('normal1'),high1=run('detail1',1),normal2=run('normal2'),high2=run('detail2',1);
    await tick();assert.deepEqual(order,['/active'],'active request is never preempted');
    first.resolve();await Promise.all([active,normal1,high1,normal2,high2]);
    assert.deepEqual(order,['/active','/detail1','/detail2','/normal1','/normal2']);
    for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=19,'priority retains the 20 ms gap (1 ms timer tolerance)');
  }finally{first.resolve();await transport.close();}
});

test('priority does not bypass capacity and cancelled priority jobs never run',async()=>{
  let clock=1000;const q=createTaskQueue({maxActive:1,maxQueued:2,now:()=>clock});
  const first=deferred(),controller=new AbortController(),order=[];
  const active=q.run(()=>first.promise);await tick();
  clock=1010;const normal=q.run(()=>order.push('normal'));
  clock=1020;const high=q.run(()=>order.push('cancelled'),{priority:1,signal:controller.signal});
  const rejected=assert.rejects(high,{name:'AbortError'});
  clock=1030;assert.equal(q.diagnostics().oldestQueuedMs,20,'age still describes the oldest normal request');
  await assert.rejects(q.run(()=>{}, {priority:1}),{code:'CAPACITY_EXCEEDED'});
  controller.abort();await rejected;assert.equal(q.diagnostics().queued,1);
  const replacement=q.run(()=>order.push('detail'),{priority:1});
  first.resolve();await Promise.all([active,normal,replacement]);
  assert.deepEqual(order,['detail','normal']);q.close();
});

test('queued and new priority requests still obey a preceding 429 cooldown',async()=>{
  let clock=100000,calls=0;const first=deferred(),gate=createHostGate({now:()=>clock,minGap:()=>0});
  const work=()=>{calls++;return {status:200};};
  const active=gate.run('https://api.nasdaq.com/active',async()=>{calls++;await first.promise;return {status:429,headers:{'retry-after':'120'}};});
  await tick();
  const normal=gate.run('https://api.nasdaq.com/history',work),high=gate.run('https://api.nasdaq.com/trades',work,{priority:1});
  const results=Promise.allSettled([active,normal,high]);first.resolve();
  const settled=await results;assert.equal(settled[0].status,'fulfilled');
  for(const item of settled.slice(1)){assert.equal(item.reason.code,'SOURCE_COOLDOWN');assert.equal(item.reason.retryAt,220000);}
  assert.equal(calls,1);
  clock=219999;await assert.rejects(gate.run('https://api.nasdaq.com/trades',work,{priority:1}),{code:'SOURCE_COOLDOWN'});
  clock=220000;assert.equal((await gate.run('https://api.nasdaq.com/trades',work,{priority:1})).status,200);
  assert.equal(calls,2);gate.close();
});

test('priority is also removed when a transport has no host gate',async()=>{
  const transport=createTransport({upstream:async(url,headers,opts)=>{
    assert.equal(Object.hasOwn(opts,'priority'),false);return {status:200};
  }});
  try{assert.equal((await transport.httpsGet('https://example.test',{}, {priority:1})).status,200);}
  finally{await transport.close();}
});
