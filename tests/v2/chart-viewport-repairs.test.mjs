import test from 'node:test';
import assert from 'node:assert/strict';
import {context,bars,modules,simple,mounted} from './chart-viewport-fixture.mjs';
const response=(period,history,revision='1',extra={})=>({schemaVersion:1,symbol:'NVDA',period,seriesId:'fixture-'+period,revision,sourceCheckedAt:Number(revision),status:'ready',bars:history,...extra});
const createStore=(m,network={})=>m.window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',network});
const priceSegments=p=>p.ctx.strokes.filter(s=>s.clipped&&['red','green'].includes(s.style)).reduce((n,s)=>n+s.path.filter(x=>x[0]==='L').length,0);
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};

test('T01 actual engine connects historical closing lines but splits real intraday gaps',()=>{
 const m=modules();
 for(const tf of ['daily30','weekly','monthly','yearly']){
  const h=bars(10,tf==='weekly'?604800:tf==='yearly'?31536000:86400),q=simple(m,h,tf,400,{chartStyle:'line'}),p=m.engine.computePlot(q);p.ctx=context();m.engine.drawPlot(q,p);
  assert.equal(priceSegments(p),9,tf+' must join adjacent trading periods');
  q.chartStyle='candle';const candles=m.engine.computePlot(q);assert.equal(candles.candle,true);assert.equal(candles.bars[4].h,h[4].h);
 }
 const h=bars(4,300);h[2].t+=3600;h[3].t+=3600;const q=simple(m,h,'intraday',400,{chartStyle:'line'}),p=m.engine.computePlot(q);p.ctx=context();m.engine.drawPlot(q,p);assert.equal(priceSegments(p),2);
});

test('T02 one/five day initial viewport fits real sessions at every card width and retains explicit zoom',()=>{
 const m=modules(),sessions=Array.from({length:5},(_,i)=>({open_at_ms:Date.parse('2026-09-21T13:30Z')+i*86400000,close_at_ms:Date.parse('2026-09-21T20:00Z')+i*86400000}));
 const h=sessions.flatMap(s=>bars(78,300,s.open_at_ms/1000));
 for(const width of [300,400,650]){
  const q=simple(m,h,'intraday',width,{_fiveDay:true,d:{regularChart:{bars:h,regularSessions:sessions,intervalSeconds:300},charts:{intraday:h}}});
  assert.equal(m.engine.computePlot(q).vis,390,'five day '+width);
  q.visN.intraday=20;assert.equal(m.engine.computePlot(q).vis,20,'explicit zoom preserved');
  delete q.visN.intraday;delete q._fiveDay;q.d.charts.intraday=h.slice(-78);assert.equal(m.engine.computePlot(q).vis,78);
 }
});

test('T08 mounted buttons and wheel escape one/two-bar zoom and consume boundary wheel',async()=>{
 const m=modules(),c=mounted(m,bars(39),'yearly',1),zoom=c.meter.children.find(e=>e.className==='zoombar');
 await zoom.dispatch('click',{target:{dataset:{z:'out'}}});assert.equal(c.q.plot.vis,2);
 let prevented=0;await c.q.cv.dispatch('wheel',{ctrlKey:true,deltaY:100,clientX:200,preventDefault(){prevented++}});assert.equal(c.q.plot.vis,3);
 c.q.visN.yearly=39;c.controller.drawChart(c.q,true);await c.q.cv.dispatch('wheel',{metaKey:true,deltaY:100,clientX:200,preventDefault(){prevented++}});assert.equal(prevented,2);assert.equal(c.q.plot.vis,39);c.controller.unmount(c.q);
});

test('T09 mounted applyPrewarm and source corrections preserve the visible date anchor',()=>{
 const m=modules(),h=bars(40),store=createStore(m);store.hydrate('daily30',response('daily',h));const c=mounted(m,h,'daily30',10,store);
 c.q.followEnd=false;c.q.winStart=10;c.controller.drawChart(c.q,true);const first=c.q.plot.bars[0].periodStart;
 c.controller.applyPrewarm(c.q,{symbol:'NVDA',periods:{daily:response('daily',bars(60,86400,h[0].t-20*86400),'2')}});
 assert.equal(c.q.plot.bars[0].periodStart,first);
 // A removed anchor resolves to the closest surviving trading period, ties prefer the later one.
 const corrected=store.getSeries('daily30').filter(b=>b.periodStart!==first);store.hydrate('daily30',response('daily',corrected,'3'));c.controller.drawChart(c.q,true);
 assert.equal(c.q.plot.bars[0].t,h[11].t);c.controller.unmount(c.q);
});

