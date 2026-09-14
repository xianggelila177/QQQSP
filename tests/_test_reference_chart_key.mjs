import assert from 'node:assert/strict';
import { loadApp } from './_harness.mjs';

const env = await loadApp({ watchlist: ['QQQ', 'SPY'] });
await env.drain();
const hooks = env.hooks();
hooks.setCardCurrency('QQQ', 'CNY');

const quoteAt = Date.now();
const quote = (symbol, usdCny, fxKind = 'reference') => ({
  symbol, price: 100, currency: 'USD', marketState: 'CLOSED', src: 'fixture',
  quoteAt, fxKind, fxDate: '2026-09-04', fxStale: false,
  fxMap: { USD: usdCny, JPY: 150, KRW: 1400, HKD: 7.8 },
  intradayVer: 1,
  charts: { intraday: [{ t: quoteAt / 1000, c: 100, v: 1 }] },
});
// The last card keeps the aggregate FX map unchanged. The live card must still
// redraw using its own rates while its chart data/version remain unchanged.
const recovery = {
  ...quote('SPY', 6), recovery: true, stale: true, fxStale: true,
  staleInfo: { reason: 'offline-cache' },
};
async function refresh(usdCny, fxKind = 'reference') {
  env.fetch.push('market', { body: [quote('QQQ', usdCny, fxKind), recovery] });
  await hooks.refresh(false);
}

await refresh(7);
const card = hooks.cardCache.get('QQQ');
assert.equal(card.cur.textContent, '≈¥700.00');
const bars = card.d.charts.intraday;
let draws = 0;
const labels = [];
card.cv.getContext().clearRect = () => { draws++; };
card.cv.getContext().fillText = text => { labels.push(String(text)); };

await refresh(8);
assert.equal(card.d.charts.intraday, bars, 'unchanged chart version reuses its bars');
assert.equal(card.cur.textContent, '≈¥800.00');
assert.ok(draws > 0, 'changed per-card rates must redraw the chart');
assert.ok(labels.includes('≈¥800.00'), 'chart price label must use the new reference rate');

draws = 0;
labels.length = 0;
await refresh(8, 'market');
assert.equal(card.d.charts.intraday, bars);
assert.equal(card.cur.textContent, '¥800.00');
assert.equal(card.fxNote.hidden, true);
assert.ok(draws > 0, 'switching to market FX must redraw even when rates match');
assert.ok(labels.includes('¥800.00'), 'chart price label must drop the reference marker');
assert.equal(labels.some(label => label.includes('≈')), false);

console.log('PASS per-card FX changes and reference-to-market transitions invalidate chart formatting');
