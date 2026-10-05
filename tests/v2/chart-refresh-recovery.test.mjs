import test from 'node:test';
import assert from 'node:assert/strict';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {projectRegularBars,regularChartTarget,recentRegularSessions} from '../../lib/regular-chart-service.js';
import {marketStateFor} from '../../mkt.mjs';

const START=Date.parse('2026-10-02T04:00:00Z');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const bar=(date='2026-10-01',c=101)=>({t:Date.parse(date+'T19:55:00Z')/1000,o:c-1,h:c+2,l:c-2,c,v:100});
const raw=(symbol='NVDA',bars=[bar()],source='yahoo')=>({source,
  meta:{symbol,currency:'USD',dataGranularity:'5m',chartTimeBasis:'bar-start',chartIntervalSeconds:300},
  timestamp:bars.map(b=>b.t),indicators:{quote:[Object.fromEntries(
    [['open','o'],['high','h'],['low','l'],['close','c'],['volume','v']].map(([key,k])=>[key,bars.map(b=>b[k])]))]}});
const quote=(clock,symbol='NVDA')=>({symbol,price:105,currency:'USD',instrumentType:symbol.startsWith('^')?'INDEX':'EQUITY',
  marketState:'CLOSED',priceSession:'POST',quoteAt:clock,sourceCheckedAt:clock,src:'fixture'});
function serviceHarness(t,enrich,clock){
  let tick;
  t.mock.method(globalThis,'setInterval',fn=>{tick=fn;return 1;});
  t.mock.method(globalThis,'clearInterval',()=>{});
  t.mock.method(globalThis,'setTimeout',()=>2);
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const service=createSnapshotService({now:clock,sessionFor:()=> 'CLOSED',enrich,
    fetchBatch:async symbols=>({quotes:symbols.map(s=>quote(clock(),s))})});
  t.after(()=>service.stop());service.start();
  return {service,tick:()=>tick()};
}

test('manual source refresh expires the chart TTL and starts bounded closed-market enrichment immediately',async t=>{
  let clock=START,close=101,calls=0;
  const enrich=createChartEnricher({now:()=>clock,includeDaily:false,fetchChart:async()=>{calls++;return raw('NVDA',[bar('2026-10-01',close)]);}});
  const {service}=serviceHarness(t,enrich,()=>clock);
  await service.forceRefresh(['NVDA']);await flush();
  assert.equal(service.getCachedQuote('NVDA').regularChart.bars[0].c,101);
  clock+=1000;close=102;
  await service.forceRefresh(['NVDA']);await flush();
  const value=service.getCachedQuote('NVDA');
  assert.equal(calls,2,'manual refresh must not reuse either the minute cache or 15-minute closed cadence');
  assert.equal(value.regularChart.bars[0].c,102);
  assert.equal(value.regularChart.sourceCheckedAt,clock);
});

test('an old trading day stays visibly stale and retries each minute while the market is closed',async t=>{
  let clock=START,calls=0;
  const enrich=createChartEnricher({now:()=>clock,includeDaily:false,fetchChart:async()=>{calls++;return raw('NVDA',[bar('2026-09-30')]);}});
  const {service,tick}=serviceHarness(t,enrich,()=>clock);
  await service.forceRefresh(['NVDA']);await flush();
  for(let i=0;i<3;i++){
    const value=service.getCachedQuote('NVDA');
    assert.equal(value.regularChart.targetDate,'2026-10-01');
    assert.equal(value.regularChart.tradeDate,'2026-09-30');
    assert.equal(value.regularChart.stale,true);
    assert.equal(value.regularChart.missingReason,'TARGET_DAY_HISTORY_PENDING');
    assert.equal(value.slowFields.intraday.retryable,true);
    assert.equal(service.diagnostics().enrichmentRetries.NVDA.retryAt,clock+60000);
    clock+=60000;tick();await flush();
  }
  assert.equal(calls,4);
});

test('manual refresh failure preserves verified bars and source clock, and recovery clears stale state',async t=>{
  let clock=START,failed=false,close=101;
  const enrich=createChartEnricher({now:()=>clock,includeDaily:false,fetchChart:async()=>{if(failed)throw Error('offline');return raw('NVDA',[bar('2026-10-01',close)]);}});
  const {service}=serviceHarness(t,enrich,()=>clock);
  await service.forceRefresh(['NVDA']);await flush();
  const first=service.getCachedQuote('NVDA');clock+=1000;failed=true;
  await service.forceRefresh(['NVDA']);await flush();
  const retained=service.getCachedQuote('NVDA');
  assert.deepEqual(retained.regularChart.bars,first.regularChart.bars);
  assert.equal(retained.regularChart.sourceCheckedAt,START);
  assert.equal(retained.regularChart.stale,true);
  assert.equal(retained.regularChart.status,'partial');
  assert.equal(retained.price,105);assert.ok(!retained.stale,'chart outage does not invalidate healthy quotes');
  clock+=1000;failed=false;close=102;
  await service.forceRefresh(['NVDA']);await flush();
  const recovered=service.getCachedQuote('NVDA');
  assert.equal(recovered.regularChart.stale,false);
  assert.equal(recovered.regularChart.bars[0].c,102);
  assert.equal(recovered.regularChart.sourceCheckedAt,clock);
});

