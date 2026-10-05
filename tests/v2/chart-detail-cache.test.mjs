import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createChartDetailService} from '../../lib/chart-detail-service.js';
import {recentRegularSessions,regularChartTarget} from '../../lib/regular-chart-service.js';
import {createHttp} from '../../lib/http.js';

const base=Date.parse('2026-09-23T01:00:00Z');
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const readOptions={range:'5d',sections:'chart'};
function source(symbol,at=base,currency='USD'){
  const sessions=recentRegularSessions(symbol,regularChartTarget(symbol,at).targetDate,5);
  const rows=sessions.map(day=>({t:day.sessions[0].open_at_ms/1000,o:100,h:103,l:98,c:101,v:1000}));
  return {source:'yahoo',meta:{symbol,currency,dataGranularity:'5m',chartTimeBasis:'bar-start'},timestamp:rows.map(b=>b.t),
    indicators:{quote:[{open:rows.map(b=>b.o),high:rows.map(b=>b.h),low:rows.map(b=>b.l),close:rows.map(b=>b.c),volume:rows.map(b=>b.v)}]}};
}
const quote=(symbol,currency='USD')=>({symbol,currency,instrumentType:'EQUITY'});

test('expired five-day bars return immediately while one background refresh runs; failure retains source time',async t=>{
  let clock=base,calls=0;const pending=defer();
  const service=createChartDetailService({now:()=>clock,readQuote:quote,fetchChart:async symbol=>{calls++;return calls===1?source(symbol):pending.promise;}});
  t.after(()=>service.stop());
  const first=(await service.read('NVDA',readOptions)).fiveDay;
  clock+=120001;
  const [a,b]=await Promise.all([service.read('NVDA',readOptions),service.read('NVDA',readOptions)]);
  assert.equal(calls,2);assert.equal(a.fiveDay.cached,true);assert.equal(a.fiveDay.stale,true);assert.equal(a.fiveDay.refreshing,true);
  assert.deepEqual(a.fiveDay.bars,first.bars);assert.deepEqual(b.fiveDay.bars,first.bars);
  pending.reject(Object.assign(new Error('source unavailable'),{code:'SOURCE_COOLDOWN',retryAt:clock+300000}));
  await service.settled();
  const kept=(await service.read('NVDA',readOptions)).fiveDay;
  assert.deepEqual(kept.bars,first.bars);assert.equal(kept.sourceCheckedAt,base);
  assert.equal(kept.refreshError,'SOURCE_COOLDOWN');assert.equal(kept.stale,true);assert.equal(kept.refreshing,false);
  assert.equal(kept.retryAt,clock+300000);assert.equal(calls,2);
});

