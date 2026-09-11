import test from 'node:test';import assert from 'node:assert/strict';
import {createQuoteEngine} from '../../lib/quote-engine.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('HTTP reads only cached quotes; one update path, exact trade time retained',async()=>{
 let calls=0,now=1000;const q={symbol:'QQQ',price:10,quoteAt:1000,sourceCheckedAt:1000};
 const e=createQuoteEngine({readQuote:async()=>{calls++;return q;},now:()=>now,tickMs:60000});e.start();
 const unwatch=e.watch(['QQQ']);await pause(1);assert.equal(calls,1);
 for(let i=0;i<100;i++)e.read(['QQQ'],{lease:false});assert.equal(calls,1);now+=1000;e.tick();await pause(1);
 assert.equal(e.read(['QQQ'],{lease:false})[0].quoteAt,1000);unwatch();e.stop();
});
test('new trades coalesce to one event; unchanged snapshots do not emit',async()=>{
 let price=10,now=1000,events=0;const e=createQuoteEngine({now:()=>now,readQuote:async()=>({symbol:'QQQ',price,quoteAt:now}),tickMs:60000});
 e.subscribe(()=>events++);e.start();e.watch(['QQQ']);await pause(70);assert.equal(events,1);e.tick();await pause(70);assert.equal(events,1);
 now++;price=11;e.poke('QQQ');await pause(70);assert.equal(events,2);e.stop();
});