test('empty projected refresh and rejected enrichment both retain the last chart without renewing its clock',async t=>{
  let clock=START,mode='ready';
  const firstBar=bar();
  const enrich=async()=>{
    if(mode==='reject')throw Error('offline');
    const empty=mode==='empty',meta={source:'yahoo',updatedAt:clock,stale:empty,status:empty?'missing':'ready',retryable:empty};
    return {...quote(clock),charts:{intraday:empty?[]:[firstBar]},slowFields:{intraday:meta},
      regularChart:{status:empty?'unavailable':'ready',stale:empty,source:'yahoo',sourceCheckedAt:empty?null:clock,
        bars:empty?[]:[firstBar],targetDate:'2026-10-01',tradeDate:empty?null:'2026-10-01',missingReason:empty?'REGULAR_HISTORY_NOT_AVAILABLE':null}};
  };
  const {service}=serviceHarness(t,enrich,()=>clock);
  await service.forceRefresh(['NVDA']);await flush();
  for(mode of ['empty','reject']){
    clock+=1000;await service.forceRefresh(['NVDA']);await flush();
    const retained=service.getCachedQuote('NVDA').regularChart;
    assert.equal(retained.bars.length,1);
    assert.equal(retained.tradeDate,'2026-10-01');
    assert.equal(retained.sourceCheckedAt,START);
    assert.equal(retained.stale,true);
    assert.equal(retained.status,'partial');
  }
});

test('manual chart refresh does not bypass a provider retry-after gate',async t=>{
  let clock=START,calls=0;
  const enrich=createChartEnricher({now:()=>clock,includeDaily:false,fetchChart:async()=>{
    calls++;throw Object.assign(Error('rate limited'),{retryAt:START+600000});
  }});
  const {service,tick}=serviceHarness(t,enrich,()=>clock);
  await service.forceRefresh(['NVDA']);await flush();
  clock+=60000;await service.forceRefresh(['NVDA']);tick();await flush();
  assert.equal(calls,1);
  assert.equal(service.diagnostics().enrichmentRetries.NVDA.notBefore,START+600000);
});

test('index history does not discard recent Naver bars while searching for inapplicable share volume',async t=>{
  let calls=0;
  const latest=raw('^IXIC',[{...bar(),v:null}],'naver-index-candles');
  const index=Object.assign(async()=>latest,{supports:()=>true});
  const source=createHistorySource({now:()=>START,index,primary:async()=>{calls++;
    return raw('^IXIC',[bar('2026-09-29'),bar('2026-09-30')],'yahoo');
  }});
  t.after(()=>source.close());
  assert.strictEqual(await source('^IXIC','?interval=5m&range=1d',{instrumentType:'INDEX'}),latest);
  assert.equal(calls,0);
  let alternate=0;
  const enrich=createChartEnricher({now:()=>START,includeDaily:false,fetchChart:source,
    fetchHistoricalChart:async()=>{alternate++;return raw('^IXIC');}});
  const value=await enrich('^IXIC',quote(START,'^IXIC'));
  assert.equal(alternate,0,'no shares volume is normal for an index and must not trigger dated equity fallback');
  assert.equal(value.regularChart.source,'naver-index-candles');
  assert.equal(value.regularChart.stale,false);
  assert.equal(value.regularChart.bars[0].v,null);
});

test('Naver index candle at the close is excluded and its closing-print coverage remains unverified',()=>{
  const bars=[bar(),{...bar(),t:Date.parse('2026-10-01T20:00:00Z')/1000}];
  const chart=projectRegularBars('^IXIC',bars,{source:'naver-index-candles',pointKind:'bar-start',intervalSeconds:300,
    instrumentType:'INDEX',targetDate:'2026-10-01',now:START});
  assert.equal(chart.bars.length,1);
  assert.equal(chart.missingReason,'CLOSING_PRINT_COVERAGE_UNVERIFIED');
  assert.equal(chart.volumeQuality.closingPrintStatus,'unverified');
});

test('SOX candles use cash sessions including DST and half days while quotes retain their publication window',()=>{
  for(const [date,open,close,now] of [
    ['2026-10-01','13:30','20:00','2026-10-01T20:30:00Z'],
    ['2026-11-25','14:30','21:00','2026-11-25T21:30:00Z'],
    ['2026-11-27','14:30','18:00','2026-11-27T18:30:00Z'],
  ]){
    const clock=Date.parse(now),start=Date.parse(`${date}T${open}:00Z`),end=Date.parse(`${date}T${close}:00Z`);
    const target=regularChartTarget('^SOX',clock);
    assert.deepEqual(target.regularSessions,[{open_at_ms:start,close_at_ms:end}]);
    assert.equal(recentRegularSessions('^SOX',date,1)[0].sessions[0].close_at_ms,end);
    const bars=[start,end-300000,end,end+300000].map(at=>({...bar(),t:at/1000}));
    const result=projectRegularBars('^SOX',bars,{source:'naver-index-candles',pointKind:'bar-start',intervalSeconds:300,
      instrumentType:'INDEX',targetDate:date,now:clock});
    assert.deepEqual(result.bars.map(b=>b.t),[start/1000,end/1000-300]);
    assert.equal(marketStateFor('^SOX',null,clock),date==='2026-11-27'?'UNKNOWN':'REGULAR',
      'index quotation retains its independent after-close publication policy');
  }
  assert.equal(regularChartTarget('^SOX',Date.parse('2026-11-30T12:00:00Z')).targetDate,'2026-11-27');
});
