import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostGate} from '../../lib/host-gate.js';
import {providerRetryAt} from '../../lib/providers/provider-retry.js';
test('Yahoo sibling hosts share a cooldown; no early half-open request',async()=>{
 let now=100000,calls=0;const gate=createHostGate({now:()=>now,minGap:()=>0,baseMs:30000});
 const request=()=>{calls++;return {status:429,headers:{'retry-after':'120'}};};
 await gate.run('https://query1.finance.yahoo.com/chart',request);
 for(let i=0;i<20;i++)await assert.rejects(gate.run('https://query2.finance.yahoo.com/search',request),e=>e.code==='SOURCE_COOLDOWN'&&e.retryAt===220000);
 assert.equal(calls,1);now=219999;await assert.rejects(gate.run('https://fc.yahoo.com',request));
 now=220000;await gate.run('https://query2.finance.yahoo.com/chart',()=>{calls++;return {status:200};});
 assert.equal(calls,2);assert.equal(gate.diagnostics().yahoo.rateLimits,1);gate.close();
});
test('a source error does not stop an unrelated source',async()=>{
 const gate=createHostGate({minGap:()=>0});await gate.run('https://query1.finance.yahoo.com',()=>({status:429}));
 assert.equal((await gate.run('https://qt.gtimg.cn',()=>({status:200}))).status,200);gate.close();
});
test('all queued requests are checked again after the first 429',async()=>{
 let calls=0;const gate=createHostGate({minGap:()=>0});
 const result=await Promise.allSettled(Array.from({length:12},()=>gate.run('https://query1.finance.yahoo.com',()=>{calls++;return {status:429};})));
 assert.equal(calls,1);assert.equal(result.filter(x=>x.status==='rejected').length,11);gate.close();
});
test('Retry-After date and reset timestamp are lower bounds, never capped early',()=>{
 const now=Date.parse('2026-09-10T00:00:00Z');assert.equal(providerRetryAt({'Retry-After':'Fri, 11 Sep 2026 12:00:00 GMT'},now,30000),now+36*3600000);
 assert.equal(providerRetryAt({'retry-after':'0','x-ratelimit-reset':String((now+120000)/1000)},now,30000),now+120000);
});
