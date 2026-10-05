import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {createHistorySource} from '../../lib/history-source.js';

const asOf=Date.parse('2026-09-10T14:00:00Z');
export function sourceRows(){
 const rows=[];
 for(let at=Date.parse('2017-01-03T12:00:00Z'),i=0;at<=asOf-864e5;at+=864e5,i++){
  const d=new Date(at);if([0,6].includes(d.getUTCDay()))continue;
  const n=100+i*.01,iso=d.toISOString().slice(0,10),[y,m,day]=iso.split('-');
  rows.push({date:`${m}/${day}/${y}`,open:n.toFixed(2),close:(n+1).toFixed(2),high:(n+2).toFixed(2),low:(n-1).toFixed(2),volume:'12,300'});
 }
 return rows.reverse();
}
function engineSandbox(clock=Date){const s={window:{},Date:clock};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),s);return s.window.PANEL_CHART_ENGINE;}
function historySandbox(){const s={window:{},URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,Date};for(const f of ['panel-timeframes.js','panel-scheduler.js','panel-network.js','panel-history-store.js'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+f,import.meta.url),'utf8'),s);return s.window;}

test('REGRESSION: Yahoo 429 cannot disable US daily/weekly/monthly/yearly at the real HTTP boundary',async t=>{
 const calls=[],historyReads=[],readsByPeriod=[],barsByPeriod=new Map();
 const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},now:()=>asOf,telemetry:createTelemetry(),upstream:async url=>{
  calls.push(url);
  if(url.includes('api.nasdaq.com')&&url.includes('/historical')){
   const params=new URL(url).searchParams,from=params.get('fromdate'),through=params.get('todate');
   const rows=sourceRows().filter(row=>{
    const [month,day,year]=row.date.split('/');const date=`${year}-${month}-${day}`;
    return date>=from&&date<=through;
   }).slice(0,Number(params.get('limit')));
   const oldest=rows.at(-1)?.date.split('/');
   historyReads.push({from,through,limit:Number(params.get('limit')),oldestDate:oldest&&`${oldest[2]}-${oldest[0]}-${oldest[1]}`});
   return {status:200,headers:{},body:JSON.stringify({data:{symbol:'NVDA',totalRecords:rows.length,tradesTable:{rows}},status:{rCode:200}})};
  }
  return {status:429,headers:{'retry-after':'120'},body:''};
 }});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 for(const period of ['daily','weekly','monthly','yearly']){
  const r=await fetch(`${origin}/api/history?symbol=NVDA&period=${period}&count=12`),j=await r.json();
  assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.status,'ready');assert.ok(j.bars.length>=(period==='yearly'?1:9),period);assert.equal(j.source,'nasdaq-history');
  if(period==='yearly'){
   assert.equal(j.coverage.stopReason,'fallback-window');
   assert.equal(j.coverage.sourceStopReason,'bounded-pages');
   assert.equal(j.hasMore,true,'a bounded provider budget must leave older history reachable');
   assert.equal(j.nextBefore,j.bars[0].periodStart,'continuation uses the earliest returned period boundary');
  }
  assert.ok(j.bars.every(b=>b.o>0&&b.l<=b.o&&b.h>=b.c));assert.equal(j.exchangeTimeZone,'America/New_York');
  if(period==='daily')assert.equal(j.bars.at(-1).lastTradingDate,'2026-09-09');
  readsByPeriod.push([period,historyReads.length]);barsByPeriod.set(period,j.bars);
 }
 // The recent tier intentionally avoids fetching a year for twelve daily bars.
 // Each long expansion is bounded to two pages; monthly reuses the weekly raw window.
 assert.deepEqual(readsByPeriod,[['daily',1],['weekly',3],['monthly',3],['yearly',5]],JSON.stringify(historyReads));
 assert.ok(Date.parse(historyReads[0].from)>=asOf-45*864e5,'daily starts with a bounded recent window');
 assert.equal(historyReads[0].through,'2026-09-10');
 for(const [i,page] of historyReads.entries()){
  assert.ok(Date.parse(page.through)-Date.parse(page.from)<=366*864e5,'each provider page stays bounded');
  assert.ok(page.limit<=300&&page.oldestDate,'provider pages contain usable rows within the row budget');
  if(i){
   assert.ok(page.from<historyReads[i-1].from,'each expansion reaches older history');
   assert.ok(page.through<historyReads[i-1].oldestDate,'backfill never requests an already fetched trading day');
  }
 }
 const fetched=historyReads.length;
 for(const period of ['daily','weekly','monthly','yearly']){
  const r=await fetch(`${origin}/api/history?symbol=NVDA&period=${period}&count=12`),j=await r.json();
  assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.status,'ready');
  if(period==='yearly'){
   assert.ok(j.bars[0].periodStart<barsByPeriod.get(period)[0].periodStart,'an unsatisfied long request continues into older history');
   assert.ok(historyReads.length>fetched&&historyReads.length<=fetched+2,'continuation stays within the two-page provider budget');
   assert.equal(j.hasMore,true);assert.equal(j.nextBefore,j.bars[0].periodStart);
   for(let i=fetched;i<historyReads.length;i++){
    assert.ok(historyReads[i].through<historyReads[i-1].oldestDate,'continuation never rereads a previously fetched trading day');
    assert.ok(Date.parse(historyReads[i].through)-Date.parse(historyReads[i].from)<=366*864e5,'continuation pages stay bounded');
   }
  }else{
   assert.deepEqual(j.bars,barsByPeriod.get(period));
   assert.equal(historyReads.length,fetched,`satisfied ${period} request reuses its cache`);
  }
 }
 assert.ok(calls.filter(u=>/yahoo\.com/.test(u)).length<=1,'Yahoo cooldown is shared');
});

