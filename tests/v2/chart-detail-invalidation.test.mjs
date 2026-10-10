import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {detailHarness} from './detail-ux-fixture.mjs';

// Exercise the public detail update with the actual chart engine, settings and
// drawing code, counting expensive work rather than using elapsed-time limits.
const directory=mkdtempSync(join(tmpdir(),'qqqsp-detail-invalidation-'));
const root=new URL('../../public/modules/',import.meta.url);
const modules=['panel-scheduler','panel-timeframes','panel-state','panel-format','panel-trade-direction',
  'panel-chart-viewport','panel-market-detail-model','panel-market-detail-view','panel-detail-dialog',
  'panel-chart','panel-chart-studies','panel-chart-engine','panel-chart-workspace','panel-chart-drawings'];
const probe=`
  window.localStorage=(()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};})();
  window.detailCounts={compute:0,draw:0,cursor:0};
  window.detailDrawingState={calls:0,draft:null};
  {const original=window.PANEL_CHART_DRAWINGS;window.PANEL_CHART_DRAWINGS={...original,draw:(...args)=>{
    window.detailDrawingState.calls++;window.detailDrawingState.draft=args[3]?.draft;return original.draw(...args);}};}
  {const original=window.PANEL_CHART_ENGINE;window.PANEL_CHART_ENGINE={...original,createChartEngine:options=>{
    const engine=original.createChartEngine(options);return {...engine,
      computePlot:view=>{window.detailCounts.compute++;window.detailView=view;return engine.computePlot(view);},
      drawPlot:(...args)=>{window.detailCounts.draw++;return engine.drawPlot(...args);},
      drawCursor:(...args)=>{window.detailCounts.cursor++;return engine.drawCursor(...args);}};}};}
`;
const formatProbe=`
  {const original=window.PANEL_CHART_DETAIL;window.PANEL_CHART_DETAIL={...original,createChartDetailView:options=>original.createChartDetailView({...options,
    formatterFor:data=>({unit:window.detailUnit||data.currency,canConvert:true,convert:v=>v*(window.detailRate||1),
      money:v=>(window.detailUnit||data.currency)+' '+Number(v*(window.detailRate||1)).toFixed(2)})})};}
`;
writeFileSync(join(directory,'panel-chart-detail.js'),modules.map(name=>readFileSync(new URL(name+'.js',root),'utf8')).join('\n')+probe+readFileSync(new URL('panel-chart-detail.js',root),'utf8')+formatProbe);
after(()=>rmSync(directory,{recursive:true,force:true}));
const fixture=()=>{
  const h=detailHarness({moduleRoot:pathToFileURL(directory+'/')});
  // The small DOM fixture supplies drawing operations but not gradients.
  for(const selector of ['.cd-canvas','.cd-cursor','.cd-drawing-layer']){
    const canvas=h.field(selector),getContext=canvas.getContext.bind(canvas);
    canvas.getContext=(...args)=>new Proxy(getContext(...args),{get:(target,key)=>key==='createLinearGradient'?()=>({addColorStop(){}}):target[key]});
  }
  return h;
};
const update=async h=>{h.view.update(h.card);await h.flush();};
const plot=h=>h.panel.detailView.plot;
const countWrites=h=>{
  let writes=0;
  for(const selector of ['.cd-canvas','.cd-cursor','.cd-drawing-layer'])for(const field of ['width','height']){
    const canvas=h.field(selector);let value=canvas[field];
    Object.defineProperty(canvas,field,{get:()=>value,set:next=>{writes++;value=next;},configurable:true});
  }
  return ()=>writes;
};

test('unchanged detail history skips main plot and bitmap resets while quote summary and cursor stay live',async()=>{
  const h=fixture();await h.select('daily30');
  const before={...h.panel.detailCounts},writes=countWrites(h),firstPlot=plot(h);
  for(let i=0;i<30;i++){h.card.d={...h.card.d,price:200+i,quoteAt:h.card.d.quoteAt+1000};await update(h);}
  assert.equal(h.panel.detailCounts.compute,before.compute);assert.equal(h.panel.detailCounts.draw,before.draw);
  assert.equal(writes(),0);assert.equal(plot(h),firstPlot);assert.equal(h.field('.cd-price').textContent,'USD 229.00');
  assert.ok(h.panel.detailCounts.cursor>before.cursor);
  const beforeCursor=h.panel.detailCounts.cursor;h.field('.cd-canvas').dispatch('keydown',{key:'Home'});
  assert.equal(h.panel.detailCounts.compute,before.compute);assert.ok(h.panel.detailCounts.cursor>beforeCursor);
  assert.match(h.field('.cd-point').textContent,/2026-01-01/);h.view.close();
});

