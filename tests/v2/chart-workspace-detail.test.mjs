import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {detailHarness} from './detail-ux-fixture.mjs';

// Keep the existing dialog/network fixture, while loading the real renderer,
// settings and drawing modules through the same public detail entry point.
const directory=mkdtempSync(join(tmpdir(),'qqqsp-detail-workspace-'));
const root=new URL('../../public/modules/',import.meta.url);
const modules=['panel-scheduler','panel-timeframes','panel-state','panel-format','panel-trade-direction',
  'panel-chart-viewport','panel-market-detail-model','panel-market-detail-view','panel-detail-dialog',
  'panel-chart','panel-chart-studies','panel-chart-engine','panel-chart-workspace','panel-chart-drawings'];
const probe=`
  window.localStorage=(()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};})();
  {const original=window.PANEL_CHART_ENGINE;window.PANEL_CHART_ENGINE={...original,createChartEngine:options=>{
    const engine=original.createChartEngine(options);return {...engine,computePlot:view=>{window.workspaceView=view;return engine.computePlot(view);}};}};}
  {const original=window.PANEL_CHART_DRAWINGS;window.drawingAdds=[];window.PANEL_CHART_DRAWINGS={...original,createDrawingStore:options=>{
    const store=original.createDrawingStore(options);window.drawingStore=store;return {...store,add:(key,value)=>{window.drawingAdds.push({key,value});return store.add(key,value);}};}};}
`;
writeFileSync(join(directory,'panel-chart-detail.js'),modules.map(name=>readFileSync(new URL(name+'.js',root),'utf8')).join('\n')+probe+readFileSync(new URL('panel-chart-detail.js',root),'utf8'));
after(()=>rmSync(directory,{recursive:true,force:true}));
const fixture=()=>detailHarness({moduleRoot:pathToFileURL(directory+'/')});
const plot=h=>h.panel.workspaceView.plot;
const reopen=async h=>{h.view.close();h.card.el.querySelector('.chart-expand').click();await h.flush();};
const point=(h,index=4)=>({pointerType:'mouse',button:0,pointerId:1,clientX:plot(h).x(index),clientY:plot(h).y(plot(h).bars[index].c)});
const fivePayload=()=>{const open=Date.parse('2026-09-25T13:30:00Z');return {status:'ready',source:'fixture-chart',currency:'USD',pointKind:'bar-start',resolution:'1m',adjustment:'raw',
  regularSessions:[{open_at_ms:open,close_at_ms:open+300000}],coveredDays:5,
  bars:Array.from({length:5},(_,i)=>({t:open/1000+i*60,o:100,h:101,l:99,c:100,v:10}))};};
const respondFive=async(h,five=fivePayload())=>h.respond(h.pending.findLastIndex(job=>job.url.includes('sections=chart')),{fiveDay:five});

test('detail opens in portrait without taking fullscreen, with explicit rotate/fullscreen and collapsible market data',async()=>{
  const h=fixture();await h.flush();h.view.close();h.panel.innerWidth=390;h.panel.innerHeight=844;
  let fullscreenRequests=0;h.dialog.requestFullscreen=async()=>{fullscreenRequests++;h.document.fullscreenElement=h.dialog;};
  h.card.el.querySelector('.chart-expand').click();await h.flush();
  assert.equal(fullscreenRequests,0);assert.equal(h.dialog.classList.contains('is-rotated'),false);
  h.field('[data-action="rotate"]').click();await h.flush();assert.equal(h.dialog.classList.contains('is-rotated'),true);
  h.field('[data-action="rotate"]').click();await h.flush();assert.equal(h.dialog.classList.contains('is-rotated'),false);
  h.field('[data-action="fullscreen"]').click();await h.flush();assert.equal(fullscreenRequests,1);
  const book=h.field('.cd-book-status').textContent;
  h.field('[data-action="side"]').click();await h.flush();assert.equal(h.field('.cd-side').hidden,true);assert.equal(h.field('[data-action="side"]').getAttribute('aria-expanded'),'false');
  h.field('[data-action="side"]').click();await h.flush();assert.equal(h.field('.cd-side').hidden,false);assert.equal(h.field('.cd-book-status').textContent,book);
  h.view.close();
});

