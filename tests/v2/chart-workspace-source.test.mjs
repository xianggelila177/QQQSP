import test from 'node:test';
import assert from 'node:assert/strict';
import {createChartDetailService} from '../../lib/chart-detail-service.js';
import {recentRegularSessions} from '../../lib/regular-chart-service.js';

const now=Date.parse('2026-09-23T01:00:00Z'),day=recentRegularSessions('AAOI','2026-09-22',5).at(-1);
const bars=[0,60].map(offset=>({t:day.sessions[0].open_at_ms/1000+offset,o:100,h:102,l:99,c:101,v:20}));
async function fallback(t,metadata){
  let calls=0;
  const quote={symbol:'AAOI',currency:'USD',instrumentType:'EQUITY',regularChart:{tradeDate:day.date,
    source:'fixture-minute-source',bars,regularSessions:day.sessions,pointKind:'bar-start',volumeUnit:'shares',
    sourceCheckedAt:now-60000,...metadata}};
  const service=createChartDetailService({readQuote:()=>quote,now:()=>now,fetchChart:async()=>{calls++;throw Object.assign(new Error('unavailable'),{code:'SOURCE_UNAVAILABLE'});}});
  t.after(()=>service.stop());
  const first=(await service.read('AAOI',{range:'5d',sections:'chart'})).fiveDay;
  const again=(await service.read('AAOI',{range:'5d',sections:'chart'})).fiveDay;
  assert.equal(calls,1,'failed source cooldown/cache behavior is unchanged');
  assert.deepEqual(first.bars,bars);assert.equal(first.coveredDays,1);assert.equal(first.status,'partial');
  assert.equal(first.sourceCheckedAt,null,'fallback is not a successful new five-day source check');
  assert.equal(again.sourceCheckedAt,null);assert.equal(first.reason,'SOURCE_UNAVAILABLE');
  assert.equal(quote.regularChart.sourceCheckedAt,now-60000);
  return first;
}

test('five-day failure preserves explicit minute/five-minute resolution and source adjustment metadata',async t=>{
  for(const [metadata,interval,resolution] of [
    [{intervalSeconds:60,adjustmentBasis:'source-raw',adjustment:'raw'},60,'1m'],
    [{resolution:'1m',adjustment:'source-default-unverified'},60,'1m'],
    [{intervalSeconds:300,adjustmentBasis:'source-adjusted'},300,'5m']]){
    const result=await fallback(t,metadata);assert.equal(result.intervalSeconds,interval);assert.equal(result.resolution,resolution);
    assert.equal(result.adjustmentBasis,metadata.adjustmentBasis??null);assert.equal(result.adjustment,metadata.adjustment??null);
  }
});

test('five-day failure leaves unknown or unsupported intervals unknown instead of claiming five-minute bars',async t=>{
  for(const metadata of [{},{intervalSeconds:120},{resolution:'2m'}]){
    const result=await fallback(t,metadata);assert.equal(result.intervalSeconds,null);assert.equal(result.resolution,null);
  }
});
