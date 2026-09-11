// Domain behavior regressions for Q07-Q17/Q36. All upstream calls are deterministic.
import assert from 'node:assert/strict';
process.env.PORT = '0';
import { barsFrom, createYahooService } from '../lib/yahoo.js';
import { initNews, requestNews, newsFor, __impl, activeSyms } from '../lib/news.js';
import { createQuoteService } from '../lib/quote.js';
import { marketStateFor, marketCalendarInfo } from '../mkt.mjs';
import { sentiOf } from '../sent.mjs';

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { console.log('FAIL', name, '|', e.message); throw e; }
}

await check('Q07 preserves valid wide OHLC candles', () => {
  const [b] = barsFrom({ timestamp: [1], indicators: { quote: [{ open: [100], high: [120], low: [90], close: [105], volume: [1] }] } });
  assert.deepEqual(b, { t: 1, o: 100, h: 120, l: 90, c: 105, v: 1 });
});

await check('Q08 uses Japan 12:30-15:30 session', () => {
  const t = Date.parse('2026-09-04T15:15:00+09:00');
  assert.equal(marketStateFor('7203.T', 9 * 3600, t), 'REGULAR');
});

await check('Q08 honors verified 2026 closures and reports unknown years', () => {
  assert.equal(marketStateFor('QQQ', null, Date.parse('2026-11-26T15:00:00-05:00')), 'CLOSED');
  assert.equal(marketStateFor('QQQ', null, Date.parse('2026-09-07T10:00:00-04:00')), 'CLOSED');
  assert.equal(marketStateFor('QQQ', null, Date.parse('2026-11-27T13:30:00-05:00')), 'UNKNOWN');
  assert.equal(marketStateFor('QQQ', null, Date.parse('2026-11-27T12:30:00-05:00')), 'REGULAR');
  assert.equal(marketStateFor('SPY.AM', null, Date.parse('2026-11-27T13:30:00-05:00'), 'NYSE Arca'), 'POST');
  assert.equal(marketStateFor('0700.HK', null, Date.parse('2026-12-24T12:05:00+08:00')), 'AUCTION');
  assert.equal(marketStateFor('0700.HK', null, Date.parse('2026-12-24T12:15:00+08:00')), 'CLOSED');
  const sh = marketCalendarInfo('000001.SS', Date.parse('2026-10-02T10:00:00+08:00'));
  assert.equal(sh.closed, true);
  assert.equal(sh.known, true);
  assert.equal(marketCalendarInfo('005930.KS', Date.parse('2026-09-24T10:00:00+09:00')).closed, true);
  assert.equal(marketStateFor('005930.KS', null, Date.parse('2026-07-17T10:00:00+09:00')), 'CLOSED');
  assert.equal(marketCalendarInfo('QQQ', Date.parse('2027-01-04T10:00:00-05:00')).known, false);
});

await check('Q12 does not classify dividend hike as macro tightening', () => {
  assert.equal(sentiOf('Company announces dividend hike'), '利好');
});

await check('Quote integrity leaves change null without a previous close', async () => {
  const service=createQuoteService({extSessions:()=>({pre:null,post:null,reg:null,regClose:null,preOpen:null}),providers:{
    fetchChart: async () => ({ meta: { symbol: 'QQQ', currency: 'USD', instrumentType: 'ETF', gmtoffset: -14400, regularMarketPrice: 100 }, timestamp: [], indicators: { quote: [{}] } }),
    getDayOhlc: async () => ({ open: null, high: null, low: null, prevClose: null }),
    getFxRates: async () => ({ USD: 7 }), getNasdaqDaily: async () => [], getYahooDaily: async () => [], cnSnapshot: async () => null,
  }});
  const q = await service.fetchQuote('QQQ');
  assert.equal(q.prevClose, null);
  assert.equal(q.change, null);
  assert.equal(q.changePct, null);
});

await check('Q03 returns no fictional FX values on a cold all-failure', async () => {
  let calls=0;
  const service=createYahooService({getCrumb:async()=>({crumb:'x',cookie:'c'}),clearCrumb(){},yahoo429Hit(){},clear429Streak(){},getSinaDaily:async()=>[],chartOverride:async()=>{throw new Error('offline');},httpsGet:async()=>{calls++;throw new Error('offline');}});
  assert.deepEqual(await service.getFxRates(),{});assert.ok(calls>0);

});