test('REGRESSION: HTTP 200 with empty chart is not a successful source when a usable alternative exists',async()=>{
 let used=0;const data={source:'backup',meta:{symbol:'NVDA',currency:'USD',dataGranularity:'1d'},timestamp:[asOf/1000-86400],indicators:{quote:[{open:[100],high:[102],low:[99],close:[101]}]}};
 const get=createHistorySource({primary:async()=>({timestamp:[],indicators:{quote:[{}]}}),alternative:async()=>{used++;return data;}});
 const got=await get('NVDA','?interval=1d');assert.equal(got.source,'backup');assert.equal(used,1);
});

test('REGRESSION: intraday OHLC supports candles and an explicit line preference',()=>{
 const api=engineSandbox(),engine=api.createChartEngine({UP:'red',DOWN:'green',fmtDate:()=>'',formatterFor:()=>({money:n=>String(n)}),maSeries:a=>a.map(()=>null)});
 const q={tf:'intraday',d:{charts:{intraday:[{t:100,o:90,h:104,l:89,c:100},{t:160,o:100,h:101,l:97,c:99}]}},followEnd:true,_chartWidth:400};
 const p=engine.computePlot(q);assert.equal(p.candle,true);assert.equal(p.intraday,true);
 q.chartStyle='line';assert.equal(engine.computePlot(q).candle,false);
});

test('REGRESSION: early regular-session points fill the live viewport; full view still shows the closing bell',()=>{
 const open=Date.parse('2026-09-23T13:30:00Z'),close=open+390*60000,now=open+21*60000;
 class Clock extends Date {static now(){return now;}}
 const api=engineSandbox(Clock),engine=api.createChartEngine({UP:'red',DOWN:'green',fmtDate:()=>'',formatterFor:()=>({money:n=>String(n)}),maSeries:a=>a.map(()=>null)});
 const bars=Array.from({length:5},(_,i)=>({t:(open+i*5*60000)/1000,c:100+i,v:10}));
 const q={tf:'intraday',d:{marketState:'REGULAR',quoteAt:now,regularChart:{bars,regularSessions:[{open_at_ms:open,close_at_ms:close}]}},
  _displayIntraday:bars,followEnd:true,_chartWidth:450};
 let p=engine.computePlot(q),plotW=p.W-p.L-p.R;
 assert.equal(p.visibleSessions.at(-1).close,open+30*60000);
 assert.ok(p.x(4)>p.L+plotW*.55,'last available point should occupy most of the early-session chart');
 q.fullSession=true;p=engine.computePlot(q);
 assert.equal(p.visibleSessions.at(-1).close,close);
 assert.ok(p.x(4)<p.L+plotW*.1,'explicit full view retains the full trading session');
 q.fullSession=false;q.d.marketState='CLOSED';p=engine.computePlot(q);
 assert.equal(p.visibleSessions.at(-1).close,close,'completed days keep a full-session axis');
});

test('REGRESSION: exhausted older history page must not erase already displayed candles',async()=>{
 const w=historySandbox();let index=0;
 const bar={t:Date.parse('2026-09-09')/1000,periodStart:'2026-09-09',o:100,h:104,l:98,c:103,v:null};
 const fetchImpl=async()=>({ok:true,status:200,json:async()=>({schemaVersion:1,symbol:'NVDA',period:'daily',seriesId:'same',revision:String(++index),bars:index===1?[bar]:[],status:index===1?'ready':'empty',hasMore:false})});
 const store=w.PANEL_HISTORY_STORE.createHistoryStore({fetchImpl,symbol:'NVDA'});await store.load('daily30');assert.equal(store.getSeries('daily30').length,1);
 await store.load('daily30',{before:'2026-09-09'});assert.equal(store.getSeries('daily30').length,1);
});

test('REGRESSION: historical 429 carries retry metadata to a usable frontend error state',async()=>{
 const w=historySandbox(),retryAt=Date.now()+60000;
 const store=w.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',fetchImpl:async()=>({ok:false,status:429,json:async()=>({schemaVersion:1,error:'source cooling',code:'HISTORY_RATE_LIMITED',retryAt})})});
 await store.load('weekly');assert.equal(store.getMeta('weekly').status,'error');assert.equal(store.getMeta('weekly').retryAt,retryAt);assert.equal(store.getMeta('weekly').errorCode,'HISTORY_RATE_LIMITED');
});