test('closing the only reader does not cancel first-load warming; shutdown still cancels producers',async t=>{
  const pending=defer(),started=defer();let sourceSignal,calls=0;
  const service=createChartDetailService({now:()=>base,readQuote:quote,fetchChart:async(symbol,_query,{signal})=>{
    calls++;sourceSignal=signal;started.resolve();return pending.promise;
  }});t.after(()=>service.stop());
  const reader=new AbortController(),job=service.read('NVDA',{...readOptions,signal:reader.signal});
  await started.promise;reader.abort(new Error('dialog closed'));
  await assert.rejects(job,/dialog closed/);assert.equal(sourceSignal.aborted,false);
  pending.resolve(source('NVDA'));await service.settled();
  assert.equal((await service.read('NVDA',readOptions)).fiveDay.bars.length,5);assert.equal(calls,1);
  const nextStarted=defer();
  const other=createChartDetailService({now:()=>base,readQuote:quote,fetchChart:async(_symbol,_query,{signal})=>{
    nextStarted.resolve(signal);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const next=other.read('NVDA',readOptions);const signal=await nextStarted.promise;
  const rejected=assert.rejects(next,error=>error.code==='STOPPED');await other.stop();await rejected;
  assert.equal(signal.aborted,true);await assert.rejects(other.read('NVDA',readOptions),error=>error.code==='STOPPED');
});

test('validated five-day checkpoint survives restart with original source timestamps',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-five-day-')),statePath=path.join(directory,'cache.json');
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=createChartDetailService({statePath,now:()=>base,readQuote:quote,fetchChart:async symbol=>source(symbol)});
  const original=(await first.read('NVDA',readOptions)).fiveDay;await first.stop();
  const pending=defer();let calls=0;
  const second=createChartDetailService({statePath,now:()=>base+120001,readQuote:quote,fetchChart:async()=>{calls++;return pending.promise;}});
  t.after(()=>second.stop());
  const restored=(await second.read('NVDA',readOptions)).fiveDay;
  assert.deepEqual(restored.bars,original.bars);assert.equal(restored.sourceCheckedAt,base);
  assert.equal(restored.stale,true);assert.equal(restored.refreshing,true);assert.equal(second.diagnostics().restored,1);assert.equal(calls,1);
  pending.resolve(source('NVDA'));await second.settled();
});

test('checkpoint rejects malformed OHLC and does not reuse another currency or trading-date window',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-five-day-')),statePath=path.join(directory,'cache.json');
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=createChartDetailService({statePath,now:()=>base,readQuote:quote,fetchChart:async symbol=>source(symbol)});
  await first.read('NVDA',readOptions);await first.stop();
  const saved=JSON.parse(await fs.readFile(statePath,'utf8'));
  saved.entries[0].value.bars[0].h=1;saved.entries[0].value.days[0].bars[0].h=1;
  await fs.writeFile(statePath,JSON.stringify(saved));
  let clock=base,currency='USD',calls=0;
  const service=createChartDetailService({statePath,now:()=>clock,readQuote:symbol=>quote(symbol,currency),
    fetchChart:async symbol=>{calls++;return source(symbol,clock,currency);}});t.after(()=>service.stop());
  await service.read('NVDA',readOptions);assert.equal(service.diagnostics().restored,0);assert.equal(calls,1);
  currency='CAD';assert.equal((await service.read('NVDA',readOptions)).fiveDay.currency,'CAD');assert.equal(calls,2);
  clock=Date.parse('2026-09-24T01:00:00Z');
  const later=(await service.read('NVDA',readOptions)).fiveDay;
  assert.equal(later.tradeDates.at(-1),'2026-09-23');assert.equal(later.cached,false);assert.equal(calls,3);
});

test('five-day memory bounds evict the least recently used identity',async t=>{
  let calls=0;const service=createChartDetailService({maxEntries:2,now:()=>base,readQuote:quote,
    fetchChart:async symbol=>{calls++;return source(symbol);}});t.after(()=>service.stop());
  await service.read('NVDA',readOptions);await service.read('AAPL',readOptions);await service.read('NVDA',readOptions);
  await service.read('MSFT',readOptions);assert.equal(service.diagnostics().entries,2);
  assert.ok(service.diagnostics().bytes<=service.diagnostics().maxBytes);
  await service.read('AAPL',readOptions);assert.equal(calls,4);assert.equal(service.diagnostics().evictions,2);
});

test('separate chart and market responses cannot block one another or start the wrong source',async t=>{
  const pending=defer();let charts=0,trades=0;
  const service=createChartDetailService({now:()=>base,readQuote:quote,
    fetchChart:async symbol=>{charts++;return source(symbol);},publicTape:{read:async()=>{trades++;return pending.promise;}}});
  t.after(()=>service.stop());
  const chart=await service.read('NVDA',readOptions);assert.equal(chart.fiveDay.bars.length,5);
  assert.equal(chart.tape,null);assert.equal(trades,0);
  const market=service.read('AAPL',{range:'5d',sections:'market'});
  pending.resolve({events:[],status:'unavailable'});const result=await market;
  assert.equal(result.fiveDay,null);assert.equal(result.chart,null);assert.equal(charts,1);assert.equal(trades,1);
});

test('HTTP validates and forwards chart detail sections while preserving default all',async t=>{
  const calls=[],server=createHttp({chartDetail:{read:async(symbol,options)=>{calls.push(options.sections);return {symbol,sections:options.sections};}}},
    {env:{PORT:0},monitorCore:false});server.startListen();await once(server.httpServer,'listening');t.after(()=>server.stop());
  const url='http://127.0.0.1:'+server.httpServer.address().port+'/api/chart/detail?symbol=NVDA';
  for(const sections of ['chart','market','all'])assert.equal((await fetch(url+'&sections='+sections)).status,200);
  assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url+'&sections=invalid')).status,400);
  assert.deepEqual(calls,['chart','market','all','all']);
});

test('market detail prefers a current quote book, otherwise preserves public snapshot provenance and missing reason',async t=>{
  let book=null,calls=0,mode='partial';
  const service=createChartDetailService({now:()=>base,readQuote:symbol=>({...quote(symbol),orderBook:book}),
    publicBook:{read:async(symbol,options)=>{calls++;assert.equal(options.currency,'USD');
      return {symbol,currency:'USD',status:mode,reason:mode==='partial'?'BOOK_TIME_UNAVAILABLE':'PUBLIC_BOOK_EMPTY',
        source:'nasdaq-public-book',asOf:null,checkedAt:base,timeBasis:'source-snapshot-time-unavailable',
        bid:{price:100,size:5},ask:{price:101,size:6},sizeUnit:null,coverage:'source-website-top-of-book-unverified',
        quality:['BOOK_TIME_UNAVAILABLE','BOOK_SIZE_UNIT_UNVERIFIED']};}}});t.after(()=>service.stop());
  await service.read('NVDA',{sections:'chart'});assert.equal(calls,0);
  const fallback=(await service.read('NVDA',{sections:'market'})).book;
  assert.equal(fallback.bid.price,100);assert.equal(fallback.status,'partial');assert.equal(fallback.reason,'BOOK_TIME_UNAVAILABLE');
  assert.equal(fallback.asOf,null);assert.equal(fallback.source,'nasdaq-public-book');assert.equal(fallback.sizeUnit,null);
  assert.deepEqual(fallback.quality,['BOOK_TIME_UNAVAILABLE','BOOK_SIZE_UNIT_UNVERIFIED']);
  book={symbol:'NVDA',currency:'USD',asOf:base,checkedAt:base,source:'alpaca-sip',sizeUnit:'shares',coverage:'us-sip',
    bid:{price:102,size:10},ask:{price:103,size:12}};
  assert.equal((await service.read('NVDA',{sections:'market'})).book.source,'alpaca-sip');assert.equal(calls,1);
  book=null;mode='unavailable';assert.equal((await service.read('NVDA',{sections:'market'})).book.reason,'PUBLIC_BOOK_EMPTY');
});
