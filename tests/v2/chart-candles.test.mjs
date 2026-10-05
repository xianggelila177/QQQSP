import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function setup(){
  const sandbox={window:{},Date};
  for(const name of ['panel-timeframes','panel-chart-engine'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),sandbox);
  const api=sandbox.window.PANEL_CHART_ENGINE;
  const engine=api.createChartEngine({UP:'red',DOWN:'green',fmtDate:()=> '2026-10-01 09:30',formatterFor:()=>({money:String}),maSeries:()=>[]});
  return {api,engine};
}
const open=Date.parse('2026-10-01T13:30:00Z'),close=open+390*60000;
const bars=[{t:open/1000,o:100,h:105,l:97,c:103,v:50},{t:open/1000+300,o:103,h:104,l:101,c:103,v:60}];
function model(rows=bars){return {tf:'intraday',_chartWidth:500,followEnd:true,_displayIntraday:rows,d:{regularChart:{bars:rows,pointKind:'bar-start',intervalSeconds:300,regularSessions:[{open_at_ms:open,close_at_ms:close}]}}};}

test('candles draw exact source highs/lows and a horizontal doji without inventing a wick',()=>{
  const {engine}=setup(),q=model(),p=engine.computePlot(q),paths=[],rects=[];let path=[];
  p.ctx=new Proxy({beginPath(){path=[];},moveTo(x,y){path.push([x,y]);},lineTo(x,y){path.push([x,y]);},
    stroke(){paths.push({points:path.slice(),color:this.strokeStyle,width:this.lineWidth});},
    fillRect(x,y,w,h){rects.push({x,y,w,h,color:this.fillStyle});},measureText:s=>({width:s.length*6})},
    {get:(obj,key)=>key in obj?obj[key]:()=>{}});
  engine.drawPlot(q,p);
  assert.equal(p.candle,true);assert.equal(p.timeline,true);assert.equal(p.intervalSeconds,300);
  for(let i=0;i<bars.length;i++)assert.ok(paths.some(v=>v.color==='red'&&v.points.length===2&&
    v.points[0][0]===p.x(i)&&v.points[0][1]===p.y(bars[i].h)&&v.points[1][0]===p.x(i)&&v.points[1][1]===p.y(bars[i].l)),'source high/low reaches canvas unchanged');
  assert.ok(paths.some(v=>v.color==='red'&&v.points.length===2&&v.points[0][1]===p.y(103)&&v.points[1][1]===p.y(103)&&v.points[0][0]<p.x(1)&&v.points[1][0]>p.x(1)),'equal open/close draws a horizontal doji');
  assert.ok(rects.some(v=>v.color==='red'&&v.y===p.y(103)&&Math.abs(v.h-(p.y(100)-p.y(103)))<1e-10),'body preserves open and close');
  assert.ok(p.x(0)>p.L&&p.x(1)<p.W-p.R,'interval centers keep first and last bodies inside the plot');
});

test('price points and samples cannot become fabricated candles even with flat OHLC fields',()=>{
  const {engine}=setup();
  for(const kind of ['price-point','sample','missing']){
    const q=model();if(kind==='price-point')q.d.regularChart.pointKind='price-point';
    if(kind==='sample')q._sampled=true;
    if(kind==='missing')q._displayIntraday=[{t:open/1000,c:103}];
    const p=engine.computePlot(q);assert.equal(p.candle,false,kind);assert.equal(p.candleAvailable,false,kind);assert.ok(p.candleUnavailableReason);
  }
});

test('narrow cards retain the complete session by default and explicit zoom makes candle details readable',()=>{
  const {engine}=setup(),rows=Array.from({length:78},(_,i)=>({...bars[0],t:open/1000+i*300}));
  const q=model(rows);q._chartWidth=320;
  let p=engine.computePlot(q);assert.equal(p.n,78);assert.ok(p.chartH>=180);
  q.visN.intraday=20;p=engine.computePlot(q);assert.equal(p.n,20);assert.ok(p.slot>=7);
  q.visN.intraday=78;q.fullSession=true;p=engine.computePlot(q);assert.equal(p.n,78);assert.equal(p.visibleSessions[0].open,open);assert.equal(p.visibleSessions.at(-1).close,close);
  q.chartStyle='line';delete q.visN.intraday;p=engine.computePlot(q);assert.equal(p.n,78);assert.equal(p.candle,false);
});

test('a live quote remains a separate point and cannot erase real candle wicks',()=>{
  const {engine}=setup(),q=model();Object.assign(q.d,{marketState:'REGULAR',priceSession:'REGULAR',price:104,quoteAt:open+400000,currency:'USD',src:'naver-world-chart',gmtoff:-14400,intradayLiveStatus:'ready',
    intradayLivePoint:{t:(open+400000)/1000,c:104,v:null,currency:'USD',source:'naver-world-chart',sessionDate:'2026-10-01',historyDate:'2026-10-01'}});
  Object.assign(q.d.regularChart,{source:'naver-world-chart',tradeDate:'2026-10-01'});
  const p=engine.computePlot(q);assert.equal(p.candle,true);assert.equal(p.all.length,3);assert.equal(p.all.at(-1)._live,true);assert.ok(Number.isFinite(p.top)&&Number.isFinite(p.bot));
});

test('an opening gap does not flatten candle autoscale or put yesterday close in the volume area',()=>{
  const {engine}=setup(),q=model();q.d.regularChart.previousCloseReference={value:60};
  const p=engine.computePlot(q),colors=[];
  assert.ok(p.bot>95);assert.ok(p.top<107);assert.equal(p.reference.value,60,'percentage basis is retained');
  p.ctx=new Proxy({stroke(){colors.push(this.strokeStyle);},measureText:s=>({width:s.length*6})},{get:(obj,key)=>key in obj?obj[key]:()=>{}});
  engine.drawPlot(q,p);assert.ok(!colors.includes('rgba(96,105,115,.6)'),'reference outside price range is not drawn');
  q.chartStyle='line';assert.ok(engine.computePlot(q).bot<60,'line view retains its previous-close baseline');
});
