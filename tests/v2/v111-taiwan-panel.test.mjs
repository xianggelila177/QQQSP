import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {parseTwseQuote} from '../../lib/providers/twse-quotes.js';
import {parseTwseStockDay} from '../../lib/providers/twse-history.js';
import {createReferenceFx,parseBocRates} from '../../lib/providers/reference-fx.js';
import {createFxService} from '../../lib/fx-service.js';
import {currencyToCny} from '../../lib/currency.js';
import {createYahooTwHistory,parseYahooTwChart} from '../../lib/providers/yahoo-tw-history.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {createHostGate} from '../../lib/host-gate.js';
import {loadApp} from '../_harness.mjs';

const now=()=>Date.parse('2026-09-28T10:00:00Z');
const fixture=JSON.parse(readFileSync(new URL('./twse-2330-fixture.json',import.meta.url)));
const pageChart=JSON.parse(readFileSync(new URL('./yahoo-tw-2330-chart.json',import.meta.url)));
const base=()=>parseTwseQuote(fixture.quote,'2330.TW',{now:now(),bars:parseTwseStockDay(fixture.daily,'2330.TW','2026-09')});
// Model the actual SSR envelope, including unrelated JavaScript undefined.
const html=(chart=pageChart)=>'<script>root.App.main = {"unused":undefined,"context":{"dispatcher":{"stores":'+
  JSON.stringify({MarketChartStore:{isLibraFetched:true,libra:{'2330.TW':chart}}})+'}}};</script>';

test('reproduce Sep 28 holiday: available native minute history must reach the panel despite MIS no-history',async()=>{
  let calls=0;
  const enrich=createChartEnricher({now,fetchChart:async()=>{
    calls++;return {...pageChart,source:'yahoo-tw-chart',meta:{...pageChart.meta,chartTimeBasis:'price-point'}};
  }});
  const quote=await enrich('2330.TW',base());
  assert.equal(calls,1,'MIS absence must not bypass independent minute sources');
  assert.equal(quote.regularChart.status,'ready');
  assert.equal(quote.regularChart.stale,false);
  assert.equal(quote.regularChart.targetDate,'2026-09-24');
  assert.equal(quote.regularChart.tradeDate,'2026-09-24');
  assert.equal(quote.regularChart.missingReason,null);
  assert.ok(quote.regularChart.bars.length>200);
  assert.equal(quote.regularChart.bars.at(-1).t,1790227800,'retain the real 13:30 closing auction point');
  assert.equal(quote.regularChart.bars.at(-1).c,quote.price);
  assert.equal(quote.currency,'TWD');
  assert.equal(quote.regularChart.previousCloseReference.value,2500);
  assert.ok(quote.regularChart.bars.every(b=>b.v===null),'do not label Taiwan lots as verified shares');
});

test('cold-start fallback quote must still receive minute enrichment before the closed-market cooldown',async()=>{
  let calls=0;
  const enrich=createChartEnricher({now,fallback:async()=>base(),fetchChart:async()=>{
    calls++;return parseYahooTwChart(html(),'2330.TW',now());
  }});
  const quote=await enrich('2330.TW',undefined);
  assert.equal(quote.regularChart?.status,'ready');
  assert.ok(quote.regularChart.bars.length>200);
  assert.equal(calls,1);
});

const bocRows=()=>Object.entries({CNY:6.7133,TWD:31.758}).map(([quote,rate])=>({base:'USD',quote,rate,date:'2026-09-25',providers:[{key:'BOC',date:'2026-09-25',rate}]}));
test('reproduce missing TWD: use a coherent Bank of Canada USD/CNY/TWD reference snapshot',async()=>{
  const calls=[];
  const reference=createReferenceFx({now,httpsGet:async url=>{calls.push(url);return {status:200,body:JSON.stringify(bocRows())};}});
  const fx=createFxService({now,referenceOnly:true,getReference:reference.getRates});
  const snapshot=await fx.getFxSnapshot('TWD');
  assert.equal(snapshot.rates.TWD,31.758);
  assert.equal(snapshot.rates.USD,6.7133);
  assert.equal(snapshot.fxSource,'BOC');
  assert.equal(snapshot.fxDate,'2026-09-25');
  assert.equal(snapshot.fxStale,false);
  assert.equal(currencyToCny('TWD',snapshot.rates),6.7133/31.758);
  assert.equal(calls.length,1);
  assert.ok(calls[0].includes('providers=BOC'));
});

