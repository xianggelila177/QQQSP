import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {bars,modules,simple,context} from './chart-viewport-fixture.mjs';

function api(window={}){
  vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-drawings.js',import.meta.url),'utf8'),{window});
  return window.PANEL_CHART_DRAWINGS;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const horizontal=(t=1700000000,price=100)=>({type:'horizontal',points:[{t,price}]});
const memoryStorage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),data};};
function recorder(){const ctx=context();ctx.texts=[];ctx.rects=[];ctx.fillText=function(...args){this.texts.push({args,clipped:this.clipped});};ctx.rect=function(...args){this.rects.push(args);};return ctx;}

test('drawing store bounds persistence, separates identities and does not leak mutable references',()=>{
  const A=api(),storage=memoryStorage(),store=A.createDrawingStore({storage,keyPrefix:'test'});
  const key=JSON.stringify(['NVDA','daily30','USD','source-a']);
  const source=horizontal();source.points[0].x=50;
  const result=store.add(key,source);source.points[0].price=1;result[0].points[0].price=2;
  assert.deepEqual(plain(store.get(key)),[horizontal()]);
  assert.deepEqual(plain(store.get(JSON.stringify(['NVDA','daily30','TWD','source-a']))),[]);
  for(let i=1;i<60;i++)store.add(key,horizontal(1700000000+i,i));
  assert.equal(store.get(key).length,50);assert.equal(store.get(key)[0].points[0].price,10);
  assert.equal(A.createDrawingStore({storage,keyPrefix:'test'}).get(key).length,50);
  store.undo(key);assert.equal(store.get(key).length,49);store.clear(key);assert.equal(store.get(key).length,0);
  for(let i=0;i<30;i++)store.add('key-'+i,horizontal());
  store.get('key-0');store.add('key-30',horizontal());
  assert.equal(store.get('key-1').length,0);assert.equal(store.get('key-0').length,1);
  assert.equal(JSON.parse(storage.data.get('test:v1')).entries.length,30);
});

test('malformed stored data and blocked storage recover without accepting screen coordinates or invalid points',()=>{
  const A=api(),storage=memoryStorage();storage.setItem('bad:v1','{broken');
  const store=A.createDrawingStore({storage,keyPrefix:'bad'});
  for(const d of [{type:'trend',points:[{x:5,y:3},{x:9,y:6}]},horizontal(1700000000,NaN),{type:'script',points:[]}])store.add('a',d);
  assert.equal(store.get('a').length,0);store.add('a',horizontal());assert.equal(JSON.parse(storage.data.get('bad:v1')).entries.length,1);
  storage.setItem('mixed:v1',JSON.stringify({version:1,entries:[['__proto__',[horizontal(),{type:'trend',points:[]}]],['b','bad'],[{},[horizontal()]]]}));
  assert.equal(A.createDrawingStore({storage,keyPrefix:'mixed'}).get('__proto__').length,1);
  const unavailable=A.createDrawingStore({storage:{getItem(){throw Error('denied');},setItem(){throw Error('quota');}}});
  unavailable.add('a',horizontal());assert.equal(unavailable.get('a').length,1);
});

test('point capture uses actual bars and inverse price scale, rejects volume area and quote-only live tail',()=>{
  const A=api(),m=modules(),history=bars(20),q=simple(m,history,'daily30',600,{chartSettings:{scale:'log'}}),p=m.engine.computePlot(q);
  const point=A.pointFromPlot(p,p.x(4)+p.slot*.1,p.y(101));
  assert.equal(point.t,history[4].t);assert.ok(Math.abs(point.price-101)<1e-10);
  assert.equal(A.pointFromPlot(p,p.x(4),p.yTop+p.chartH+1),null);
  const withLive={...p,bars:[history[0],{...history[1],_live:true}],x:i=>50+i*100};
  assert.equal(A.pointFromPlot(withLive,150,p.y(101)).t,history[0].t);
  assert.equal(A.pointFromPlot({...withLive,bars:[{...history[0],_live:true}]},50,p.y(101)),null);
});

