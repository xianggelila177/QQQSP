import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window={};vm.runInNewContext(fs.readFileSync(new URL('../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),{window});
const {livePointFor,createChartEngine}=window.PANEL_CHART_ENGINE;
assert.equal(typeof livePointFor,'function','Live point must be validated independently from history');
const t=Math.floor(Date.now()/1000)-60,date=new Date(t*1000).toISOString().slice(0,10);
const history=Object.freeze(Array.from({length:100},(_,i)=>Object.freeze({t:t-100+i,c:100+i/100,v:10})));
const data={price:102,quoteAt:t*1000,currency:'GBp',src:'naver-us',marketState:'REGULAR',charts:{intraday:history,daily30:history},intradayLiveStatus:'ready',
 intradayLivePoint:{t,c:102,v:null,currency:'GBp',source:'naver-us',sessionDate:date,historyDate:date}};
assert.equal(livePointFor(data)?.c,102);
for(const mutate of [d=>d.stale=true,d=>d.recovery=true,d=>d.marketState='CLOSED',d=>d.intradayLivePoint.currency='GBP',d=>d.intradayLivePoint.v=1,d=>d.intradayLivePoint.c=NaN,d=>d.intradayLivePoint.c=101,d=>d.intradayLivePoint.t=t-1000,d=>d.intradayLivePoint.historyDate='2000-01-01',d=>d.intradayLivePoint.source='other',d=>d.intradayLiveStatus='waiting-history',d=>{d.intradayLivePoint.t=t+1000;d.quoteAt=(t+1000)*1000;},d=>{d.intradayLivePoint.sessionDate='2026-02-31';d.intradayLivePoint.historyDate='2026-02-31';}]){
 const bad=structuredClone(data);mutate(bad);assert.equal(livePointFor(bad),null);
}
const engine=createChartEngine({UP:'red',DOWN:'green',fmtDate:String,formatterFor:()=>({money:String}),maSeries:()=>[]});
const q={d:data,tf:'intraday',followEnd:true,visN:{},_chartWidth:1000};
const first=engine.computePlot(q);assert.equal(first.all.length,101);assert.equal(first.bars.at(-1).c,102);assert.equal(first.bars.at(-1).v,null);assert.equal(first.bars.at(-1)._live,true);
q.d={...data,price:103,intradayLivePoint:{...data.intradayLivePoint,c:103}};
const second=engine.computePlot(q);assert.equal(second.all.length,101);assert.equal(second.bars.at(-1).c,103);assert.equal(history.length,100);assert.equal(history.at(-1).c,100.99);
q.followEnd=false;q.winStart=0;const historical=engine.computePlot(q);assert.equal(historical.a,0);assert.ok(historical.bars.every(x=>!x._live));
q.tf='daily30';const daily=engine.computePlot(q);assert.equal(daily.all.length,100);assert.ok(daily.all.every(x=>!x._live));
console.log('PASS live point validation, at most one display-only point, immutable history, historical viewport, daily isolation');