test('T10 actual pointer drag requests consecutive older pages without losing the date or duplicating inflight requests',async()=>{
 for(const [tf,period,step] of [['daily30','daily',86400],['weekly','weekly',604800],['yearly','yearly',31536000]]){
 const m=modules(),h=bars(40,step),requests=[];let release;const store=createStore(m,{request:async(key,url)=>{requests.push(url);return new Promise(resolve=>release=rows=>resolve({ok:true,status:200,json:async()=>response(period,rows,String(requests.length+1),{hasMore:requests.length<2})}))}});
 store.hydrate(tf,response(period,h,'1',{hasMore:true}));const c=mounted(m,h,tf,10,store);
 await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100});await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:10000});m.flush();await settle();
 assert.equal(requests.length,1);const anchor=c.q.plot.bars[0].periodStart;
 await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:10010});m.flush();assert.equal(requests.length,1);
 release(bars(20,step,h[0].t-20*step));await settle();assert.equal(c.q.plot.bars[0].periodStart,anchor,'prepending must preserve current date');
 await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:20000});m.flush();await settle();assert.equal(requests.length,2);
 release(bars(20,step,h[0].t-40*step));await settle();assert.equal(c.q.loadOlderButton.hidden,true);await c.q.cv.dispatch('pointerup',{pointerId:1});c.controller.unmount(c.q);
 }
});

test('T11 main card style and viewport remain local to each period through resize',async()=>{
 const m=modules(),c=mounted(m,bars(100),'daily30',15);c.q.followEnd=false;c.q.winStart=25;c.controller.drawChart(c.q,true);
 await c.styles[1].dispatch('click',{});assert.equal(c.q.winStart,25,'style toggle preserves pan');assert.equal(c.q.visN.daily30,15);
 await c.q.tabs.find(t=>t.dataset.tf==='weekly').dispatch('click',{});assert.equal(c.q.chartStyle,'candle');
 c.q.visN.weekly=8;c.q.followEnd=false;c.q.winStart=12;c.controller.drawChart(c.q,true);
 await c.q.tabs.find(t=>t.dataset.tf==='daily30').dispatch('click',{});assert.equal(c.q.chartStyle,'line');assert.equal(c.q.winStart,25);assert.equal(c.q.plot.vis,15);
 c.q._chartWidth=300;c.controller.drawChart(c.q,true);assert.equal(c.q.winStart,25);assert.equal(c.q.plot.vis,15);assert.equal(c.styles[1].textContent,'收盘线');c.controller.unmount(c.q);
});

test('T12 near annual prewarm keeps desired extent while expanding then exposes requested/available extent',async()=>{
 const m=modules(),h=bars(39,31536000);let release;const store=createStore(m,{request:async()=>new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>response('yearly',h,'2',{extent:{scope:'requested',satisfied:true}})}))});
 store.hydrate('yearly',response('yearly',h.slice(-1),'1',{prewarmScope:'near',extent:{scope:'near',satisfied:false}}));const c=mounted(m,h,'daily30',undefined,store);
 const job=c.q.tabs.find(t=>t.dataset.tf==='yearly').dispatch('click',{});await settle();
 assert.equal(c.q.plot.vis,1);assert.equal(c.q.visN.yearly,undefined);assert.equal(store.getMeta('yearly').loadingExtent.count,39);
 release();await job;assert.equal(c.q.plot.vis,20);assert.equal(store.getMeta('yearly').availableExtent.count,39);assert.equal(store.getMeta('yearly').loadingExtent,null);c.controller.unmount(c.q);
});

