import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {parseNasdaqHistory,parseNasdaqIntraday,parseEastmoneyHistory,createPublicHistory,eastmoneyIds} from '../../lib/providers/public-history.js';
const at=Date.parse('2026-09-10T14:00:00Z');
const raw=symbol=>({meta:{symbol,dataGranularity:'1d',currency:'USD',exchangeTimezoneName:'America/New_York',instrumentType:'EQUITY'},timestamp:[Date.parse('2026-09-09T14:00Z')/1000],indicators:{quote:[{open:[100],high:[105],low:[99],close:[102],volume:[1000]}]}});
const ndq=(symbol='NVDA',date='09/09/2026')=>({data:{symbol,tradesTable:{rows:[{date,open:'$100.00',close:'$102.00',high:'105.00',low:'99.00',volume:'12,345'}]}}});
const east=(code='MRVL',market=105)=>({data:{code,market,klines:['2026-09-09,100,102,105,99,12345,100000,1,2,2,3']}});
const ok=j=>({status:200,headers:{},body:JSON.stringify(j)});
test('Nasdaq dates are exchange dates, not UTC midnight shifted to the previous NY session',()=>{
 const j=parseNasdaqHistory(ndq(),'NVDA',{now:at});assert.equal(j.timestamp[0],Date.parse('2026-09-09T12:00Z')/1000);assert.equal(j.indicators.quote[0].volume[0],12345);
 assert.throws(()=>parseNasdaqHistory(ndq('AAPL'),'NVDA',{now:at}),{code:'HISTORY_IDENTITY_CONFLICT'});
 assert.throws(()=>parseNasdaqHistory(ndq('NVDA','02/30/2026'),'NVDA',{now:at}));
 assert.throws(()=>parseNasdaqHistory(ndq('NVDA','09/11/2026'),'NVDA',{now:at}));
});
test('Eastmoney codes and namespaces are verified; OHLC field order cannot invert high/low/close',()=>{
 const j=parseEastmoneyHistory(east(),'MRVL','105.MRVL',{now:at});const q=j.indicators.quote[0];assert.deepEqual([q.open[0],q.high[0],q.low[0],q.close[0]],[100,105,99,102]);
 assert.throws(()=>parseEastmoneyHistory(east('NVDA'),'MRVL','105.MRVL',{now:at}),{code:'HISTORY_IDENTITY_CONFLICT'});
 assert.throws(()=>parseEastmoneyHistory(east('MRVL',106),'MRVL','105.MRVL',{now:at}),{code:'HISTORY_IDENTITY_CONFLICT'});
 assert.deepEqual(eastmoneyIds('000660.KS'),[]);assert.deepEqual(eastmoneyIds('0700.HK'),['116.00700']);assert.deepEqual(eastmoneyIds('161128.SZ'),['0.161128']);
});
test('Nasdaq intraday accepts source epoch, keeps latest NY date and never fabricates volume',()=>{
 const j=parseNasdaqIntraday({data:{symbol:'NVDA',chart:[{x:at-86400000,y:98},{x:at-60000,y:102},{x:at+60000,y:103}]}},'NVDA',{now:at});
 assert.deepEqual(j.timestamp,[(at-60000)/1000]);assert.deepEqual(j.indicators.quote[0].volume,[null]);assert.equal(j.meta.dataGranularity,'1m');
});
test('empty Nasdaq table uses Eastmoney, then identical requests use the shared cached result',async()=>{
 let calls=[];const source=createPublicHistory({now:()=>at,httpsGet:async url=>{calls.push(url);return url.includes('nasdaq')?ok({data:{symbol:'MRVL',tradesTable:{rows:[]}}}):ok(east());}});
 const first=await source('MRVL','?interval=1d&range=2y');const second=await source('MRVL','?interval=1d&range=2y');assert.strictEqual(first,second);assert.equal(first.source,'eastmoney-history');assert.equal(calls.length,2);
});
test('daily to yearly while source request is in flight uses bounded Nasdaq pages, not undersized cache',async()=>{
 let release,calls=[];const dates=['09/09/2026','09/04/2026','09/05/2025'];
 const source=createPublicHistory({now:()=>at,httpsGet:async url=>{calls.push(url);if(calls.length===1)await new Promise(r=>release=r);return ok(ndq('NVDA',dates[calls.length-1]));}});
 const short=source('NVDA','?interval=1d&period1='+Date.parse('2025-01-01')/1000);
 const long=source('NVDA','?interval=1d&period1='+Date.parse('1990-01-01')/1000);
 release();const [recent,wider]=await Promise.all([short,long]);
 assert.equal(calls.length,3);assert.equal(recent.coverage.pages,1);assert.equal(wider.coverage.pages,2);
 assert.equal(wider.retrievalLimited,true);assert.equal(wider.coverage.stopReason,'bounded-pages');
 assert.equal(wider.timestamp.length,3);
 assert.ok(calls.every(url=>Number(new URL(url).searchParams.get('limit'))<=300));
 assert.ok(calls.every(url=>new URL(url).searchParams.get('fromdate')>'1990-01-01'));
});
test('a failed older Nasdaq page preserves the recent daily bars with explicit partial coverage',async()=>{
 const calls=[];const source=createPublicHistory({now:()=>at,httpsGet:async url=>{
  calls.push(url);if(calls.length===2)throw Object.assign(new Error('upstream timeout'),{code:'ETIMEDOUT'});
  return ok(ndq('TSM'));
 }});
 const query='?interval=1d&period1='+Date.parse('2000-01-01')/1000;
 const first=await source('TSM',query);assert.equal(first.timestamp.length,1);
 assert.equal(first.retrievalLimited,true);assert.equal(first.coverage.stopReason,'page-error');
 assert.equal(first.coverage.firstTradingDate,'2026-09-09');
 assert.deepEqual(source.diagnostics().recentFailures[0].range,{from:new URL(calls[1]).searchParams.get('fromdate'),
  through:new URL(calls[1]).searchParams.get('todate')});
 assert.equal(source.diagnostics().recentFailures[0].code,'ETIMEDOUT');
 assert.strictEqual(await source('TSM',query),first);assert.equal(calls.length,2);
});
test('wide history failure cools that range but permits a narrower TSM read',async()=>{
 let calls=0;const service=createHistoryService({now:()=>at,fetchChart:async(_symbol,query)=>{
  calls++;if(new URLSearchParams(query).get('period1')<Date.parse('2010-01-01')/1000)
   throw Object.assign(new Error('large range timed out'),{code:'HISTORY_TIMEOUT',statusCode:504});
  return raw('TSM');
 }});
 try{
  await assert.rejects(service.get('TSM','yearly',{count:20}),{code:'HISTORY_TIMEOUT'});
  const recent=await service.get('TSM','daily',{count:30});
  assert.equal(recent.symbol,'TSM');assert.equal(recent.bars.length,1);assert.equal(calls,2);
 }finally{service.close();}
});
test('a true 429 keeps narrower requests in cooldown, while targeted invalidation can reread one symbol',async()=>{
 let calls=0,limited=true;const service=createHistoryService({now:()=>at,fetchChart:async symbol=>{
  calls++;if(symbol==='TSM'&&limited)throw Object.assign(new Error('429'),{code:'HISTORY_RATE_LIMITED',status:429,retryAt:at+120000});
  return raw(symbol);
 }});
 try{
  await assert.rejects(service.get('TSM','yearly',{count:20}));
  await assert.rejects(service.get('TSM','daily',{count:1}));assert.equal(calls,1);
  const other=await service.get('NVDA','daily',{count:1});assert.equal(other.bars.length,1);
  limited=false;service.invalidate('TSM');
  const recovered=await service.get('TSM','daily',{count:1});assert.equal(recovered.bars.length,1);
  await service.get('NVDA','daily',{count:1});assert.equal(calls,3);
 }finally{service.close();}
});
test('bounded source coverage keeps the requested range distinct from retrieved bars',async()=>{
 let calls=0;const service=createHistoryService({now:()=>at,fetchChart:async()=>{
  calls++;return {...raw('TSM'),retrievalLimited:true,retrievedFrom:'2026-09-09'};
 }});
 try{
  const first=await service.get('TSM','daily',{count:30});
  assert.ok(first.coverage.requestedFrom<'2026-09-09');
  assert.equal(first.coverage.firstTradingDate,'2026-09-09');assert.equal(first.hasMore,null);
  await service.get('TSM','daily',{count:30});assert.equal(calls,1);
 }finally{service.close();}
});
test('history timeout starts when a queued job executes; queueing cards cannot expire healthy work',async()=>{
 const service=createHistoryService({now:()=>at,maxConcurrent:1,deadlineMs:100,fetchChart:async symbol=>{await new Promise(r=>setTimeout(r,60));return raw(symbol);}});
 try{const results=await Promise.all(['NVDA','MRVL','ALAB'].map(s=>service.get(s,'daily',{count:1})));assert.ok(results.every(x=>x.bars.length===1));}finally{service.close();}
});
test('a late wider history demand is fulfilled even after the first source request has already started',async()=>{
 let release,started,calls=[];const hasStarted=new Promise(r=>started=r);
 const service=createHistoryService({now:()=>at,fetchChart:async(symbol,query)=>{calls.push(query);if(calls.length===1){started();await new Promise(r=>release=r);}return raw(symbol);}});
 try{const short=service.get('NVDA','daily',{count:1});await hasStarted;const long=service.get('NVDA','yearly',{count:20});release();await Promise.all([short,long]);assert.equal(calls.length,2);assert.ok(Number(new URLSearchParams(calls[1]).get('period1'))<Number(new URLSearchParams(calls[0]).get('period1')));}finally{service.close();}
});
test('first cold failure includes the same retryAt as subsequent suppressed reads',async()=>{
 let calls=0;const service=createHistoryService({now:()=>at,fetchChart:async()=>{calls++;throw new Error('offline');}});let retry;
 try{await assert.rejects(service.get('NVDA','daily'),e=>(retry=e.retryAt)>at);await assert.rejects(service.get('NVDA','daily'),e=>e.retryAt===retry);assert.equal(calls,1);}finally{service.close();}
});
test('429 on the Eastmoney host does not probe another namespace during cooldown',async()=>{
 let calls=[];const source=createPublicHistory({now:()=>at,httpsGet:async url=>{calls.push(url);return {status:429,headers:{'retry-after':'120'},body:''};}});
 await assert.rejects(source('NVDA','?interval=1d'),e=>e.retryAt>=at+120000);const first=calls.length;
 await assert.rejects(source('NVDA','?interval=1d'));assert.equal(calls.length,first);assert.equal(calls.filter(u=>u.includes('eastmoney')).length,1);
});
test('malformed successful history payload triggers a backup without weakening source identity checks',async()=>{
 const fetch=createHistorySource({primary:async()=>({...raw('OTHER')}),alternative:async()=>raw('NVDA')});assert.equal((await fetch('NVDA','?interval=1d')).meta.symbol,'NVDA');
});
test('same-day lagging source history stays visible; samples/history are explicit user choices',()=>{
 const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),sandbox);
 const select=sandbox.window.PANEL_CHART_ENGINE.createObservationSeries({now:()=>at});const history=[{t:at/1000-1800,c:100,v:100}];
 const q={symbol:'NVDA',src:'test',currency:'USD',gmtoff:-14400,quoteAt:at,price:102,marketState:'REGULAR',priceSession:'REGULAR',
  charts:{intraday:[{t:at/1000-7200,c:90,v:null},...history]},
  regularChart:{tradeDate:'2026-09-10',bars:history,regularSessions:[{open_at_ms:Date.parse('2026-09-10T13:30:00Z'),close_at_ms:Date.parse('2026-09-10T20:00:00Z')}]}};
 assert.strictEqual(select(q).bars,history);assert.equal(select(q,'samples').sampled,true);assert.strictEqual(select(q,'history').bars,history);
});
test('production lazy history enrichment fetches only intraday; daily/weekly use the history API on demand',async()=>{
 let calls=[];const enrich=createChartEnricher({now:()=>at,includeDaily:false,fetchChart:async(symbol,query)=>{calls.push(query);return raw(symbol);}});
 const q=await enrich('NVDA',{symbol:'NVDA',price:102,currency:'USD',quoteAt:at,charts:{}});assert.equal(calls.length,1);assert.match(calls[0],/interval=5m/);assert.equal(q.slowFields.daily30.status,'not-requested');
});
