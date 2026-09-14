import assert from 'node:assert/strict';
import { loadApp } from './_harness.mjs';

const env = await loadApp({ watchlist: ['QQQ'], hidden: true, fakeWorker: true, refreshMode:'continuous',initialMarket:[{symbol:'QQQ',pending:true}] });
await env.drain();
const h = env.hooks();
assert.equal(h.beat.hidEvery, 2);
assert.equal(h.beat.visEvery, 2);
assert.equal(h.beat.newsEvery, 60);
const market0 = env.countFetch('/api/market'), news0 = env.countFetch('/api/news');
for(let i=0;i<30;i++)env.fetch.push('market',{body:[{symbol:'QQQ',pending:true}]});
for (let i = 0; i < 60; i++) { h.onBeat(); await env.drain(); }
assert.equal(env.countFetch('/api/market') - market0, 30);
assert.equal(env.countFetch('/api/news') - news0, 1);
console.log('PASS hidden heartbeat polls snapshots every 2s and news every 60s');

env.fetch.push('market', { body: [{ symbol: 'QQQ', pending: true, error: 'pending' }] });
const initial = await h.refresh(false);
const q = h.cardCache.get('QQQ');
assert.equal(initial.pending, true);
assert.equal(initial.partial, false);
assert.equal(q.retryBtn.hidden, true);
assert.equal(q.el.classList.contains('fetch-error'), false);
assert.equal(q.state.textContent, '等待报价');
console.log('PASS first pending snapshot does not show a failure or retry button');

const at = Date.now() - 120000;
const quote = { symbol: 'QQQ', price: 100, currency: 'USD', marketState: 'CLOSED',
  quoteAt: Math.floor(at / 1000), sourceCheckedAt: Date.now(), pollAfterMs: 70000,
  feedDelayMinutes: 15, src: 'naver-us', charts: { intraday: [{ t: Math.floor(at / 1000), c: 100 }] } };
env.fetch.push('market', { body: [quote] });
await h.refresh(false);
assert.match((q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||''), /Naver 美股/);
assert.match((q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||''), /源延迟 15 分钟/);
assert.match((q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||''), /已休市/);
assert.match(q.quoteMeta.title, /70 秒/);
const charts = q.d.charts, count = env.fetchLog.length, oldMeta = (q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||'');
h.updateQuoteMeta(q, Date.now() + 120000);
assert.notEqual((q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||''), oldMeta);
assert.equal(env.fetchLog.length, count);
assert.equal(q.d.charts, charts);
env.fetch.push('market', { body: [{ ...quote, price: 101, charts: undefined }] });
await h.refresh(false);
assert.equal(q.d.charts, charts);
env.fetch.push('market', { body: [{ symbol: 'QQQ', pending: true }] });
await h.refresh(false);
assert.equal(q.d.price, 101);
assert.equal(q.d.charts, charts);
assert.equal(h.lastDataRef().length, 1);
for (const [src, label] of [['naver-kr', 'Naver 韩股'], ['tx-batch', '腾讯批量报价']]) {
  q.d.src = src; h.updateQuoteMeta(q); assert.ok(((q.quoteDetails?.textContent||'')+(q.quoteAge?.textContent||'')+(q.sourceCheckAge?.textContent||'')).includes(label));
}
console.log('PASS quote age uses source timestamp, metadata updates without requests, snapshots preserve charts');

const fallback = await loadApp({ watchlist: ['QQQ'], hidden: true, refreshMode:'continuous' });
await fallback.drain();
const before = fallback.countFetch('/api/market');
for (let i = 0; i < 2; i++) {
  for (const timer of fallback.timers.intervals(1000)) timer.fn();
  await fallback.drain();
}
assert.equal(fallback.countFetch('/api/market'), before + 1);
console.log('PASS interval fallback attempts 2s polling in a runnable hidden tab');
const current=Date.now();
assert.equal(env.hooks().quoteIsStale({marketState:'CLOSED',quoteAt:current-86400000,fetchedAt:current-45000,pollAfterMs:70000},current),false,'closed70s provider must not show a false delay at30s');
assert.equal(env.hooks().quoteIsStale({marketState:'REGULAR',quoteAt:current-45000,fetchedAt:current-45000,pollAfterMs:70000},current),false,'active quote follows actual advertised provider cadence');
assert.equal(env.hooks().quoteIsStale({marketState:'REGULAR',quoteAt:current-90000,fetchedAt:current,pollAfterMs:70000},current),true,'active trade becomes overdue after cadence budget');
console.log('PASS provider hint controls check-age budget, active quote timestamp remains authoritative');
