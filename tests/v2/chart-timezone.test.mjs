// Model the reported 22:16 card / 18:16 chart defect. Fixtures reproduce the
// Nasdaq x-coordinate + Eastern wall-time label format, not captured live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {parseNasdaqIntraday,parseNasdaqHistory} from '../../lib/providers/public-history.js';
import {createChartEnricher} from '../../lib/chart-enricher.js';
const root=new URL('../../',import.meta.url);
const summerNow=Date.parse('2026-09-11T14:16:12Z');
const fixture=(label,x='2026-09-11T10:16:00Z')=>({data:{symbol:'LITE',chart:[{x:Date.parse(x),y:928.34,z:{dateTime:label,value:'928.34'}}]}});
const format=(seconds)=>new Date(seconds*1000+8*3600000).toISOString().slice(0,16).replace('T',' ');

test('REGRESSION screenshot: 10:16 ET is 22:16 UTC+8, never 18:16',()=>{
 const chart=parseNasdaqIntraday(fixture('Sep 11, 2026 10:16 AM'),'LITE',{now:summerNow});
 assert.equal(format(chart.timestamp[0]),'2026-09-11 22:16');
 assert.equal(summerNow-chart.timestamp[0]*1000,12000,'history only 12s old, not 14412s');
});
test('REGRESSION winter: Eastern standard time must use five hours, not fixed four',()=>{
 const chart=parseNasdaqIntraday(fixture('Jan 09, 2026 10:16 AM','2026-01-09T10:16:00Z'),'LITE',{now:Date.parse('2026-01-09T15:17:00Z')});
 assert.equal(format(chart.timestamp[0]),'2026-01-09 23:16');
});
test('REGRESSION time-only label with synthetic x preserves the historical date, not today',()=>{
 const chart=parseNasdaqIntraday(fixture('10:16 AM'),'LITE',{now:Date.parse('2026-09-14T15:00:00Z')});
 assert.equal(format(chart.timestamp[0]),'2026-09-11 22:16');
});
test('CONTROL genuine UTC x with agreeing Eastern label is not shifted twice',()=>{
 const chart=parseNasdaqIntraday(fixture('Sep 11, 2026 10:16 AM','2026-09-11T14:16:00Z'),'LITE',{now:summerNow});
 assert.equal(chart.timestamp[0],Date.parse('2026-09-11T14:16:00Z')/1000);
});
test('CONTROL time-only label on a genuine UTC timestamp handles after-hours midnight UTC',()=>{
 const chart=parseNasdaqIntraday(fixture('8:00 PM','2026-09-12T00:00:00Z'),'LITE',{now:Date.parse('2026-09-12T00:01:00Z')});
 assert.equal(format(chart.timestamp[0]),'2026-09-12 08:00');
});
test('REGRESSION premarket across Chinese midnight stays on the correct exchange session date',()=>{
 const chart=parseNasdaqIntraday(fixture('Sep 11, 2026 4:15 PM','2026-09-11T16:15:00Z'),'LITE',{now:Date.parse('2026-09-11T20:16:00Z')});
 assert.equal(format(chart.timestamp[0]),'2026-09-12 04:15');
});
test('REGRESSION explicit ISO offset and seconds override the chart coordinate',()=>{
 for(const label of ['2026-09-11T10:16:05-04:00','2026-09-11T14:16:05Z','09/11/2026 10:16:05 AM EDT']){
  const chart=parseNasdaqIntraday(fixture(label),'LITE',{now:summerNow});
  assert.equal(chart.timestamp[0],Date.parse('2026-09-11T14:16:05Z')/1000,label);
 }
});
test('REGRESSION source future labels and invalid dates must not be accepted using a stale x',()=>{
 for(const label of ['Sep 11, 2026 11:16 AM','02/30/2026 10:16 AM']){
  assert.throws(()=>parseNasdaqIntraday(fixture(label),'LITE',{now:summerNow}),label);
 }
});
test('CONTROL numeric-only old payload keeps epoch semantics and remains visibly unverified',()=>{
 const chart=parseNasdaqIntraday({data:{symbol:'LITE',chart:[{x:summerNow-12000,y:928.34}]}},'LITE',{now:summerNow});
 assert.equal(chart.timestamp[0],(summerNow-12000)/1000);
});
test('REGRESSION March and November stock sessions use date-specific offsets',()=>{
 const rows=[['2026-03-06',5],['2026-03-09',4],['2026-10-30',4],['2026-11-02',5]];
 for(const [date,h] of rows){
  const chart=parseNasdaqIntraday(fixture(date+' 10:16:00',date+'T10:16:00Z'),'LITE',{now:Date.parse(date+'T18:00:00Z')});
  assert.equal(chart.timestamp[0],(Date.parse(date+'T10:16:00Z')+h*3600000)/1000,date);
 }
});
test('REGRESSION host timezone cannot change upstream timestamp interpretation',()=>{
 const code=`import {parseNasdaqIntraday} from './lib/providers/public-history.js';console.log(JSON.stringify(parseNasdaqIntraday(${JSON.stringify(fixture('Sep 11, 2026 10:16 AM'))},'LITE',{now:${summerNow}}).timestamp));`;
 for(const tz of ['UTC','Asia/Shanghai','America/Los_Angeles']){
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,env:{...process.env,TZ:tz},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[Date.parse('2026-09-11T14:16:00Z')/1000],tz);
 }
});
test('CONTROL daily K stays a trading-date bar and must not receive an hourly shift',()=>{
 const chart=parseNasdaqHistory({data:{symbol:'LITE',tradesTable:{rows:[{date:'09/11/2026',open:'925',high:'930',low:'920',close:'928.34',volume:'100'}]}}},'LITE',{now:summerNow});
 assert.equal(chart.timestamp[0],Date.parse('2026-09-11T12:00:00Z')/1000);
});
test('REGRESSION normalized upstream time reaches chart enrichment and frontend formatter unchanged',async()=>{
 const enrich=createChartEnricher({now:()=>summerNow,includeDaily:false,fetchChart:async()=>parseNasdaqIntraday(fixture('Sep 11, 2026 10:16 AM'),'LITE',{now:summerNow})});
 const q=await enrich('LITE',{symbol:'LITE',price:928.34,currency:'USD',quoteAt:summerNow,gmtoff:-14400,marketState:'REGULAR',src:'tx-batch'});
 const box={window:{},Date};vm.runInNewContext(fs.readFileSync(new URL('public/modules/panel-format.js',root),'utf8'),box);
 assert.equal(box.window.PANEL_FORMAT.fmtDate(q.charts.intraday[0].t),'2026-09-11 22:16');
 assert.equal(q.quoteAt,summerNow,'card timestamp must not be altered to fit the chart');
});