test('history changes, formatting, studies, viewport, resize and DPR invalidate without resetting equal bitmap sizes',async()=>{
  const h=fixture();await h.select('daily30');const writes=countWrites(h);
  const changed=async fn=>{const before=h.panel.detailCounts.compute;await fn();await h.flush();assert.equal(h.panel.detailCounts.compute,before+1);};
  await changed(()=>{h.data.daily30.at(-1).c=100.5;h.view.update(h.card);});assert.equal(writes(),0);
  let revision=1;h.card.historyStore.getRevision=()=>revision;
  await changed(()=>{revision++;h.data.daily30[2]={...h.data.daily30[2],c:100.25};h.view.update(h.card);});
  await changed(()=>{h.panel.detailUnit='CNY';h.view.update(h.card);});
  await changed(()=>{h.panel.detailRate=7;h.view.update(h.card);});assert.match(h.field('.cd-point').textContent,/CNY 700/);
  const beforeQuoteCurrency=h.panel.detailCounts.compute;h.card.d.currency='TWD';await update(h);
  assert.equal(h.panel.detailCounts.compute,beforeQuoteCurrency,'history retains its own declared currency');
  const getMeta=h.card.historyStore.getMeta;
  await changed(()=>{h.card.historyStore.getMeta=tf=>{const entry=getMeta(tf);return {...entry,meta:{...entry.meta,currency:'TWD'}};};h.view.update(h.card);});
  await changed(()=>h.field('.cd-settings').dispatch('change',{target:{dataset:{chartStudy:'rsi14'},checked:true}}));assert.ok(plot(h).rsiPane);
  await changed(()=>h.field('[data-range="30"]').click());assert.equal(plot(h).n,30);
  await changed(()=>h.field('[data-chart-style="line"]').click());assert.equal(plot(h).candle,false);
  assert.equal(writes(),0);
  await changed(()=>{h.field('.cd-plot').getBoundingClientRect=()=>({width:800,height:400});h.view.update(h.card);});
  assert.equal(writes(),6);assert.equal(plot(h).W,800);assert.equal(plot(h).H,400);
  await changed(()=>{h.panel.devicePixelRatio=2;h.view.update(h.card);});assert.equal(writes(),12);
  await update(h);assert.equal(writes(),12);h.view.close();
});

test('quality and paging-only changes update their labels without recomputing history geometry',async()=>{
  const h=fixture();await h.select('daily30');const before=h.panel.detailCounts.compute,getMeta=h.card.historyStore.getMeta;
  h.card.historyStore.getMeta=tf=>{const entry=getMeta(tf);return {...entry,status:'stale',pagination:{hasMore:false},meta:{...entry.meta,historyAsOf:'2026-09-24',coverageStatus:'partial'}};};
  await update(h);assert.equal(h.panel.detailCounts.compute,before);
  assert.match(h.field('.cd-chart-info').textContent,/缓存待更新/);assert.match(h.field('.cd-chart-info').textContent,/2026-09-24/);
  assert.equal(h.field('[data-action="older"]').hidden,true);assert.match(h.field('.cd-history-state').textContent,/历史起点/);
  h.view.close();
});

test('a quote trading-date rollover clears a pending drawing layer while the historical plot remains cached',async()=>{
  const h=fixture();await h.select('daily30');
  const pointer=index=>({pointerType:'mouse',button:0,pointerId:1,clientX:plot(h).x(index),clientY:plot(h).y(plot(h).bars[index].c)});
  h.field('[data-draw="trend"]').click();h.field('.cd-canvas').dispatch('pointerdown',pointer(3));
  h.field('.cd-canvas').dispatch('pointermove',pointer(7));
  assert.equal(h.panel.detailDrawingState.draft.points.length,2);
  const before=h.panel.detailCounts.compute,draws=h.panel.detailDrawingState.calls,writes=countWrites(h);
  h.card.d.regularChart.tradeDate='2026-09-26';await update(h);
  assert.equal(h.panel.detailCounts.compute,before);assert.equal(writes(),0);
  assert.equal(h.panel.detailDrawingState.calls,draws+1);assert.equal(h.panel.detailDrawingState.draft,null);
  assert.equal(h.field('.cd-draw-state').textContent,'点击起点，再点击终点');
  h.field('.cd-canvas').dispatch('pointerdown',pointer(8));assert.equal(h.panel.detailDrawingState.draft.points.length,1);
  h.view.close();
});