test('T16 same array/revision capability is not rescanned and revision invalidates an interior correction',()=>{
 const m=modules();let reads=0,revision=1;const h=bars(2000).map(b=>{let high=b.h;Object.defineProperty(b,'h',{enumerable:true,get(){reads++;return high},set(v){high=v}});return b});
 const q=simple(m,h,'daily30',400,{visN:{daily30:40},historyStore:{getSeries:()=>h,getRevision:()=>revision,getMeta:()=>({meta:{}})}});
 m.window.PANEL_CHART_ENGINE.candleCapability(q,h);reads=0;for(let i=0;i<20;i++)m.window.PANEL_CHART_ENGINE.candleCapability(q,h);assert.ok(reads<50,'same revision rescanned '+reads+' highs');
 h[50].h=-1;revision++;assert.equal(m.window.PANEL_CHART_ENGINE.candleCapability(q,h).available,false);
});

test('T16 offscreen mounted status never scans hidden OHLC and drag paints at most once per frame',async()=>{
 const m=modules(),c=mounted(m,bars(2000),'daily30',40);let reads=0;const h=bars(2000).map(b=>Object.defineProperty(b,'h',{enumerable:true,get(){reads++;return b.c+1}}));c.update(h);c.q.visible=false;
 for(let i=0;i<10;i++)c.controller.drawChart(c.q);assert.equal(reads,0);
 c.q.visible=true;c.controller.drawChart(c.q);c.q.cv.cx.strokes=[];await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100});
 for(let i=0;i<10;i++)await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:101+i});assert.equal(c.q.cv.cx.strokes.length,0);assert.equal(m.frames.length,1);m.flush();assert.ok(c.q.cv.cx.strokes.length>0);c.controller.unmount(c.q);
});


test('T09 late page preserves the user pan made during the request and following latest alone follows new bars',async()=>{
 const m=modules(),h=bars(40);let release;const store=createStore(m,{request:async()=>new Promise(resolve=>release=rows=>resolve({ok:true,status:200,json:async()=>response('daily',rows,'2',{hasMore:true})}))});
 store.hydrate('daily30',response('daily',h,'1',{hasMore:true}));const c=mounted(m,h,'daily30',10,store);
 c.q.followEnd=false;c.q.winStart=4;c.controller.drawChart(c.q,true);const pending=store.load('daily30',{before:h[0].periodStart});
 c.q.winStart=12;c.controller.drawChart(c.q,true);const anchor=c.q.plot.bars[0].periodStart;release(bars(20,86400,h[0].t-20*86400));await pending;c.controller.drawChart(c.q,true);assert.equal(c.q.plot.bars[0].periodStart,anchor);
 c.q.followEnd=true;c.controller.applyPrewarm(c.q,{symbol:'NVDA',periods:{daily:response('daily',bars(45),'3')}});assert.equal(c.q.plot.bars.at(-1).t,h[0].t+44*86400);c.controller.unmount(c.q);
});

test('T10 store deduplicates an identical inflight page and failure retains bars and usable zoom',async()=>{
 const m=modules(),h=bars(40),calls=[];let release;const store=createStore(m,{request:async(key,url)=>{calls.push(url);return new Promise(resolve=>release=()=>resolve({ok:false,status:429,json:async()=>({error:'cooling',code:'HISTORY_RATE_LIMITED',retryAt:Date.now()+60000})}))}});
 store.hydrate('daily30',response('daily',h,'1',{hasMore:true}));const c=mounted(m,h,'daily30',10,store),options={before:h[0].periodStart};
 const first=store.load('daily30',options),second=store.load('daily30',options);assert.equal(first,second);assert.equal(calls.length,1);release();await first;c.controller.drawChart(c.q,true);
 assert.equal(c.q.plot.all.length,40);assert.equal(store.getMeta('daily30').status,'stale');assert.equal(store.getMeta('daily30').loadingExtent,null);assert.equal(c.q.loadOlderButton.disabled,true);
 await c.meter.children.find(e=>e.className==='zoombar').dispatch('click',{target:{dataset:{z:'in'}}});assert.ok(c.q.plot.vis<10);c.controller.unmount(c.q);
});

