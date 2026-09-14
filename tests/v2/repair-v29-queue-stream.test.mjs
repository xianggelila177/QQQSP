import test from 'node:test';
import assert from 'node:assert/strict';
import {createStreamBudget} from '../../lib/stream-budget.js';
import {createTaskQueue} from '../../lib/task-queue.js';
import {createHostGate} from '../../lib/host-gate.js';
import {createSharedTasks} from '../../lib/shared-task.js';
import {streamAvailability,selectStream} from '../../lib/stream-policy.js';
import {mergeAlpacaQuote,createRealtimeQuoteService} from '../../lib/realtime-quote-service.js';
import {createHistoryService} from '../../lib/history-service.js';
import {dailyData,fixtureNow} from './history-v28-fixture.mjs';
import {readSseEvent} from '../support/read-sse.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const trade=(at,patch={})=>({state:'streaming',delayMinutes:0,connectionCheckedAt:at,source:'test-stream',trade:{symbol:'NVDA',quoteAt:at,receivedAt:at,price:110},...patch});
test('R01 heartbeat-only old trade cannot suppress a website fallback during trading',()=>{
 const value=trade(fixtureNow-600000,{connectionCheckedAt:fixtureNow});const p=streamAvailability('NVDA',value,fixtureNow);
 assert.equal(p.closed,false);assert.equal(p.usable,false);assert.equal(p.needsBackup,true);
 const merged=mergeAlpacaQuote(null,value,fixtureNow);assert.equal(merged.stale,true);assert.equal(merged.quoteAt,fixtureNow-600000);
});
test('R01 legal newer backup wins without manufacturing a new timestamp',()=>{
 const old=trade(fixtureNow-600000,{connectionCheckedAt:fixtureNow}),fresh=trade(fixtureNow-1000);
 assert.equal(selectStream('NVDA',old,fresh,fixtureNow),fresh);
 const base={symbol:'NVDA',price:112,quoteAt:fixtureNow-500,src:'website'};
 assert.equal(mergeAlpacaQuote(base,old,fixtureNow).quoteAt,base.quoteAt);
});
test('R01 delayed, unknown-delay, disconnected and resumed feeds have explicit availability',()=>{
 for(const delay of [null,15])assert.equal(streamAvailability('NVDA',trade(fixtureNow,{delayMinutes:delay}),fixtureNow).needsBackup,true);
 assert.equal(streamAvailability('NVDA',trade(fixtureNow,{state:'backoff'}),fixtureNow).usable,false);
 assert.equal(streamAvailability('NVDA',trade(fixtureNow),fixtureNow).needsBackup,false);
 assert.equal(streamAvailability('NVDA',trade(fixtureNow+60000),fixtureNow).usable,false);
});
test('R01 market closure accepts last legal trade but never changes its quoteAt',()=>{
 const saturday=Date.parse('2026-09-12T14:00:00Z'),value=trade(saturday-864e5,{connectionCheckedAt:saturday});
 assert.equal(streamAvailability('NVDA',value,saturday).closed,true);assert.equal(streamAvailability('NVDA',value,saturday).usable,true);
 assert.equal(mergeAlpacaQuote(null,value,saturday).quoteAt,value.trade.quoteAt);
});
test('R01 real service switches its enrichment cadence when a per-security trade ages',async()=>{
 let clock=fixtureNow,calls=0;const initial=trade(clock);const provider={supports:()=>true,touch:()=>true,read:()=>({...initial,connectionCheckedAt:clock}),start(){},stop(){},diagnostics:()=>({})};
 const service=createRealtimeQuoteService({provider,now:()=>clock,fallback:async()=>{calls++;return {symbol:'NVDA',price:111,quoteAt:clock-1};}});
 await service.getCachedQuote('NVDA');await wait(0);assert.equal(calls,1);clock+=600000;
 await service.getCachedQuote('NVDA');await wait(0);const out=await service.getCachedQuote('NVDA');assert.equal(calls,2);assert.equal(out.quoteAt,clock-1);service.stop();
});
test('R03 bounded admission rejects excess and removes cancelled waiting work immediately',async()=>{
 const q=createTaskQueue({maxActive:1,maxQueued:1}),d=deferred(),c=new AbortController();let ran=false;
 const a=q.run(()=>d.promise);const b=q.run(()=>{ran=true;},{signal:c.signal});const rejected=assert.rejects(b,{name:'AbortError'});
 await assert.rejects(q.run(()=>{}),{code:'CAPACITY_EXCEEDED'});c.abort();await rejected;assert.equal(q.diagnostics().queued,0);
 d.resolve();await a;await wait(0);assert.equal(ran,false);assert.equal(q.diagnostics().active,0);q.close();
});
test('R03 active cancellation retains its slot until an uncooperative producer actually stops',async()=>{
 const q=createTaskQueue({maxActive:1,maxQueued:0}),d=deferred(),c=new AbortController();const p=q.run(()=>d.promise,{signal:c.signal});
 await wait(0);c.abort();await assert.rejects(p);assert.equal(q.diagnostics().active,1);await assert.rejects(q.run(()=>{}),{code:'CAPACITY_EXCEEDED'});
 d.resolve();await wait(0);assert.equal(q.diagnostics().active,0);q.close();q.reopen();assert.equal(await q.run(()=>7),7);q.close();
});
test('R03 absolute source queue deadline prevents cancelled jobs from ever reaching the network',async()=>{
 const gate=createHostGate({maxQueued:2,deadlineMs:1000}),d=deferred();let ran=false;
 const a=gate.run('https://example.test/first',()=>d.promise);const b=gate.run('https://example.test/second',()=>{ran=true;},{deadlineAt:Date.now()+35});
 await assert.rejects(b,{code:'DEADLINE_EXCEEDED'});assert.equal(gate.diagnostics()['example.test'].queued,0);d.resolve();await a;await wait(0);assert.equal(ran,false);gate.close();
});
test('R02 shared readers own independent cancellation; last cancellation stops producer',async()=>{
 const shared=createSharedTasks(),d=deferred(),a=new AbortController(),b=new AbortController();let produced=0,signal;
 const producer=s=>{signal=s;produced++;return d.promise;};const x=shared.run('NVDA',producer,{signal:a.signal}),y=shared.run('NVDA',producer,{signal:b.signal});
 await wait(0);a.abort();await assert.rejects(x);assert.equal(signal.aborted,false);d.resolve(8);assert.equal(await y,8);assert.equal(produced,1);
 const z=shared.run('AAPL',s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason))),{signal:b.signal});await wait(0);b.abort();await assert.rejects(z);await wait(0);assert.equal(shared.size(),0);
});
test('R02 queued history has a total deadline separate from its upstream execution limit',async()=>{
 const h=createHistoryService({maxConcurrent:1,maxQueued:3,totalDeadlineMs:45,deadlineMs:5000,fetchChart:(s,q,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason))),now:Date.now});
 const at=performance.now();const results=await Promise.allSettled(['NVDA','MRVL','LITE'].map(s=>h.get(s,'daily')));
 assert.ok(performance.now()-at<500);assert.ok(results.every(x=>x.status==='rejected'&&x.reason.code==='HISTORY_TIMEOUT'));
 await wait(0);assert.equal(h.diagnostics().queued,0);assert.equal(h.diagnostics().active,0);h.close();
});
test('R02 cancelling one HTTP-equivalent history reader does not abort another reader',async()=>{
 const d=deferred(),ac=new AbortController();let upstreamSignal,calls=0;
 const h=createHistoryService({now:()=>fixtureNow,fetchChart:async(s,q,{signal})=>{calls++;upstreamSignal=signal;await d.promise;return dailyData(s);}});
 const a=h.get('NVDA','daily',{signal:ac.signal}),b=h.get('NVDA','daily');await wait(0);ac.abort();await assert.rejects(a);assert.equal(upstreamSignal.aborted,false);
 d.resolve();assert.ok((await b).bars.length);assert.equal(calls,1);h.close();
});
test('R16 SSE event parser survives every split position, including split UTF-8 text',async()=>{
 const data=new TextEncoder().encode('retry: 3000\n\nevent: macro\ndata: {"text":"测试"}\n\n');
 for(let split=1;split<data.length;split++){
  const stream=new ReadableStream({start(c){c.enqueue(data.slice(0,split));c.enqueue(data.slice(split));c.close();}});
  assert.match(await readSseEvent(stream.getReader(),{event:'macro'}),/测试/);
 }
});

test('R03 accepted SSE backpressure keeps a connection registered until budget overflow closes it',()=>{
 const budget=createStreamBudget({maxConnections:1,maxBufferedBytes:32,maxClientBytes:16});
 const response={writableLength:0,destroyed:false,write(text){this.writableLength+=Buffer.byteLength(text);return false;},destroy(){this.destroyed=true;}};
 assert.equal(budget.acquire(response),true);assert.equal(budget.write(response,'retry: 1\n\n'),true);
 assert.equal(budget.diagnostics().connections,1);assert.equal(response.destroyed,false);
 assert.equal(budget.write(response,'x'.repeat(20)),false);assert.equal(response.destroyed,true);
 budget.release(response);assert.equal(budget.diagnostics().connections,0);
});
