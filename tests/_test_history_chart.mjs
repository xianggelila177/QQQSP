import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window={};const sandbox={window,Date,Math,Number,Object,Map,WeakMap};
for(const file of ['panel-timeframes.js','panel-chart-engine.js'])vm.runInNewContext(fs.readFileSync(new URL('../public/modules/'+file,import.meta.url),'utf8'),sandbox);
const texts=[],rects=[],ctx=new Proxy({measureText:s=>({width:String(s).length*7}),fillText:(...a)=>texts.push(a),fillRect:(...a)=>rects.push(a)},{get:(o,k)=>k in o?o[k]:(()=>{})});
const engine=window.PANEL_CHART_ENGINE.createChartEngine({UP:'red',DOWN:'green',fmtDate:t=>new Date(t*1000).toISOString().slice(0,10),formatterFor:()=>({money:x=>String(x)}),maSeries:(bars,n)=>bars.map((b,i)=>i<n-1?null:bars.slice(i-n+1,i+1).reduce((s,x)=>s+x.c,0)/n)});
let bars=Array.from({length:39},(_,i)=>({periodStart:(1988+i)+'-01-01',t:Date.parse((1988+i)+'-01-01')/1000,o:10,h:12,l:9,c:11,v:null}));
const q={d:{charts:{}},tf:'yearly',historyStore:{getSeries:()=>bars,getRevision:()=> 'revision'},visN:{},followEnd:true,cv:{getBoundingClientRect:()=>({width:600}),getContext:()=>ctx}};
let p=engine.computePlot(q);assert.equal(p.n,20);assert.equal(p.a,19);assert.equal(p.ma[20][19],11);
p.ctx=ctx;engine.drawPlot(q,p,null);
assert.ok(texts.filter(t=>t[2]===p.H-7).every(t=>/^\d{4}$/.test(t[0])),'Annual axis must show distinct years, never identical 01-01 labels');
q.tf='monthly';texts.length=0;engine.drawPlot(q,p,null);assert.ok(texts.filter(t=>t[2]===p.H-7).every(t=>/^\d{4}-\d{2}$/.test(t[0])));q.tf='yearly';
assert.equal(rects.filter(r=>r[1]>=p.yTop+p.chartH+8).length,0,'Unknown volume must not create tiny fake volume rectangles');
const allBars=bars;for(const count of [1,2,3]){bars=allBars.slice(-count);q.visN={};p=engine.computePlot(q);assert.equal(p.n,bars.length);assert.equal(p.a,0);}
console.log('History chart year default 20, MA warmup, short histories and absent volume rectangles passed');
