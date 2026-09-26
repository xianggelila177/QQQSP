import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseTwseStockDay,createTwseHistory} from '../../lib/providers/twse-history.js';
import {parseTwseQuote,createTwseQuotes} from '../../lib/providers/twse-quotes.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createHistoryService} from '../../lib/history-service.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {providerCapabilities} from '../../lib/instruments.js';
import {marketStateFor} from '../../mkt.mjs';

// Full official responses captured on the production host on 2026-09-25.
const fixture=JSON.parse(readFileSync(new URL('./twse-2330-fixture.json',import.meta.url),'utf8'));
const checkedAt=Date.parse('2026-09-25T08:20:24Z');
const clock=()=>checkedAt;
const monthRows=parseTwseStockDay(fixture.daily,'2330.TW','2026-09');

test('TWSE daily uses ROC dates, OHLC and source scope without inventing regular-only volume',()=>{
  assert.equal(monthRows.length,18);
  assert.deepEqual(monthRows.slice(-2).map(row=>[row.date,row.o,row.h,row.l,row.c]),[
    ['2026-09-23',2475,2505,2475,2500],['2026-09-24',2480,2490,2470,2475]]);
  assert.equal(monthRows.find(row=>row.date==='2026-09-16').c,2380,'X0.00 does not determine OHLC');
  const empty=structuredClone(fixture.daily);empty.data[0][3]='-';
  assert.equal(parseTwseStockDay(empty,'2330.TW','2026-09').length,17);
  assert.throws(()=>parseTwseStockDay(fixture.daily,'0050.TW','2026-09'),{code:'HISTORY_UNSUPPORTED'});
  assert.throws(()=>parseTwseStockDay(fixture.daily,'2330.TW','2026-08'),{code:'HISTORY_IDENTITY_CONFLICT'});
});

test('TWSE quote uses 13:30 last trade, dated 9/23 close and 9/25 holiday state',()=>{
  const quote=parseTwseQuote(fixture.quote,'2330.TW',{now:checkedAt,previous:monthRows.at(-2),bars:monthRows});
  assert.equal(quote.price,2475);assert.equal(quote.currency,'TWD');assert.equal(quote.src,'twse-mis');
  assert.equal(quote.quoteAt,Date.parse('2026-09-24T13:30:00+08:00'));
  assert.notEqual(quote.quoteAt,Number(fixture.quote.msgArray[0].tlong));
  assert.equal(quote.quoteTimePrecision,'second');assert.equal(quote.quoteTimeBasis,'mis-trade.t');
  assert.equal(quote.prevClose,2500);assert.equal(quote.previousCloseTradeDate,'2026-09-23');
  assert.equal(quote.changePct,-1);assert.equal(quote.referencePrice,2500);
  assert.equal(quote.marketState,'HOLIDAY');assert.equal(marketStateFor('2330.TW',null,checkedAt),'HOLIDAY');
  assert.equal(quote.volume,null);assert.equal(quote.feedDelayMinutes,null);
  assert.equal(quote.charts.intraday.length,0);assert.equal(quote.slowFields.intraday.status,'no-history');
  assert.equal(quote.charts.daily30.at(-1).v,null);
  assert.ok(quote.pollAfterMs>=900000,'holiday polling is slower than userDelay');
  const noTrade=structuredClone(fixture.quote);noTrade.msgArray[0].z='-';noTrade.msgArray[0].trade.z='-';
  assert.throws(()=>parseTwseQuote(noTrade,'2330.TW',{now:checkedAt}),{code:'NO_QUOTE'});
  const mismatch=structuredClone(fixture.quote);mismatch.msgArray[0].ch='0050.tw';
  assert.throws(()=>parseTwseQuote(mismatch,'2330.TW',{now:checkedAt}),{code:'QUOTE_IDENTITY_CONFLICT'});
});

