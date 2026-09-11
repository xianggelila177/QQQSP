import assert from 'node:assert/strict';
import {loadApp} from './_harness.mjs';
const env=await loadApp({watchlist:['QQQ']});await env.drain();
const api=env.win, fmt=api.PANEL_FORMAT;
const engine=api.PANEL_CHART_ENGINE.createChartEngine({UP:'#d63749',DOWN:'#12805c',fmtDate:fmt.fmtDate,formatterFor:()=>({money:v=>'≈¥'+Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}),maSeries:api.PANEL_UTILS.maSeries});
const q=env.hooks().cardCache.get('QQQ'), cx=q.cv.getContext();
cx.measureText=text=>({width:[...text].length*7});
let labels=[],clips=0;cx.fillText=function(text,x,y,maxWidth){labels.push({text,x,y,align:this.textAlign,width:Math.min(this.measureText(text).width,maxWidth||Infinity)});};cx.clip=()=>clips++;
for(const width of [248,303,318]){
  const bars=Array.from({length:60},(_,i)=>({t:Date.parse('2026-09-04T15:40:00Z')/1000+i*60,o:48000+i,h:48002+i,l:47998+i,c:48001+i,v:i}));
  const card={tf:'intraday',d:{charts:{intraday:bars}},cv:q.cv,_chartWidth:width};
  const p=engine.computePlot(card);p.ctx=cx;labels=[];engine.drawPlot(card,p);
  const axis=labels.filter(x=>x.x>p.W-p.R&&x.y<p.yTop+p.chartH+2);
  for(const label of axis){const right=label.x+(label.align==='center'?label.width/2:label.width);assert.ok(right<=width-1,'all axis decimals and tags fit canvas');}
  assert.ok(p.W-p.R-p.L>=100,'minimum useful plot width');
  const time=labels.filter(x=>x.y===p.H-7).map(x=>x.text);
  assert.ok(time.every(x=>/\d{2}:\d{2}/.test(x)),'OHLC intraday axis includes minutes');
  assert.ok(time.some(x=>/09-05/.test(x)),'UTC+8 date rollover visible');
}
const gap=Array.from({length:35},(_,i)=>({t:1780000000+i*86400,o:i<20?200:100,h:i<20?201:101,l:i<20?199:99,c:i<20?200:100,v:10}));
for(const winStart of [0,10,20]){
  const card={tf:'daily30',d:{charts:{daily30:gap}},cv:q.cv,_chartWidth:248,visN:{daily30:15},winStart,followEnd:false};
  const p=engine.computePlot(card);p.ctx=cx;
  for(const values of Object.values(p.ma))for(const value of values.slice(p.a,p.a+p.n).filter(x=>x!=null))assert.ok(p.y(value)>=p.yTop&&p.y(value)<=p.yTop+p.chartH,'visible MAs remain inside price scale after pan/zoom');
  engine.drawPlot(card,p);
}
assert.ok(clips>=3,'price geometry is clipped separately from time/volume');
const disabled=engine.computePlot({tf:'daily30',d:{charts:{daily30:gap}},cv:q.cv,_chartWidth:248,visN:{daily30:15},winStart:20,followEnd:false,maEnabled:{5:false,10:false,20:false}});assert.ok(disabled.top<110,'disabled indicators do not force excess axis range');
const line=engine.computePlot({tf:'intraday',d:{charts:{intraday:[{t:1780000000,c:100},{t:1780000060,c:101}]}},cv:q.cv,_chartWidth:248});line.ctx=cx;labels=[];engine.drawPlot({},line);assert.equal(line.candle,false);assert.ok(labels.filter(x=>x.y===line.H-7).every(x=>/\d{2}:\d{2}/.test(x.text)),'plain line intraday keeps minute labels');
const bars=[{t:Date.parse('2026-09-04T15:59:00Z')/1000,o:100,h:102,l:99,c:101,v:10}];
env.fetch.push('market',{body:[{symbol:'QQQ',currency:'USD',price:101,marketState:'CLOSED',charts:{intraday:bars,daily30:bars}}]});await env.hooks().refresh(false);
assert.match(q.ohlc.innerHTML,/2026-09-04 23:59/,'visible OHLC detail retains minutes');
q.tf='daily30';env.hooks().render(q);assert.match(q.ohlc.innerHTML,/<b>2026-09-04<\/b>/,'daily detail uses trading date');
const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb.reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);};
const theme=api.PANEL_CHART_ENGINE.CHART_THEME;
for(const color of [theme.axisText,...Object.values(theme.ma).map(x=>x.text)])assert.ok(1.05/(luminance(color)+.05)>=4.5,'small chart text has 4.5:1 white contrast: '+color);
console.log('PASS v62 chart time grain, measured mobile axes, gap MA bounds/clipping, accessible chart text');