test('REGRESSION normalization marker survives enrichment for persisted-cache migration',async()=>{
 const enrich=createChartEnricher({now:()=>summerNow,includeDaily:false,fetchChart:async()=>parseNasdaqIntraday(fixture('Sep 11, 2026 10:16 AM'),'LITE',{now:summerNow})});
 const q=await enrich('LITE',{symbol:'LITE',price:928.34,currency:'USD',quoteAt:summerNow});
 assert.equal(q.slowFields.intraday.timeContract,'nasdaq-label-et-v2');
 assert.equal(q.slowFields.intraday.timeBasis,'source-label');
});
test('REGRESSION source time remains genuinely stale when timestamp conversion is correct',()=>{
 const chart=parseNasdaqIntraday(fixture('Sep 11, 2026 9:16 AM','2026-09-11T09:16:00Z'),'LITE',{now:summerNow});
 assert.equal(format(chart.timestamp[0]),'2026-09-11 21:16');
 assert.equal(summerNow-chart.timestamp[0]*1000,3612000);
});
test('REGRESSION DST impossible or ambiguous local hour is rejected; explicit EDT/EST disambiguates',()=>{
 for(const [label,date] of [['Mar 08, 2026 2:30 AM','2026-03-08'],['Nov 01, 2026 1:30 AM','2026-11-01']]){
  assert.throws(()=>parseNasdaqIntraday(fixture(label,date+'T01:30:00Z'),'LITE',{now:Date.parse(date+'T18:00:00Z')}));
 }
 for(const [zone,utc] of [['EDT','05:30'],['EST','06:30']]){
  const c=parseNasdaqIntraday(fixture('Nov 01, 2026 1:30 AM '+zone,'2026-11-01T01:30:00Z'),'LITE',{now:Date.parse('2026-11-01T18:00:00Z')});
  assert.equal(c.timestamp[0],Date.parse('2026-11-01T'+utc+':00Z')/1000);
 }
});
test('REGRESSION time-only label with seconds and no numeric anchor cannot borrow server date',()=>{
 const chart=parseNasdaqIntraday(fixture('10:16:05 AM'),'LITE',{now:summerNow});
 assert.equal(chart.timestamp[0],Date.parse('2026-09-11T14:16:05Z')/1000);
 assert.throws(()=>parseNasdaqIntraday({data:{symbol:'LITE',chart:[{y:928.34,z:{dateTime:'10:16 AM'}}]}},'LITE',{now:summerNow}));
});

test('REGRESSION rightmost visible intraday time tick includes the actual endpoint',()=>{
 const box={window:{},Date};for(const file of ['panel-format.js','panel-chart-engine.js'])vm.runInNewContext(fs.readFileSync(new URL('public/modules/'+file,root),'utf8'),box);
 const engine=box.window.PANEL_CHART_ENGINE.createChartEngine({UP:'red',DOWN:'green',fmtDate:box.window.PANEL_FORMAT.fmtDate,formatterFor:()=>({money:String}),maSeries:()=>[]});
 const bars=Array.from({length:8},(_,i)=>({t:Date.parse('2026-09-11T14:09:00Z')/1000+i*60,c:920+i,v:null}));
 const q={tf:'intraday',d:{charts:{intraday:bars}},followEnd:true,_chartWidth:440};const plot=engine.computePlot(q);let ticks=[];
 plot.ctx=new Proxy({fillText:(s,x,y)=>{if(y===plot.H-7)ticks.push(s);},measureText:s=>({width:s.length*6}),createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>k in o?o[k]:()=>{}});
 engine.drawPlot(q,plot,null);assert.ok(ticks.includes('22:16'),JSON.stringify(ticks));
});
