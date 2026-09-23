import test from 'node:test';
import assert from 'node:assert/strict';
import {regularChartTarget,projectRegularBars,chartPreviousClose} from '../../lib/regular-chart-service.js';

const t=text=>Date.parse(text);
test('premarket targets the completed day and after-hours keeps the just closed session',()=>{
  assert.equal(regularChartTarget('AAOI',t('2026-09-23T12:00:00Z')).targetDate,'2026-09-22');
  assert.equal(regularChartTarget('AAOI',t('2026-09-22T20:05:00Z')).targetDate,'2026-09-22');
  assert.equal(regularChartTarget('AAOI',t('2026-09-22T15:28:00Z')).targetDate,'2026-09-22');
});

test('regular price points retain a real close point but exclude adjacent extended prints',()=>{
  const now=t('2026-09-23T01:00:00Z');
  const bars=[['2026-09-22T13:29:00Z',99],['2026-09-22T13:30:00Z',100],
    ['2026-09-22T19:59:00Z',101],['2026-09-22T20:00:00Z',102],
    ['2026-09-22T20:01:00Z',103]].map(([time,c])=>({t:t(time)/1000,c,v:null}));
  const points=projectRegularBars('AAOI',bars,{source:'nasdaq-intraday',pointKind:'price-point',
    targetDate:'2026-09-22',now});
  assert.deepEqual(points.bars.map(b=>b.c),[100,101,102]);
  assert.equal(points.volumeQuality.status,'missing');
  const intervals=projectRegularBars('AAOI',bars,{source:'yahoo',pointKind:'bar-start',
    targetDate:'2026-09-22',now});
  assert.deepEqual(intervals.bars.map(b=>b.c),[100,101]);
});

test('chart reference uses its own trade date during the following premarket',()=>{
  const ref=chartPreviousClose({symbol:'AAOI',src:'naver-us',priceSession:'PRE',
    quoteTradeDate:'2026-09-22',regularQuoteAt:t('2026-09-21T20:00:00Z'),
    providerPrevClose:105.17,prevClose:108.67,previousCloseTradeDate:'2026-09-21'},'2026-09-21');
  assert.equal(ref.value,105.17);
  assert.equal(ref.tradeDate,'2026-09-18');
});
