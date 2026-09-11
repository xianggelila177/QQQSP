import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {loadApp} from './_harness.mjs';
const window={};
vm.runInNewContext(fs.readFileSync(new URL('../public/modules/panel-scheduler.js',import.meta.url),'utf8'),{window,setTimeout,clearTimeout});
let at=12345, callbackCount=0, pending=null, cancelled=0;
const ticker=window.PANEL_SCHEDULER.createDisplayTicker(()=>callbackCount++,{now:()=>at,schedule:(fn,ms)=>(pending={fn,ms}),cancel:()=>cancelled++});
ticker.start();ticker.start();assert.equal(callbackCount,1);assert.equal(pending.ms,655);
at=13000;pending.fn();assert.equal(callbackCount,2);assert.equal(pending.ms,1000);
at+=15000;pending.fn();assert.equal(callbackCount,3,'resume jumps to present without replaying missed ticks');
ticker.stop();pending.fn();assert.equal(callbackCount,3);assert.equal(cancelled,1);
ticker.start();assert.equal(callbackCount,4);ticker.stop();
const fixture={symbol:'QQQ',price:500,quoteAt:Date.now()-10000,sourceCheckedAt:Date.now(),marketState:'REGULAR',currency:'USD',src:'fixture'};
const app=await loadApp({fakeWorker:true,watchlist:['QQQ'],initialMarket:[fixture]});await app.drain();
const card=app.hooks().cardCache.get('QQQ');
const ageBefore=Number(card.quoteAge.dataset.ageTickSeq);
const callsBefore=app.fetchLog.length;
// Worker emits no messages. The display timeout still runs and makes no fetch.
const tick=[...app.timers.all.values()].find(t=>t.kind==='timeout'&&!t.cleared&&t.ms>0&&t.ms<=1000);
assert.ok(tick);tick.fn();assert.ok(Number(card.quoteAge.dataset.ageTickSeq)>ageBefore);assert.equal(app.fetchLog.length,callsBefore);
app.workers[0].onerror();app.workers[0].onerror();
assert.equal(app.hooks().heartbeatMode(),'interval');assert.equal(app.timers.intervals(1000).length,1,'fallback heartbeat is idempotent');
const state=app.sandbox.window.PANEL_STATE;
for(const raw of ['null','[]','"text"','5','{bad']) {
 const store=state.createState({getItem:()=>raw,setItem(){}});assert.equal(Object.keys(store.loadNames('names')).length,0);
}
const store=state.createState({getItem:()=>'{"QQQ":" 纳指 ","SPY":1,"__proto__":{"x":1}}',setItem(){}});
const names=store.loadNames('names');assert.equal(Object.getPrototypeOf(names),null);assert.equal(names.QQQ,'纳指');assert.equal(names.SPY,undefined);assert.equal(names.__proto__,undefined);
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
assert.ok(!html.includes('layoutHint'));assert.ok(html.includes('id="layoutPreference"'));
console.log('v72 display clock independence, Worker failure, storage validation and layout removal passed');
