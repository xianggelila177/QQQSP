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
function engineSandbox(){const s={window:{},Date};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),s);return s.window.PANEL_CHART_ENGINE;}
function historySandbox(){const s={window:{},URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,Date};for(const f of ['panel-timeframes.js','panel-history-store.js'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+f,import.meta.url),'utf8'),s);return s.window;}

test('REGRESSION: Yahoo 429 cannot disable US daily/weekly/monthly/yearly at the real HTTP boundary',async t=>{
 const calls=[];
 const app=createApplication({env:{PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},now:()=>asOf,telemetry:createTelemetry(),upstream:async url=>{
  calls.push(url);
  if(url.includes('api.nasdaq.com')&&url.includes('/historical'))return {status:200,headers:{},body:JSON.stringify({data:{symbol:'NVDA',totalRecords:sourceRows().length,tradesTable:{rows:sourceRows()}},status:{rCode:200}})};
  return {status:429,headers:{'retry-after':'120'},body:''};
 }});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 for(const period of ['daily','weekly','monthly','yearly']){
  const r=await fetch(`${origin}/api/history?symbol=NVDA&period=${period}&count=12`),j=await r.json();
  assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.status,'ready');assert.ok(j.bars.length>=9,period);assert.equal(j.source,'nasdaq-history');
  assert.ok(j.bars.every(b=>b.o>0&&b.l<=b.o&&b.h>=b.c));assert.equal(j.exchangeTimeZone,'America/New_York');
  if(period==='daily')assert.equal(j.bars.at(-1).lastTradingDate,'2026-09-09');
 }
 const historyCalls=calls.filter(u=>u.includes('/historical'));
 assert.equal(historyCalls.length,2,'daily/weekly/monthly share one window; yearly expands it exactly once');
 assert.ok(new URL(historyCalls[1]).searchParams.get('fromdate')<new URL(historyCalls[0]).searchParams.get('fromdate'));
 await fetch(origin+'/api/history?symbol=NVDA&period=yearly&count=12');
 assert.equal(calls.filter(u=>u.includes('/historical')).length,2,'repeated yearly read reuses cache');
 assert.ok(calls.filter(u=>/yahoo\.com/.test(u)).length<=1,'Yahoo cooldown is shared');
});

test('REGRESSION: HTTP 200 with empty chart is not a successful source when a usable alternative exists',async()=>{
 let used=0;const data={source:'backup',meta:{symbol:'NVDA',currency:'USD',dataGranularity:'1d'},timestamp:[asOf/1000-86400],indicators:{quote:[{open:[100],high:[102],low:[99],close:[101]}]}};
 const get=createHistorySource({primary:async()=>({timestamp:[],indicators:{quote:[{}]}}),alternative:async()=>{used++;return data;}});
 const got=await get('NVDA','?interval=1d');assert.equal(got.source,'backup');assert.equal(used,1);
});

test('REGRESSION: intraday OHLC provider payload must still render as a line, never accidental candles',()=>{
 const api=engineSandbox(),engine=api.createChartEngine({UP:'red',DOWN:'green',fmtDate:()=>'',formatterFor:()=>({money:n=>String(n)}),maSeries:a=>a.map(()=>null)});
 const q={tf:'intraday',d:{charts:{intraday:[{t:100,o:90,h:104,l:89,c:100},{t:160,o:100,h:101,l:97,c:99}]}},followEnd:true,_chartWidth:400};
 const p=engine.computePlot(q);assert.equal(p.candle,false);
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
