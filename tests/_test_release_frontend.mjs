import assert from 'node:assert/strict';
import { loadApp } from './_harness.mjs';

const env = await loadApp({ watchlist: ['QQQ'] });
await env.drain();
const hooks = env.hooks();
const quote = (extra = {}) => ({
  symbol: 'QQQ', price: 100, change: 1, changePct: 1,
  currency: 'USD', instrumentType: 'ETF', fxStale: false,
  fxMap: { USD: 7 }, marketState: 'CLOSED', ts: Date.now(),
  charts: { intraday: [{ t: 10, c: 100, v: 1 }], daily30: [] },
  ...extra,
});
async function showQuote(extra) {
  env.fetch.push('market', { body: [quote(extra)] });
  await hooks.refresh(false);
  return hooks.cardCache.get('QQQ');
}
await showQuote();
hooks.setCardCurrency('QQQ', 'CNY');
const card = hooks.cardCache.get('QQQ');
assert.match(card.ohlc.innerHTML, /¥700\.00/);
await showQuote({ fxStale: true });
assert.equal(card.unit.textContent, 'USD');
assert.match(card.ohlc.innerHTML, />100\.00</);
assert.doesNotMatch(card.ohlc.innerHTML, /¥700\.00/);
await showQuote({ fxStale: false });
assert.match(card.ohlc.innerHTML, /¥700\.00/);
await showQuote({ currency: 'CNY' });
assert.match(card.ohlc.innerHTML, /¥100\.00/);
await showQuote({ instrumentType: 'INDEX' });
assert.equal(card.unit.textContent, '点');
assert.match(card.ohlc.innerHTML, />100\.00</);
assert.doesNotMatch(card.ohlc.innerHTML, /¥/);
console.log('PASS chart formatting follows FX expiry, recovery, source currency and instrument type');

const input = env.byId('q'), results = env.byId('sresults');
input.value = 'apple';
env.fetch.push('search', { body: [{ symbol: 'AAPL', name: 'Apple', market: 'US', exch: 'N' }] });
await hooks.runSearch();
assert.equal(results.hidden, false);
input.value = 'tesla';
input._handlers.input[0]();
assert.equal(results.hidden, true, 'previous results disappear before debounce expires');
assert.equal(results.innerHTML, '', 'previous options cannot be selected after changing the query');
env.fetch.push('search', { body: [{ symbol: 'TSLA', name: 'Tesla', market: 'US', exch: 'N' }] });
await hooks.runSearch();
assert.equal(results.hidden, false);
assert.match(results.innerHTML, /TSLA/);
assert.doesNotMatch(results.innerHTML, /AAPL/);
console.log('PASS query changes immediately discard old search options');