await check('Q10 includes history length in Tencent cache key', async () => {
  const { txDailyBarsCn, initTx } = await import('../lib/providers/tx.js');
  const { __upstream } = await import('../lib/transport.js');
  const seen = [];
  initTx({ cacheSet(m, k, v) { m.set(k, v); } });
  __upstream.impl = async (url) => {
    seen.push(String(url));
    const row = ['2026-09-01', '1', '1', '1', '1', '1'];
    return { status: 200, headers: {}, body: JSON.stringify({ data: { sh000001: { day: [row] } } }) };
  };
  await txDailyBarsCn('000001.SS', 30);
  await txDailyBarsCn('000001.SS', 130);
  __upstream.impl = null;
  assert.equal(seen.length, 2);
  assert.match(seen[0], /,30,qfq/);
  assert.match(seen[1], /,130,qfq/);
});

await check('Q32 converts Tencent cumulative minute volume to deltas', async () => {
  const { txMinuteBarsCn, initTx } = await import('../lib/providers/tx.js');
  const { __upstream } = await import('../lib/transport.js');
  initTx({ cacheSet(m, k, v) { m.set(k, v); } });
  __upstream.impl = async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: { sh000001: { data: { date: '20260903', data: ['0930 10 100', '0931 11 150'] } } } }) });
  const bars = await txMinuteBarsCn('000001.SS');
  __upstream.impl = null;
  assert.deepEqual(bars.map(x => x.v), [100, 50]);
  assert.equal(bars[1].vMode, 'delta');
});

await check('Q16 requestNews shares one cold single-flight and returns freshness', async () => {
  const cache = new Map(); let calls = 0;
  initNews({ newsCache: cache, yahooNews: async () => [], cacheSet(m, k, v) { m.set(k, v); } });
  __impl.newsFor = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return [{ t: Date.now(), title: 'x', tickers: ['AAPL'] }]; };
  activeSyms.clear();
  const [a, b] = await Promise.all([requestNews('AAPL'), requestNews('AAPL')]);
  assert.equal(calls, 1);
  assert.equal(a.items.length, 1);
  assert.equal(a.updatedAt > 0, true);
  assert.equal(a.stale, false);
  assert.deepEqual(a.items, b.items);
});

await check('Q11 keeps SSE index news separate from same-code SZ stock news', async () => {
  initNews({ newsCache: new Map(), yahooNews: async () => [
    { t: 1, title: 'index', link: 'https://example.test/i', tickers: ['^SSEC'] },
    { t: 2, title: 'stock', link: 'https://example.test/s', tickers: ['000001.SZ'] },
  ], cacheSet(m, k, v) { m.set(k, v); } });
  const items = await newsFor('000001.SS');
  assert.deepEqual(items.map(x => x.title), ['index']);
});

await check('Q16 failed news is cooled and does not loop on every request', async () => {
  const cache = new Map(); let calls = 0;
  initNews({ newsCache: cache, yahooNews: async () => [], cacheSet(m, k, v) { m.set(k, v); } });
  __impl.newsFor = async () => { calls++; throw new Error('offline'); };
  const a = await requestNews('BAD');
  const b = await requestNews('BAD');
  assert.equal(calls, 1);
  assert.equal(a.stale, true);
  assert.equal(b.error, 'offline');
});

await check('Q17 Yahoo queue rejects saturated work within its bound', async () => {
  const { yGated, QueueLimitError } = await import('../lib/yahoo.js');
  const hold = yGated(() => new Promise(resolve => setTimeout(resolve, 150)), { deadlineMs: 100 });
  const queued = [];
  for (let i = 0; i < 64; i++) queued.push(yGated(() => Promise.resolve(i), { deadlineMs: 20 }));
  await assert.rejects(yGated(() => Promise.resolve(65), { deadlineMs: 20 }), QueueLimitError);
  await Promise.allSettled([hold, ...queued]);
});

await check('Q15 cold-start breaker blocks a second request after first 429', async () => {
  const S = await import('../server.js');
  S.__test.resetState(); S.__test.seedCrumb();
  let charts = 0;
  S.__upstream.impl = async url => {
    if (String(url).includes('/v8/finance/chart/')) { charts++; return { status: 429, headers: {}, body: 'rate limited' }; }
    throw new Error('offline');
  };
  await assert.rejects(S.__deps.getCachedQuote('QQQ'));
  await assert.rejects(S.__deps.getCachedQuote('QQQ'));
  S.__upstream.impl = null;
  assert.equal(charts, 1);
});

console.log(`RESULT: ${pass} pass`);
process.exit(0);
