import assert from 'node:assert/strict';
import { createSnapshotService } from '../lib/snapshot-service.js';
const timers = new Map(); let id = 0;
const originals = { setTimeout, clearTimeout, setInterval, clearInterval };
globalThis.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms, once: true }); return id; };
globalThis.setInterval = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
globalThis.clearTimeout = globalThis.clearInterval = key => timers.delete(key);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fire = async ms => {
  for (const [key, timer] of [...timers]) if (timer.ms === ms) { if (timer.once) timers.delete(key); timer.fn(); }
  await flush();
};
let time = 1788600000000, calls = [], mode = 'ok', releaseHistory;
let historyCalls = 0, releaseBatch;
const symbols = Array.from({ length: 12 }, (_, i) => 'STOCK' + i);
const service = createSnapshotService({ now: () => time, enrich: () => { historyCalls++; return new Promise(resolve => { releaseHistory = resolve; }); }, fetchBatch: async (syms, { group }) => {
  calls.push({ syms, group });
  if (mode === 'hang') return new Promise(resolve => { releaseBatch = resolve; });
  if (mode === '429') throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 30000 });
  return { quotes: syms.filter((s, i) => mode !== 'partial' || i !== 0).map(symbol => ({ symbol, price: 100 + calls.length, quoteAt: time, currency: 'USD' })), pollAfterMs: mode === 'closed' ? 70000 : 2000 };
} });
try {
  assert.equal(timers.size, 0);
  service.start(); service.start();
  for (const symbol of symbols) assert.equal(service.getCachedQuote(symbol).pending, true);
  await fire(100);
  assert.equal(calls.length, 1); assert.equal(calls[0].syms.length, 12);
  assert.equal(service.getCachedQuote(symbols[0]).price, 101);
  assert.equal(historyCalls, 2, 'hung enrichment remains bounded at two actual jobs');
  console.log('PASS twelve symbols share one batch; slow history cannot block snapshots');
  time += 2000; mode = 'partial'; await fire(2000);
  assert.equal(service.getCachedQuote(symbols[0]).stale, true);
  assert.equal(service.getCachedQuote(symbols[1]).price, 102);
  assert.equal(historyCalls, 2);
  mode = 'closed'; time += 2000; await fire(2000); const closedCalls = calls.length;
  time += 2000; await fire(2000); assert.equal(calls.length, closedCalls);
  time += 68000; mode = '429'; await fire(2000); const rateCalls = calls.length;
  time += 2000; await fire(2000); assert.equal(calls.length, rateCalls);
  assert.equal(service.getCachedQuote(symbols[0]).staleInfo.reason, 'rate-limited');
  console.log('PASS partial failures preserve siblings; provider intervals and429backoff respected');
  time += 28000; mode = 'hang'; await fire(2000); const hangCalls = calls.length;
  time += 2000; await fire(2000); assert.equal(calls.length, hangCalls, 'no overlapping batches');
  service.stop(); assert.equal(timers.size, 0);
  releaseBatch({ quotes: [{ symbol: symbols[0], price: 999, quoteAt: time }] });
  releaseHistory({ symbol: symbols[1], price: 1, quoteAt: time - 50000 }); await flush();
  assert.notEqual(service.getCachedQuote(symbols[0]).price, 999, 'late stopped results cannot mutate cache');
  console.log('PASS bounded nonoverlap and stopped generation rejects late writes');
  time += 300001; service.getCachedQuote('FRESH'); assert.equal(service.diagnostics().active, 1);
} finally { service.stop(); Object.assign(globalThis, originals); }

// Rich history may populate charts, but must not roll a successful fast quote back.
const rich = createSnapshotService({ fetchBatch: async () => ({ quotes: [{symbol:'QQQ',price:200,quoteAt:Date.now()}],pollAfterMs:2000 }), enrich: async () => ({symbol:'QQQ',price:100,quoteAt:Date.now()-60000,charts:{daily30:[{t:1,c:1}],intraday:[]}}) });
try {
  rich.start(); rich.getCachedQuote('QQQ');
  await new Promise(resolve => setTimeout(resolve, 150));
  const quote = rich.getCachedQuote('QQQ');
  assert.equal(quote.price, 200); assert.equal(quote.charts.daily30.length, 1);
  console.log('PASS enrichment retains charts without replacing newer prices');
} finally { rich.stop(); }
const partitions = [];
const grouped = createSnapshotService({ fetchBatch: async (syms, options) => {
  partitions.push({ group: options.group, symbols: syms });
  return { quotes: syms.map(symbol => ({ symbol, price: 1, quoteAt: Date.now() })), pollAfterMs: 2000 };
} });
try {
  grouped.start();
  for (const symbol of ['QQQ','BRK-B','005930.KS','247540.KQ','7203.T','000001.SS']) grouped.getCachedQuote(symbol);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(partitions.find(p => p.group === 'us').symbols, ['QQQ','BRK-B']);
  assert.deepEqual(partitions.find(p => p.group === 'kr').symbols, ['005930.KS','247540.KQ']);
  assert.deepEqual(partitions.find(p => p.group === 'other').symbols, ['000001.SS']);
  for (let i=0;i<300;i++) grouped.getCachedQuote('CAP'+i);
  assert.equal(grouped.diagnostics().active, 200);
  assert.equal(grouped.getCachedQuote('OVERFLOW').code, 'CAPACITY_EXCEEDED');
  console.log('PASS market partition and global active-symbol capacity');
} finally { grouped.stop(); }
let coldNow = Date.now(), coldMode = 'ok';
const coldCalls = [];
const cold = createSnapshotService({ now: () => coldNow, fetchBatch: async syms => {
  coldCalls.push(syms);
  if (coldMode === '429') throw Object.assign(new Error('cooldown'), { status:429, retryAfterMs:30000 });
  return { quotes: syms.map(symbol => ({ symbol, price:1, quoteAt:coldNow })), pollAfterMs:70000 };
} });
try {
  cold.start(); cold.getCachedQuote('FIRST');
  await new Promise(resolve => setTimeout(resolve, 150));
  coldNow += 100; cold.getCachedQuote('SECOND');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(coldCalls, [['FIRST'], ['SECOND']], 'new symbol must not wait70seconds or repoll existing symbol');
  coldMode='429'; coldNow += 100; cold.getCachedQuote('THIRD');
  await new Promise(resolve => setTimeout(resolve, 150));
  coldNow += 100; cold.getCachedQuote('FOURTH');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(coldCalls, [['FIRST'], ['SECOND'], ['THIRD']], 'new registrations cannot bypass group429cooldown');
  console.log('PASS cold new symbols bypass only successful existing-symbol intervals, never429backoff');
} finally { cold.stop(); }
