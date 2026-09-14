import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
function sandbox(){const box={window:{},AbortController,setTimeout,clearTimeout};for(const name of ['panel-chart-engine','panel-sample-store'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),box);return box.window;}
const point=(t,c=218)=>({t,c,_sample:true,v:null,source:'fixture',currency:'USD',tradingDate:'2026-09-11'});
test('default stays history; empty samples never convert the latest quote into a historical point',()=>{
 const w=sandbox(),select=w.PANEL_CHART_ENGINE.createObservationSeries();const quote={price:218,quoteAt:Date.now(),charts:{intraday:[]}};
 assert.equal(select(quote).sampled,false);assert.equal(select(quote).bars.length,0);
 assert.equal(select(quote,'samples').bars.length,0);
 const rows=[point(100)];assert.strictEqual(select(quote,'samples',{points:rows}).bars,rows);
});
test('server samples load once, minute upserts replace and retained dates prune',async()=>{
 const w=sandbox();let calls=0;
 const store=w.PANEL_SAMPLE_STORE.createSampleStore({symbol:'NVDA',fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({symbol:'NVDA',revision:1,tradingDays:['2026-09-11'],points:[point(100)]})};}});
 await store.load();await store.load();assert.equal(calls,1);
 store.apply({symbol:'NVDA',revision:2,tradingDays:['2026-09-11'],points:[point(110,219)]});assert.equal(store.snapshot().points.length,1);assert.equal(store.snapshot().points[0].c,219);
 store.apply({symbol:'SPY',revision:3,tradingDays:[],points:[]});assert.equal(store.snapshot().points.length,1);
 store.apply({symbol:'NVDA',revision:3,tradingDays:['2026-09-14'],points:[]});assert.equal(store.snapshot().points.length,0);
});
test('a delayed snapshot cannot erase a newer push, reconnect reloads and failed loads retain data',async()=>{
 const w=sandbox();let resolve,calls=0,fail=false;
 const store=w.PANEL_SAMPLE_STORE.createSampleStore({symbol:'NVDA',fetchImpl:async()=>{calls++;if(fail)throw Error('offline');return new Promise(r=>resolve=r);}});
 const job=store.load();store.apply({symbol:'NVDA',revision:2,tradingDays:['2026-09-11'],points:[point(170,220)]});
 resolve({ok:true,json:async()=>({symbol:'NVDA',revision:1,tradingDays:['2026-09-11'],points:[point(100)]})});await job;assert.equal(store.snapshot().points.length,2);
 fail=true;await store.load(true);assert.equal(calls,2);assert.equal(store.snapshot().points.length,2);assert.ok(store.snapshot().error);
 store.abort();
});
