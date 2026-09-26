import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {projectRegularBars,recentRegularSessions} from '../../lib/regular-chart-service.js';
import {createChartDetailService} from '../../lib/chart-detail-service.js';

const at=value=>Date.parse(value),now=at('2026-09-26T01:00:00Z');
test('real TSM candles keep 78 safe regular intervals without claiming closing-print coverage',async()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/tsmc-naver.json',import.meta.url),'utf8'));
  const provider=createNaverWorldHistory({now:()=>now,resolveCode:async()=>({code:'TSM',exchange:'NYS'}),
    httpsGet:async()=>({status:200,body:JSON.stringify(fixture.chart)})});
  const chart=await provider('TSM',`?interval=5m&period1=${at('2026-09-24T13:00Z')/1000}&period2=${at('2026-09-24T21:00Z')/1000}`);
  const q=chart.indicators.quote[0],bars=chart.timestamp.map((t,i)=>({t,o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]}));
  const options={source:chart.source,pointKind:chart.meta.chartTimeBasis,intervalSeconds:chart.meta.chartIntervalSeconds,
    instrumentType:'EQUITY',targetDate:'2026-09-24',now};
  const projected=projectRegularBars('TSM',bars,options);
  assert.equal(bars.length,79);assert.equal(projected.bars.length,78);
  assert.equal(projected.bars.at(-1).t,at('2026-09-24T19:55Z')/1000);
  assert.equal(projected.volumeQuality.status,'partial');
  assert.equal(projected.volumeQuality.closingPrintStatus,'unverified');
  assert.equal(projected.missingReason,'CLOSING_PRINT_COVERAGE_UNVERIFIED');
  const open=projectRegularBars('TSM',bars,{...options,now:at('2026-09-24T15:00Z')});
  assert.equal(open.volumeQuality.status,'ready');assert.equal(open.volumeQuality.closingPrintStatus,undefined);
  const crossing={...bars.at(-2),t:at('2026-09-24T19:58Z')/1000};
  assert.equal(projectRegularBars('TSM',[bars[0],crossing],options).bars.length,1);
  provider.close();
});