test('T12 near long-period prewarm cannot supersede the expansion and failed expansion stays retryable',async()=>{
 const m=modules(),h=bars(3,31536000);let release;const store=createStore(m,{request:async()=>new Promise(resolve=>release=()=>resolve({ok:false,status:503,json:async()=>({error:'offline',code:'HISTORY_SOURCE_UNAVAILABLE'})}))});
 store.hydrate('yearly',response('yearly',h.slice(-1),'1',{prewarmScope:'near',extent:{scope:'near',satisfied:false}}));const pending=store.load('yearly');
 store.hydrate('yearly',response('yearly',h.slice(-1),'2',{prewarmScope:'near',extent:{scope:'near',satisfied:false}}));assert.equal(store.getMeta('yearly').status,'loading');assert.equal(store.getMeta('yearly').loadingExtent.count,39);
 release();await pending;assert.equal(store.getSeries('yearly').length,1);assert.equal(store.needsLoad('yearly'),true);assert.equal(store.getMeta('yearly').status,'stale');assert.equal(store.getMeta('yearly').loadingExtent,null);
});

test('T16 intraday interval inference is cached by revision and history periods do not infer minute deltas',()=>{
 const m=modules();let reads=0,revision=1;const h=bars(2000,300).map(b=>{const t=b.t;Object.defineProperty(b,'t',{enumerable:true,get(){reads++;return t}});return b});
 const q=simple(m,h,'intraday',400,{visN:{intraday:40},d:{intradayVer:revision,charts:{intraday:h}}});m.engine.computePlot(q);reads=0;for(let i=0;i<10;i++)m.engine.computePlot(q);assert.ok(reads<100,'must not read every timestamp for cached cadence: '+reads);
 q.d.intradayVer=++revision;reads=0;m.engine.computePlot(q);assert.ok(reads>=h.length,'new revision infers cadence again');
 const daily=simple(m,h,'daily30',400,{visN:{daily30:40}});reads=0;m.engine.computePlot(daily);assert.ok(reads<100,'daily does not sort minute deltas');
});


test('T10 one failing drag does not spin immediate retries; a new gesture can retry',async()=>{
 const m=modules(),h=bars(40);let calls=0;const store=createStore(m,{request:async()=>{calls++;return {ok:false,status:503,json:async()=>({error:'temporary source failure',code:'HISTORY_SOURCE_UNAVAILABLE'})}}});store.hydrate('daily30',response('daily',h,'1',{hasMore:true}));const c=mounted(m,h,'daily30',10,store);
 await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100});await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:10000});m.flush();await settle();assert.equal(calls,1);
 await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:10001});m.flush();await settle();assert.equal(calls,1,'same failed gesture must not retry on every event');
 await c.q.cv.dispatch('pointerup',{pointerId:1});await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:2,clientX:100});await c.q.cv.dispatch('pointermove',{pointerId:2,clientX:101});m.flush();await settle();assert.equal(calls,2);c.controller.unmount(c.q);
});

test('T02 full-view intent continues to include newly delivered bars',()=>{
 const m=modules(),h=bars(78,300),q=simple(m,h,'intraday',400,{visN:{intraday:78},fullSession:true});assert.equal(m.engine.computePlot(q).n,78);
 q.d.charts.intraday=bars(79,300);assert.equal(m.engine.computePlot(q).n,79);
});


test('T09 explicit older paging from a single yearly bar preserves its effective viewport while initial expansion remains progressive',async()=>{
 const m=modules(),h=bars(11,31536000),initial=h.slice(-1);const store=createStore(m,{request:async()=>({ok:true,status:200,json:async()=>response('yearly',h.slice(0,-1),'2',{hasMore:false})})});store.hydrate('yearly',response('yearly',initial,'1',{hasMore:true}));const c=mounted(m,initial,'yearly',20,store);delete c.q.visN.yearly;c.controller.drawChart(c.q,true);const anchor=c.q.plot.bars[0].periodStart;
 await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100});await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:10000});m.flush();await settle();assert.equal(c.q.plot.vis,1);assert.equal(c.q.plot.bars[0].periodStart,anchor);c.controller.unmount(c.q);
});


test('main OHLC volume labels do not leak internal unit enums',()=>{
 for(const [unit,label] of [['source-unit-unverified','单位待核验'],['unknown','单位待核验'],['contracts','张'],['round_lots','整手']]){
  const m=modules(),h=bars(10),store=createStore(m);store.hydrate('daily30',response('daily',h,'1',{volumeUnit:unit}));const c=mounted(m,h,'daily30',10,store);
  assert.ok(c.q.ohlc.innerHTML.includes(' '+label+'  '),unit);c.controller.unmount(c.q);
 }
});