test('history invalidates when the existing engine interval-unknown capability input changes',async()=>{
  const h=fixture();await h.select('daily30');assert.equal(plot(h).candle,true);
  for(const unknown of [true,false]){
    const before=h.panel.detailCounts.compute;h.card.d.regularChart.intervalUnknown=unknown;await update(h);
    assert.equal(h.panel.detailCounts.compute,before+1);assert.equal(plot(h).candleAvailable,!unknown);
    assert.equal(plot(h).candle,!unknown);assert.equal(h.field('[data-chart-style="candle"]').disabled,unknown);
  }
  h.view.close();
});

test('intraday retains stable geometry but invalidates bars, reference, sessions, interval and live point eligibility',async()=>{
  const h=fixture();await h.flush();let before=h.panel.detailCounts.compute;
  for(let i=0;i<5;i++){h.card.d={...h.card.d,price:120+i,quoteAt:h.card.d.quoteAt+1000};await update(h);}
  assert.equal(h.panel.detailCounts.compute,before);
  const changed=async fn=>{before=h.panel.detailCounts.compute;fn();await update(h);assert.equal(h.panel.detailCounts.compute,before+1);};
  await changed(()=>{h.card.d.regularChart.bars=h.card.d.regularChart.bars.map((bar,i)=>i===2?{...bar,c:100.25}:bar);});
  await changed(()=>{h.card.d.regularChart.previousCloseReference={value:99};});assert.equal(plot(h).reference.value,99);
  const last=h.card.d.regularChart.bars.at(-1),open=last.t*1000-3600000,close=last.t*1000+3600000;
  await changed(()=>{h.card.d.regularChart.regularSessions=[{open_at_ms:open,close_at_ms:close}];});assert.equal(plot(h).timeline,true);
  await changed(()=>{h.card.d.regularChart.intervalSeconds=60;});assert.equal(plot(h).intervalSeconds,60);
  await changed(()=>{
    const point={t:last.t+60,c:125,v:null,currency:'USD',source:'fixture',sessionDate:'2026-09-25',historyDate:'2026-09-25'};
    Object.assign(h.card.d,{price:125,quoteAt:point.t*1000,src:'fixture',marketState:'REGULAR',priceSession:'REGULAR',intradayLivePoint:point,intradayLiveStatus:'ready'});
    h.card.d.regularChart.source='fixture';
  });assert.ok(plot(h).live);
  await changed(()=>{h.card.d.stale=true;});assert.equal(plot(h).live,null);
  h.view.close();
});

test('an active intraday progressive axis advances with wall time even when quote and bars are unchanged',async()=>{
  const realNow=Date.now;let now=Date.parse('2026-09-25T15:00:00Z'),h;
  Date.now=()=>now;
  try{
    h=fixture();Object.assign(h.card.d,{marketState:'REGULAR',priceSession:'REGULAR',quoteAt:now});
    Object.assign(h.card.d.regularChart,{
      bars:h.card.d.regularChart.bars.map((bar,i)=>({...bar,t:now/1000-(29-i)*60})),
      regularSessions:[{open_at_ms:Date.parse('2026-09-25T13:30:00Z'),close_at_ms:Date.parse('2026-09-25T20:00:00Z')}]});
    await h.flush();const before=h.panel.detailCounts.compute,end=plot(h).visibleSessions.at(-1).close,writes=countWrites(h);
    now+=60000;await update(h);
    assert.equal(h.panel.detailCounts.compute,before+1);assert.equal(plot(h).visibleSessions.at(-1).close,end+60000);
    assert.equal(writes(),0);
  }finally{h?.view.close();Date.now=realNow;}
});