test('official TWSE quote and daily route around a Yahoo 429 with honest history coverage',async t=>{
  const calls=[];
  const httpsGet=async url=>{
    calls.push(url);
    if(url.includes('/STOCK_DAY'))return {status:200,headers:{},body:JSON.stringify(fixture.daily)};
    if(url.includes('/getStockInfo.jsp'))return {status:200,headers:{},body:JSON.stringify(fixture.quote)};
    throw new Error('unexpected source '+url);
  };
  const daily=createTwseHistory({httpsGet,now:clock,maxMonths:1});
  const quotes=createTwseQuotes({httpsGet,daily,now:clock});
  const legacy={tencent:async()=>{throw new Error('Tencent must not serve Taiwan');},fetchSnapshotBatch:async()=>{throw new Error('Naver must not serve Taiwan');}};
  const polling=createFastPolling({httpsGet,legacy,twseQuotes:quotes,now:clock,pollMs:1000});
  const source=createHistorySource({twse:daily,primary:async()=>{throw Object.assign(new Error('Yahoo 429'),{status:429});},now:clock});
  t.after(()=>{polling.reset();source.close();});
  assert.equal(providerCapabilities('2330.TW').batchGroup,'tw');
  assert.equal(providerCapabilities('0050.TW').batchGroup,null,'unknown TWSE listing is not guessed');
  const snapshot=await polling.fetchSnapshotBatch(['2330.TW'],{group:'tw'});
  assert.equal(snapshot.quotes[0].price,2475);
  assert.equal(snapshot.quotes[0].prevClose,2500);
  assert.ok(snapshot.nextPollAtBySymbol['2330.TW']>=checkedAt+900000);
  const chart=await source('2330.TW','?interval=1d&range=2y');
  assert.equal(chart.source,'twse-stock-day');assert.equal(chart.meta.currency,'TWD');
  assert.ok(chart.retrievalLimited);assert.equal(chart.meta.sourceVolumeUnit,'shares');
  assert.ok(chart.indicators.quote[0].volume.every(value=>value===null));
  assert.equal(calls.filter(url=>url.includes('/STOCK_DAY')).length,1,'quote and history reuse monthly data');
  assert.equal(calls.filter(url=>url.includes('yahoo')).length,0);
  const history=createHistoryService({fetchChart:source,now:clock});t.after(()=>history.close());
  const result=await history.get('2330.TW','daily',{count:2});
  assert.equal(result.sessionScope,'source-mixed-sessions');
  assert.equal(result.sourceCurrency,'TWD');assert.equal(result.priceScale,1);
  assert.deepEqual(result.bars.map(bar=>bar.c),[2500,2475]);
  assert.equal(result.volumeUnit,'source-unit-unverified');
  assert.equal(result.bars.at(-1).v,null);assert.equal(result.hasMore,true);
  for(const period of ['weekly','monthly','yearly']){
    const aggregated=await history.get('2330.TW',period,{count:1,cacheOnly:true});
    assert.equal(aggregated.seriesId,result.seriesId);
    assert.equal(aggregated.currency,'TWD');
    assert.equal(aggregated.bars.at(-1).c,2475);
    assert.equal(aggregated.bars.at(-1).v,null);
  }
});

test('MIS 429 Retry-After cools the TWSE poll slot',async()=>{
  let calls=0;
  const httpsGet=async()=>{calls++;return {status:429,headers:{'retry-after':'120'},body:''};};
  const daily=createTwseHistory({httpsGet,now:clock});
  const quotes=createTwseQuotes({httpsGet,daily,now:clock});
  const polling=createFastPolling({httpsGet,legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})},twseQuotes:quotes,now:clock,pollMs:1000});
  const first=await polling.fetchSnapshotBatch(['2330.TW'],{group:'tw'});
  const second=await polling.fetchSnapshotBatch(['2330.TW'],{group:'tw'});
  assert.equal(first.quotes.length,0);assert.equal(second.quotes.length,0);
  assert.equal(calls,1);assert.ok(first.nextPollAtBySymbol['2330.TW']>=checkedAt+120000);
  polling.reset();daily.close();
});

test('TWSE yearly continuation shifts the bounded monthly window before the cursor',async()=>{
  const makeYear=(year,close)=>({stat:'OK',date:`${year}1201`,title:`${year-1911}年12月 2330 台積電 各日成交資訊`,fields:fixture.daily.fields,
    data:[ [`${year-1911}/12/30`,'1,000','2,000',String(close-5),String(close+5),String(close-10),String(close),'+5','1',''] ]});
  const payloads={'202609':fixture.daily,'202512':makeYear(2025,2000),'202412':makeYear(2024,1800)};
  const fetched=[];
  const daily=createTwseHistory({now:clock,maxMonths:1,minBars:1,httpsGet:async url=>{
    const month=new URL(url).searchParams.get('date').slice(0,6);fetched.push(month);
    return {status:200,headers:{},body:JSON.stringify(payloads[month])};
  }});
  try{
    const query='?interval=1d&period1='+Math.floor(Date.parse('2023-01-01T00:00:00Z')/1000);
    const current=await daily('2330.TW',query);
    const older=await daily('2330.TW',query,{pageBefore:'2026-01-01'});
    const oldest=await daily('2330.TW',query,{pageBefore:'2025-01-01'});
    assert.deepEqual(fetched,['202609','202512','202412']);
    assert.deepEqual([current,older,oldest].map(data=>data.indicators.quote[0].close.at(-1)),[2475,2000,1800]);
    assert.deepEqual([older.coverage.pageBefore,oldest.coverage.pageBefore],['2026-01-01','2025-01-01']);
    assert.ok([current,older,oldest].every(data=>data.retrievalLimited&&data.hasMore));
  }finally{daily.close();}
});