test('missing TWD is unavailable even while the USD snapshot is healthy',async()=>{
  const fx=createFxService({now,referenceOnly:true,getReference:async()=>({rates:{USD:7},source:'ECB',observationAt:now(),retrievedAt:now(),date:'2026-09-28'})});
  assert.equal((await fx.getFxSnapshot('TWD')).fxStale,true);
  assert.equal((await fx.getFxSnapshot('USD')).fxStale,false);
});

test('Taiwan parser rejects ADR/wrong currency, dates, ordering, malformed payload and conflicting closing price',()=>{
  const good=parseYahooTwChart(html(),'2330.TW',now());
  assert.equal(good.timestamp.at(-1),1790227800);
  assert.equal(good.meta.chartTimeBasis,'price-point');
  for(const change of [
    c=>c.meta.symbol='TSM',c=>c.meta.currency='USD',c=>c.meta.exchange='NYQ',
    c=>c.meta.exchangeTimezoneName='America/New_York',c=>c.meta.regularMarketTime=now()/1000+60,
    c=>c.timestamp[2]=c.timestamp[1],c=>c.indicators.quote[0].close.pop(),
    c=>c.indicators.quote[0].close[3]='2475',c=>c.meta.regularMarketPrice=999]){
    const chart=structuredClone(pageChart);change(chart);
    assert.throws(()=>parseYahooTwChart(html(chart),'2330.TW',now()));
  }
  assert.throws(()=>parseYahooTwChart(html(),'2330.TW',Date.parse('2026-09-29T03:00:00Z')),{code:'HISTORY_TARGET_DAY_MISSING'});
  assert.throws(()=>parseYahooTwChart(html(),'TSM',now()),{code:'HISTORY_UNSUPPORTED'});
  assert.throws(()=>parseYahooTwChart('<script>root.App.main = {"MarketChartStore":(()=>{throw Error()})()}</script>','2330.TW',now()));
});

test('production path: native provider through source, enrichment, snapshot merge and real panel controller',async t=>{
  let calls=0,primaryCalls=0;
  const taiwan=createYahooTwHistory({now,httpsGet:async()=>{calls++;return {status:200,body:html()};}});
  const source=createHistorySource({taiwan,now,primary:async()=>{primaryCalls++;throw new Error('chart API 429');}});
  const enrich=createChartEnricher({now,fetchChart:source});
  const snapshots=createSnapshotService({now,enrich,fetchBatch:async()=>({quotes:[base()],pollAfterMs:900000})});
  t.after(()=>{snapshots.stop();source.close();});
  snapshots.start();snapshots.getCachedQuote('2330.TW');
  await new Promise(resolve=>setTimeout(resolve,180));
  const quote=snapshots.getCachedQuote('2330.TW');
  assert.equal(quote.regularChart?.status,'ready');
  assert.equal(quote.regularChart.missingReason,null);
  assert.equal(quote.slowFields.intraday.unsupported,undefined);
  assert.equal(calls,1);assert.equal(primaryCalls,0);
  const fx={USD:6.7133,TWD:31.758};
  const converted={...quote,fxMap:fx,fxStale:false,fxKind:'reference',fxSource:'BOC',fxDate:'2026-09-25'};
  const ui=await loadApp({watchlist:['2330.TW'],initialMarket:[converted],fakeObservers:true});
  await ui.drain();
  const card=ui.hooks().cardCache.get('2330.TW');
  assert.equal(card.tf,'intraday');
  assert.ok(card.plot?.bars.length>200,'actual first-open panel must draw prices');
  assert.equal(card.plot.bars.at(-1).c,2475);
  assert.match(card.chartState.textContent,/Yahoo 台股分时/);
  assert.doesNotMatch(card.chartState.textContent,/过期|CHART_SOURCE_STALE|保留旧图/);
  assert.equal(card.cur.textContent,'≈77.93');
  const formatter=ui.sandbox.window.PANEL_FORMAT.createFormatter;
  assert.equal(formatter({data:converted,displayCurrency:'USD'}).money(2475),'≈'+(2475/31.758).toFixed(2));
  assert.equal(formatter({data:converted,displayCurrency:'CNY'}).money(2475),'≈¥'+(2475*6.7133/31.758).toFixed(2));
});