test('detail settings reach real plot, persist after reopen, and detach listeners on close',async()=>{
  const h=fixture();await h.select('daily30');
  h.field('.cd-settings').dispatch('change',{target:{dataset:{chartSetting:'scale'},value:'percent'}});
  h.field('.cd-settings').dispatch('change',{target:{dataset:{chartSetting:'volume'},checked:false}});
  h.field('.cd-settings').dispatch('change',{target:{dataset:{chartStudy:'rsi14'},checked:true}});await h.flush();
  assert.equal(plot(h).scale,'percent');assert.equal(plot(h).hVol,0);assert.ok(plot(h).rsiPane);
  assert.match(h.field('.chart-scale-note').textContent,/0% = \$100.*可见首根收盘/);
  assert.match(h.field('.cd-studies').textContent,/RSI14/);assert.match(h.field('.cd-point').textContent,/开 .* 高 .* 低 .* 收 /);
  h.view.close();assert.equal(h.field('.cd-settings').listeners.change.length,0);
  h.panel.PANEL_CHART_WORKSPACE.saveSettings({...h.panel.PANEL_CHART_WORKSPACE.loadSettings(),scale:'log'});
  h.card.el.querySelector('.chart-expand').click();await h.flush();assert.equal(plot(h).scale,'log');assert.equal(plot(h).hVol,0);
  assert.equal(h.field('.cd-settings').listeners.change.length,1);
  await reopen(h);assert.equal(h.field('.cd-settings').listeners.change.length,1);h.view.close();
});

test('visible-count controls keep period and data scope, and readout follows keyboard selection',async()=>{
  const h=fixture();await h.select('daily30');const loads=h.loads.length;
  h.field('[data-range="30"]').click();await h.flush();assert.equal(plot(h).n,30);assert.equal(h.panel.workspaceView.tf,'daily30');
  h.field('[data-range="90"]').click();await h.flush();assert.equal(plot(h).n,60);assert.equal(h.loads.length,loads);
  assert.equal(h.field('.cd-range-state').textContent,'可见 60 / 已加载 60 根');
  h.field('.cd-canvas').dispatch('keydown',{key:'Home'});assert.match(h.field('.cd-point').textContent,/2026-01-01/);
  h.field('.cd-canvas').dispatch('keydown',{key:'End'});assert.match(h.field('.cd-point').textContent,/2026-03-01/);
  h.field('[data-range="30"]').click();await h.flush();assert.match(h.field('.cd-point').textContent,/2026-03-01/);
  h.field('[data-range="all"]').click();await h.flush();assert.equal(h.panel.workspaceView.fullSession,true);assert.equal(h.loads.length,loads);
  h.view.close();
});

