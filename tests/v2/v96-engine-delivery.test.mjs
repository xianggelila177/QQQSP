import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuoteEngine} from '../../lib/quote-engine.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('a newer stream event received during an in-flight read is delivered without waiting for the periodic tick',async t=>{
 let release,calls=0,current=10;
 const engine=createQuoteEngine({tickMs:60000,readQuote:async()=>{calls++;const price=current;if(calls===1)await new Promise(r=>release=r);return {symbol:'QQQ',price,quoteAt:price*1000};}});
 t.after(()=>engine.stop());engine.start();engine.watch(['QQQ']);await pause(1);
 current=11;engine.poke('QQQ');await pause(120);release();await pause(30);
 assert.equal(engine.read(['QQQ'],{lease:false})[0].price,11);
});

test('a burst of free-stream updates renders the newest price with bounded decoration work',async t=>{
 let current=1,calls=0,decorations=0;
 const engine=createQuoteEngine({tickMs:60000,readQuote:async()=>{calls++;return {symbol:'NVDA',price:current,quoteAt:current*1000};},decorateQuote:q=>{decorations++;return q;}});
 t.after(()=>engine.stop());engine.start();engine.watch(['NVDA']);await pause(1);calls=0;decorations=0;
 for(current=2;current<=20;current++){engine.poke('NVDA');await Promise.resolve();await Promise.resolve();await Promise.resolve();}
 current=20;await pause(160);
 assert.equal(engine.read(['NVDA'],{lease:false})[0].price,20);
 assert.ok(calls<=3,'incoming bursts must not trigger a full read for every message');
 assert.ok(decorations<=3,'incoming bursts must not recompute financial decoration for every message');
});

test('queued stream updates are discarded when a security is removed or the engine stops',async()=>{
 let calls=0;const engine=createQuoteEngine({tickMs:60000,readQuote:async()=>{calls++;return {symbol:'QQQ',price:1,quoteAt:1000};}});
 engine.start();const unwatch=engine.watch(['QQQ']);await pause(1);const before=calls;
 engine.poke('QQQ');unwatch();engine.stop();await pause(160);assert.equal(calls,before);
});