test('regional page retains its own cooldown when the global Yahoo chart API is limited',async t=>{
  const gate=createHostGate({now,minGap:()=>0});t.after(()=>gate.close());
  await gate.run('https://query1.finance.yahoo.com/v8/finance/chart/2330.TW',async()=>({status:429,headers:{'retry-after':'120'}}));
  let calls=0;
  await gate.run('https://tw.stock.yahoo.com/quote/2330.TW',async()=>{calls++;return {status:429,headers:{'retry-after':'60'}};});
  await assert.rejects(gate.run('https://tw.stock.yahoo.com/quote/2330.TW',async()=>{calls++;return {status:200};}),{code:'SOURCE_COOLDOWN'});
  assert.equal(calls,1,'own Retry-After must still be respected');
});

test('minute provider shares work, recovers after source failure and does not leak yesterday into the next trading day',async t=>{
  let time=now(),calls=0,ok=false;
  const taiwan=createYahooTwHistory({now:()=>time,httpsGet:async()=>{calls++;return ok?{status:200,body:html()}:{status:503};}});
  t.after(()=>taiwan.close());
  await assert.rejects(taiwan('2330.TW','?interval=5m&range=1d'));
  await assert.rejects(taiwan('2330.TW','?interval=5m&range=1d'));assert.equal(calls,1);
  time+=61000;ok=true;
  const [a,b]=await Promise.all([taiwan('2330.TW','?interval=5m&range=1d'),taiwan('2330.TW','?interval=5m&range=1d')]);
  assert.deepEqual(a,b);assert.equal(calls,2);
  time=Date.parse('2026-09-29T03:00:00Z');
  await assert.rejects(taiwan('2330.TW','?interval=5m&range=1d'),{code:'HISTORY_TARGET_DAY_MISSING'});
});

test('reference FX rejects mixed dates/providers/expired rates and isolates concurrent currencies',async()=>{
  for(const change of [r=>r[0].date='2026-09-24',r=>r[1].providers[0].key='ECB',r=>r[1].rate=0,r=>r.push(r[0])]){
    const rows=bocRows();change(rows);assert.throws(()=>parseBocRates(JSON.stringify(rows),now()));
  }
  assert.throws(()=>parseBocRates(JSON.stringify(bocRows()),now()+8*86400000));
  const fx=createFxService({now,referenceOnly:true,getReference:async currency=>({rates:currency==='TWD'?{USD:6.7133,TWD:31.758}:{USD:7,JPY:140},source:currency==='TWD'?'BOC':'ECB',observationAt:now(),retrievedAt:now()})});
  const [tw,us]=await Promise.all([fx.getFxSnapshot('TWD'),fx.getFxSnapshot('USD')]);
  assert.equal(tw.fxSource,'BOC');assert.equal(tw.rates.USD,6.7133);
  assert.equal(us.fxSource,'ECB');assert.equal(us.rates.USD,7);
  assert.equal(fx.fxSnapshotFor('TWD').rates.TWD,31.758);
});
