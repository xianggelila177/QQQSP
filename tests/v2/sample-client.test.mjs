import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
function sandbox(){const box={window:{},AbortController,setTimeout,clearTimeout};for(const name of ['panel-chart-engine','panel-chart-studies','panel-sample-store'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),box);return box.window;}
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

test('sample selection preserves indicator inputs while metadata changes, and invalidates on sample, currency or session changes',()=>{
 const w=sandbox(),select=w.PANEL_CHART_ENGINE.createObservationSeries(),calculate=w.PANEL_CHART_STUDIES.createCalculator();
 const open=Date.parse('2026-09-11T13:30:00Z'),rows=Object.freeze([
  ...Array.from({length:6},(_,i)=>Object.freeze(point(open/1000+i*60,218+i))),
  Object.freeze({...point(open/1000+120,300000),currency:'KRW'})
 ]);
 const day={date:'2026-09-11',sessions:[{open_at_ms:open,close_at_ms:open+360000}]};
 const quote={currency:'USD',regularChart:{recentSessions:[day]}},sample={points:rows,revision:1,status:'ready'};
 const first=select(quote,'samples',sample),study=calculate(first.bars,'quote-v1',{sma5:true});
 assert.equal(first.bars.length,6);
 const equivalent={...quote,price:999,regularChart:{recentSessions:JSON.parse(JSON.stringify([day]))}};
 const loading=select(equivalent,'samples',{...sample,status:'loading'});
 assert.strictEqual(loading.bars,first.bars,'equal session content and unchanged sample revision retain array identity');
 assert.strictEqual(calculate(loading.bars,'quote-v1',{sma5:true}),study,'stable selection preserves indicator cache');
 assert.match(loading.note,/正在读取/);
 const failure=select(equivalent,'samples',{...sample,error:'fixture error'});
 assert.strictEqual(failure.bars,first.bars);assert.equal(failure.note,'fixture error');

 const revised=select(equivalent,'samples',{...sample,revision:2});
 assert.notStrictEqual(revised.bars,first.bars,'sample revision invalidates selection even when input identity is retained');
 assert.deepEqual([...revised.bars],[...first.bars]);
 const replacement=select(equivalent,'samples',{...sample,points:Object.freeze([...rows]),revision:2});
 assert.notStrictEqual(replacement.bars,revised.bars,'new sample buffers invalidate even if revision is unchanged');
 const won=select({...equivalent,currency:'KRW'},'samples',sample);
 assert.equal(won.bars.length,1);assert.equal(won.bars[0].currency,'KRW');
 const narrowed=JSON.parse(JSON.stringify([day]));narrowed[0].sessions[0].close_at_ms=open+120000;
 const shorter=select({...quote,regularChart:{recentSessions:narrowed}},'samples',sample);
 assert.equal(shorter.bars.length,2,'session end is exclusive');
 narrowed[0].sessions[0].close_at_ms=open+60000;
 assert.equal(select({...quote,regularChart:{recentSessions:narrowed}},'samples',sample).bars.length,1,'in-place session content edits invalidate');
 narrowed[0].date='2026-09-14';
 const nextDay=select({...quote,regularChart:{recentSessions:narrowed}},'samples',sample);
 assert.equal(nextDay.bars.length,0);assert.match(nextDay.note,/等待新的有效报价/);
 assert.equal(select({...quote,regularChart:{}},'samples',sample).bars.length,0,'missing verified sessions do not reveal all samples');
 assert.equal(select({currency:'USD'},'samples',sample).bars.length,6,'absence of a session projection remains distinct from an empty projection');
});