test('time and price anchors survive pan, zoom and prepended history without offscreen edge clamping',()=>{
  const A=api(),m=modules(),history=bars(100),q=simple(m,history,'daily30',600,{visN:{daily30:20},followEnd:false,winStart:20});
  const d={type:'trend',points:[{t:history[10].t,price:history[25].c},{t:history[50].t,price:history[30].c}]};
  let p=m.engine.computePlot(q),cx=recorder();A.draw(cx,p,[d]);
  const path=cx.strokes[0].path;assert.ok(path[0][1]<p.L);assert.ok(path[1][1]>p.W-p.R);
  assert.ok(cx.strokes.every(s=>s.clipped));assert.deepEqual(cx.rects[0],[p.L,p.yTop,p.W-p.L-p.R,p.chartH]);
  q.winStart=5;q.visN.daily30=60;p=m.engine.computePlot(q);
  assert.equal(A.projectPoint(p,d.points[0]).x,p.x(5));assert.equal(A.projectPoint(p,d.points[1]).x,p.x(45));
  const old=bars(10,86400,history[0].t-10*86400),prepended=old.concat(history);
  q.historyStore={getSeries:()=>prepended,getRevision:()=>2};q.winStart=15;
  p=m.engine.computePlot(q);assert.equal(A.projectPoint(p,d.points[0]).x,p.x(5));
  assert.equal(A.projectPoint(p,{t:history[10].t+1,price:100}),null);
});

test('fully offscreen drawings have no ghost handles or labels, horizontal line remains intentionally infinite',()=>{
  const A=api(),m=modules(),history=bars(100),q=simple(m,history,'daily30',600,{visN:{daily30:20},followEnd:false,winStart:50}),p=m.engine.computePlot(q),ctx=recorder();
  A.draw(ctx,p,[{type:'measure',points:[{t:history[0].t,price:105},{t:history[10].t,price:106}]}]);
  assert.equal(ctx.strokes.length,0);assert.equal(ctx.texts.length,0);
  A.draw(ctx,p,[horizontal(history[0].t,106)]);assert.equal(ctx.strokes.length,1);assert.equal(ctx.texts.length,1);
});

test('regular-session timeline projects offscreen anchors without clamping across a weekend',()=>{
  const A=api(),m=modules(),friday=Date.parse('2026-10-02T13:30Z'),monday=Date.parse('2026-10-05T13:30Z');
  const all=bars(6,300,friday/1000).concat(bars(6,300,monday/1000));
  const q=simple(m,all,'intraday',600,{visN:{intraday:6},followEnd:false,winStart:6});
  q.d.regularChart={bars:all,intervalSeconds:300,regularSessions:[friday,monday].map(open_at_ms=>({open_at_ms,close_at_ms:open_at_ms+1800000}))};
  const p=m.engine.computePlot(q),d={type:'trend',points:[{t:all[3].t,price:100.2},{t:all[9].t,price:100.4}]};
  assert.equal(p.timeline,true);assert.ok(A.projectPoint(p,d.points[0]).x<p.L);
  assert.equal(A.projectPoint(p,d.points[1]).x,p.x(3));
  const ctx=recorder();A.draw(ctx,p,[d]);assert.ok(ctx.strokes[0].path[0][1]<p.L);assert.ok(ctx.strokes[0].clipped);
  assert.equal(A.measurement(p,{...d,type:'measure'}).observations,7);
});

test('measurement counts loaded observations across missing dates and reports elapsed calendar time, not invented sessions',()=>{
  const A=api(),m=modules(),all=bars(5).filter((_,i)=>i!==1&&i!==2),p=m.engine.computePlot(simple(m,all));
  const d={type:'measure',points:[{t:all[0].t,price:100},{t:all[2].t,price:110}]};
  const value=A.measurement(p,d);assert.equal(value.observations,3);assert.equal(value.seconds,4*86400);assert.equal(value.percent,10);
  const label=A.measurementLabel(value,n=>n.toFixed(2));assert.match(label,/3 根已加载K线/);assert.match(label,/4天/);assert.doesNotMatch(label,/交易日/);
  const ctx=recorder();A.draw(ctx,p,[d],{formatter:n=>n.toFixed(2)});assert.equal(ctx.texts.length,1);assert.equal(ctx.texts[0].clipped,true);
  const live={...all[2],t:all[2].t-1,_live:true};assert.equal(A.measurement({...p,all:[all[0],all[1],live,all[2]]},d).observations,3);
  assert.equal(A.measurement(p,{...d,points:[{...d.points[0],price:0},d.points[1]]}).percent,null);
});

test('partial draft and stored drawings never write to the source plot or clear the main canvas',()=>{
  const A=api(),m=modules(),history=bars(8),p=m.engine.computePlot(simple(m,history)),ctx=recorder();
  ctx.clearRect=()=>assert.fail('draw must not clear caller canvas');
  const before=JSON.stringify(history),draft={type:'trend',points:[{t:history[2].t,price:100.2}]};
  A.draw(ctx,p,[],{draft});assert.equal(JSON.stringify(history),before);
  assert.equal(A.normalizeDrawing(draft),null);assert.equal(A.normalizeDrawing(draft,{partial:true}).points.length,1);
});
