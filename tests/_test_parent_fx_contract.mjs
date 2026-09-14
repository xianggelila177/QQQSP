import assert from 'node:assert/strict';
import { loadApp } from './_harness.mjs';
const env = await loadApp();
await env.drain();
const now = Date.now();
const base = { instrumentType: 'EQUITY', currency: 'USD', price: 100, change: 1, changePct: 1, marketState: 'CLOSED', ts: now, quoteAt: now, charts: { intraday: [], daily30: [] }, fxAsOf: now, fxStale: false };
env.fetch.push('market', { body: [
  { ...base, symbol: 'QQQ', fxMap: { USD: 7, KRW: 1400 }, currency2cny: 7 },
  { ...base, symbol: 'SPY', currency: 'KRW', price: 200000, fxMap: { USD: 7, KRW: 1400 }, currency2cny: 0.005, charts: { intraday: [{t:1,c:180000,v:1},{t:2,c:200000,v:1}], daily30: [] } },
] });
await env.hooks().refresh(false);
const card = env.hooks().cardCache.get('SPY');
assert.equal(card.cur.textContent, '142.86', 'KRW per USD must not be overwritten by KRW-to-CNY rate');
assert.equal(card.unit.textContent, 'USD');
assert.match(card.ohlc.innerHTML, /\+14\.29/, 'chart delta must use the same display currency as its price');
env.hooks().setCardCurrency('SPY', 'CNY');
assert.equal(card.cur.textContent, '¥1,000.00');
assert.match(card.ohlc.innerHTML, /\+¥100\.00/);
assert.match(card.strip.querySelector('.tp').textContent, /CNY/);
console.log('PASS parent FX cross-rate contract');