test('five-day Naver projection excludes every mixed closing interval and marks incomplete closing coverage',async()=>{
  const sessions=recentRegularSessions('NVDA','2026-09-25',5);
  const bars=sessions.flatMap(day=>[
    {t:day.sessions[0].open_at_ms/1000,c:100,v:100},
    {t:day.sessions.at(-1).close_at_ms/1000-300,c:101,v:200},
    {t:day.sessions.at(-1).close_at_ms/1000,c:999,v:999999}]);
  const service=createChartDetailService({now:()=>now,readQuote:symbol=>({symbol,currency:'USD'}),fetchChart:async symbol=>({
    source:'naver-world-chart',meta:{symbol,currency:'USD',dataGranularity:'5m',chartTimeBasis:'bar-start',chartIntervalSeconds:300},
    timestamp:bars.map(b=>b.t),indicators:{quote:[{close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}})});
  const result=(await service.read('NVDA',{range:'5d'})).fiveDay;
  assert.equal(result.bars.length,10);assert.ok(result.bars.every(b=>b.c!==999&&b.v!==999999));
  assert.equal(result.status,'partial');assert.equal(result.reason,'CLOSING_PRINT_COVERAGE_UNVERIFIED');
  assert.equal(result.coveredDays,5);assert.ok(result.days.every(d=>d.volumeQuality.closingPrintStatus==='unverified'));
});

test('a Taiwan five-day cooldown does not block NVDA or extend when reread',async()=>{
  let clock=now;const calls=[];
  const sessions=recentRegularSessions('NVDA','2026-09-25',5),timestamps=sessions.map(d=>d.sessions[0].open_at_ms/1000);
  const service=createChartDetailService({now:()=>clock,readQuote:symbol=>({symbol,currency:symbol.endsWith('.TW')?'TWD':'USD'}),
    fetchChart:async symbol=>{calls.push(symbol);if(symbol==='2330.TW')throw Object.assign(new Error('cooling'),{code:'SOURCE_COOLDOWN',retryAt:now+300000});
      return {source:'yahoo',meta:{symbol,currency:'USD',dataGranularity:'5m'},timestamp:timestamps,
        indicators:{quote:[{close:timestamps.map(()=>100),volume:timestamps.map(()=>100)}]}};}});
  const taiwan=await service.read('2330.TW',{range:'5d'});clock+=10000;
  assert.equal((await service.read('NVDA',{range:'5d'})).fiveDay.status,'ready');
  assert.equal((await service.read('2330.TW',{range:'5d'})).fiveDay.retryAt,taiwan.fiveDay.retryAt);
  assert.deepEqual(calls,['2330.TW','NVDA']);
});

function detailHarness(){
  const fields=new Map(),timers=new Map();let timerId=0,model;
  const node=()=>({textContent:'',style:{},width:800,height:300,replaceChildren(){},appendChild(){},
    getContext:()=>({setTransform(){},clearRect(){}}),getBoundingClientRect:()=>({width:800,height:300})});
  const dialog={open:true,classList:{contains:()=>false},querySelector:s=>{if(!fields.has(s))fields.set(s,node());return fields.get(s);}};
  const engine={computePlot:q=>{model=q;const bars=q.historyStore.getSeries(q.tf);return {W:800,H:300,all:bars,bars,n:bars.length,a:0,candle:true};},drawPlot(){},drawCursor(){}};
  const pending=[];
  const context={window:{PANEL_CHART_ENGINE:{createChartEngine:()=>engine},PANEL_FORMAT:{fmtVol:String},PANEL_CHART:{},devicePixelRatio:1},
    Date,Intl,AbortController,requestAnimationFrame:()=>1,setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,{signal})=>new Promise((resolve,reject)=>{pending.push({url,signal,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('aborted')));})};
  const source=fs.readFileSync(new URL('../../public/modules/panel-chart-detail.js',import.meta.url),'utf8');
  for(const name of ['panel-scheduler','panel-network','panel-timeframes','panel-format'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),context);
  vm.runInNewContext(source.replace('return Object.freeze({mount,update:q=>',
    'return Object.freeze({set:(q,d,p)=>{current=q;dialog=d;tf=p;view={visN:{}};},draw,fetchDetail,mount,update:q=>'),context);
  const detail=context.window.PANEL_CHART_DETAIL.createChartDetailView({document:{},formatterFor:d=>({money:v=>d.currency+v}),UP:'red',DOWN:'green'});
  let bars=[{periodStart:'2026-09-24',t:at('2026-09-24T00:00Z')/1000,o:100,h:102,l:99,c:101,v:300}];
  let meta={source:'nasdaq-history',currency:'CAD',volumeUnit:'shares',adjustmentBasis:'nasdaq-history-source-default-unverified',coverageStatus:'partial',historyAsOf:'2026-09-24',stale:true};
  const q={symbol:'QQQ',d:{symbol:'QQQ',currency:'USD',regularChart:{exchangeZone:'America/New_York',source:'naver-world-chart'}},
    historyStore:{getSeries:()=>bars,getMeta:()=>({status:'stale',meta})}};
  return {detail,fields,pending,timers,model:()=>model,set:(period='daily30')=>detail.set(q,dialog,period),setBars:value=>{bars=value;},setMeta:value=>{meta=value;}};
}

test('detail history keeps date labels, correct metadata and clears the old caption for empty periods',()=>{
  const h=detailHarness();h.set();h.detail.draw();
  const point=h.fields.get('.cd-point').textContent,info=h.fields.get('.cd-chart-info').textContent;
  assert.match(point,/2026-09-24/);assert.doesNotMatch(point,/09\/23|美东/);
  assert.match(point,/CAD100/);assert.equal(h.model()._chartData.currency,'CAD');
  for(const expected of ['nasdaq-history','历史覆盖不完整','来源复权口径未确认','缓存历史已过期'])assert.ok(info.includes(expected),expected);
  assert.doesNotMatch(info,/naver-world-chart/);
  h.setBars([{periodStart:'2026-01-01',t:at('2026-01-01T00:00Z')/1000,o:100,h:102,l:99,c:101,v:300}]);
  h.set('yearly');h.detail.draw();assert.match(h.fields.get('.cd-point').textContent,/^2026 · 交易所交易日/);
  h.setBars([]);h.setMeta({source:'twse-stock-day',volumeUnit:'source-unit-unverified'});h.set('monthly');h.detail.draw();
  const empty=h.fields.get('.cd-chart-info').textContent;
  assert.match(empty,/月K · 0 根K线 · twse-stock-day/);assert.doesNotMatch(empty,/nasdaq-history|MA5/);
});

test('detail polling shares a pending request, accepts a slow response, and cancels only obsolete ranges',async()=>{
  const h=detailHarness();h.set('fiveDay');
  const first=h.detail.fetchDetail('5d'),poll=h.detail.fetchDetail('5d');
  assert.equal(first,poll);assert.equal(h.pending.length,1);assert.equal(h.pending[0].signal.aborted,false);
  h.pending[0].resolve({ok:true,json:async()=>({symbol:'QQQ',range:'5d',fiveDay:{bars:[]},tape:{events:[]}})});await first;
  assert.equal(h.timers.size,0);
  const obsolete=h.detail.fetchDetail('5d'),current=h.detail.fetchDetail('1d');
  assert.equal(h.pending[1].signal.aborted,true);assert.equal(h.pending[2].signal.aborted,false);
  h.pending[2].resolve({ok:true,json:async()=>({symbol:'QQQ',range:'1d',tape:{events:[]}})});await Promise.all([obsolete,current]);
  assert.equal(h.timers.size,0);
});