test('detail drawing tools use real price/time anchors, cancel drafts on period change, and isolate currencies',async()=>{
  const h=fixture();await h.select('daily30');
  h.field('[data-draw="horizontal"]').click();h.field('.cd-canvas').dispatch('pointerdown',point(h));
  assert.equal(h.panel.drawingAdds.length,1);const first=h.panel.drawingAdds[0];
  assert.equal(first.value.type,'horizontal');assert.equal(first.value.points[0].t,plot(h).bars[4].t);assert.ok(Math.abs(first.value.points[0].price-100)<1e-9);
  h.field('[data-draw="trend"]').click();h.field('.cd-canvas').dispatch('pointerdown',point(h));
  await h.select('weekly');h.field('.cd-canvas').dispatch('pointerdown',point(h));assert.equal(h.panel.drawingAdds.length,1);
  h.field('.cd-canvas').dispatch('pointerdown',point(h,8));assert.equal(h.panel.drawingAdds.length,2);assert.notEqual(h.panel.drawingAdds[1].key,first.key);
  h.field('[data-draw="undo"]').click();assert.equal(h.panel.drawingStore.get(h.panel.drawingAdds[1].key).length,0);
  await h.select('monthly');h.field('[data-draw="clear"]').click();assert.equal(h.panel.drawingStore.get(first.key).length,1);
  await h.select('weekly');
  h.field('.cd-canvas').dispatch('keydown',{key:'Escape'});assert.equal(h.dialog.open,true);
  h.view.close();h.card.d.currency='TWD';h.card.el.querySelector('.chart-expand').click();await h.flush();
  h.field('[data-draw="horizontal"]').click();h.field('.cd-canvas').dispatch('pointerdown',point(h));
  assert.equal(h.panel.drawingAdds.length,3);assert.match(h.panel.drawingAdds[2].key,/TWD/);assert.notEqual(h.panel.drawingAdds[2].key,first.key);
  h.view.close();
});

test('five-day candles use their own minute interval instead of the current regular chart interval',async()=>{
  const h=fixture();h.card.d.regularChart.intervalSeconds=300;await h.select('fiveDay');await respondFive(h);
  assert.equal(plot(h).intervalSeconds,60);h.view.close();
});

test('five-day history without a declared interval stays a close line and exposes unknown granularity',async()=>{
  const h=fixture(),canvas=h.field('.cd-canvas'),getContext=canvas.getContext.bind(canvas);
  canvas.getContext=(...args)=>new Proxy(getContext(...args),{get:(target,key)=>key==='createLinearGradient'?()=>({addColorStop(){}}):target[key]});
  h.card.d.regularChart.intervalSeconds=300;await h.select('fiveDay');
  await respondFive(h,{...fivePayload(),resolution:null,intervalSeconds:null});
  assert.equal(h.panel.workspaceView._intervalUnknown,true);assert.equal(plot(h).candle,false);assert.equal(plot(h).intervalSeconds,null);
  assert.match(h.field('.cd-chart-info').textContent,/收盘线.*粒度待核验/);assert.doesNotMatch(h.field('.cd-chart-info').textContent,/5分钟/);
  assert.equal(h.field('[data-chart-style="line"]').textContent,'收盘线');
  await h.select('intraday');assert.equal(h.panel.workspaceView._intervalUnknown,false);h.view.close();
});

test('five-day adjustment changes separate persisted drawing identities',async()=>{
  const h=fixture();await h.select('fiveDay');await respondFive(h);
  h.field('[data-draw="horizontal"]').click();h.field('.cd-canvas').dispatch('pointerdown',point(h,2));
  const first=h.panel.drawingAdds[0].key;
  await h.select('intraday');await h.select('fiveDay');await respondFive(h,{...fivePayload(),adjustment:'split-adjusted'});
  h.field('.cd-canvas').dispatch('pointerdown',point(h,2));assert.notEqual(h.panel.drawingAdds[1].key,first);h.view.close();
});

test('changing the active quote currency clears old five-day bars until matching history arrives',async()=>{
  const h=fixture();await h.select('fiveDay');await respondFive(h);
  h.field('[data-draw="trend"]').click();h.field('.cd-canvas').dispatch('pointerdown',point(h,2));
  const previousRequests=h.pending.filter(job=>job.url.includes('sections=chart')).length;
  h.card.d.currency='TWD';h.view.update(h.card);await h.flush();assert.equal(plot(h),null);
  assert.equal(h.pending.filter(job=>job.url.includes('sections=chart')).length,previousRequests+1);
  await respondFive(h,{...fivePayload(),currency:'TWD'});assert.equal(h.panel.workspaceView.d.currency,'TWD');
  h.field('.cd-canvas').dispatch('pointerdown',point(h,2));assert.equal(h.panel.drawingAdds.length,0);
  h.view.close();
});
