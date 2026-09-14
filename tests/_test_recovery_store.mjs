import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { createRecoveryStore } from '../lib/recovery-store.js';

const now = 1_700_000_000_000;
const mkQuote = (symbol = '7203.T', patch = {}) => ({
  symbol,
  market: 'JP',
  name: 'Toyota Motor',
  displayName: 'Toyota',
  exchangeName: 'Tokyo Stock Exchange',
  currency: 'JPY',
  instrumentType: 'EQUITY',
  instrumentTypeSource: 'test',
  gmtoff: 32400,
  price: 2_500,
  prevClose: 2_450,
  open: 2_470,
  dayHigh: 2_510,
  dayLow: 2_460,
  ts: now - 2_000,
  quoteAt: now - 2_000,
  fetchedAt: now - 1_000,
  src: 'fixture',
  fxMap: { JPY: 150, CNY: 7.1 },
  fxAsOf: now - 3_000,
  fxStale: false,
  charts: {
    daily30: [{ t: now / 1000 - 60, o: 2_400, h: 2_510, l: 2_390, c: 2_500, v: 10 }],
    intraday: [{ t: now / 1000 - 5, c: 2_500, v: 2 }],
  },
  slowFields: {
    charts: { source: 'fixture', updatedAt: now - 3_000, stale: false },
    fx: { source: 'fixture', updatedAt: now - 3_000, stale: false },
  },
  ...patch,
});

async function tempDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'qqqsp-recovery-')); }
async function rm(dir) { await fsp.rm(dir, { recursive: true, force: true }); }

// User journey: a fresh quote is retained across a process restart, then exposed as
// explicitly stale recovery data while the live source is offline.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'recovery.json');
    const first = createRecoveryStore({ filePath, now: () => now });
    assert.equal(first.load(), true);
    assert.equal(first.remember(mkQuote()), true);
    assert.equal(first.diagnostics().dirty, true);
    assert.equal(await first.flush(), true);
    const stat = await fsp.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);

    const second = createRecoveryStore({ filePath, now: () => now + 1_000 });
    assert.equal(second.load(), true);
    const recovered = second.get('7203.T');
    assert.equal(recovered.price, 2_500);
    assert.equal(recovered.quoteAt, now - 2_000);
    assert.equal(recovered.fetchedAt, now - 1_000);
    assert.equal(recovered.src, 'fixture');
    assert.equal(recovered.recovery, true);
    assert.equal(recovered.stale, true);
    assert.deepEqual(recovered.staleInfo, { reason: 'offline-cache' });
    assert.equal(recovered.fxStale, true);
    assert.equal(recovered.slowFields.charts.stale, true);
    assert.equal(recovered.slowFields.fx.stale, true);
  } finally { await rm(dir); }
}

// No configured path means a hard-disabled store and no filesystem effects.
{
  const store = createRecoveryStore({ now: () => now });
  assert.equal(store.load(), false);
  assert.equal(store.remember(mkQuote()), false);
  assert.equal(store.get('7203.T'), null);
  assert.equal(await store.flush(), false);
  assert.equal(store.enabled, false);
  assert.equal(store.diagnostics().enabled, false);
}

// Bad inputs and stale/error states are rejected; a quoteAt rollback never replaces
// the newest item for that symbol.
{
  const dir = await tempDir();
  try {
    const store = createRecoveryStore({ filePath: path.join(dir, 'invalid.json'), now: () => now });
    store.load();
    assert.equal(store.remember(mkQuote()), true);
    for (const bad of [
      null,
      { ...mkQuote(), symbol: '../bad' },
      { ...mkQuote(), symbol: '__proto__' },
      { ...mkQuote(), price: 0 },
      { ...mkQuote(), price: Infinity },
      { ...mkQuote(), quoteAt: now + 60_001 },
      { ...mkQuote(), quoteAt: now - 7 * 86_400_000 - 1 },
      { ...mkQuote(), error: 'upstream failed' },
      { ...mkQuote(), pending: true },
      { ...mkQuote(), stale: true },
      { ...mkQuote(), recovery: true },
    ]) assert.equal(store.remember(bad), false);
    assert.equal(store.remember(mkQuote('7203.T', { price: 2_600, quoteAt: now - 3_000, ts: now - 3_000 })), false);
    assert.equal(store.get('7203.T').price, 2_500);
  } finally { await rm(dir); }
}

// Only the whitelist is serialized, and every chart family is capped at 1,500 bars.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'allowlist.json');
    const bars = Array.from({ length: 1_600 }, (_, i) => ({ t: now / 1000 - i, o: i, h: i + 1, l: i - 1, c: i, v: i, secret: 'drop' }));
    const store = createRecoveryStore({ filePath, now: () => now });
    store.load();
    assert.equal(store.remember(mkQuote('7203.T', { charts: { daily30: bars, intraday: bars }, headers: { authorization: 'drop' }, token: 'drop', extra: { secret: true } })), true);
    await store.flush();
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const saved = raw.entries[0];
    assert.equal(saved.headers, undefined);
    assert.equal(saved.token, undefined);
    assert.equal(saved.extra, undefined);
    assert.equal(saved.charts.daily30.length, 1_500);
    assert.equal(saved.charts.intraday.length, 1_500);
    assert.equal(saved.charts.daily30.at(-1).secret, undefined);
    assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  } finally { await rm(dir); }
}

// Count and byte budgets evict oldest records first, while keeping the newest data.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'bounded.json');
    const store = createRecoveryStore({ filePath, now: () => now, maxEntries: 2, maxBytes: 2_000 });
    store.load();
    for (let i = 0; i < 4; i++) {
      assert.equal(store.remember(mkQuote(`S${i}.HK`, { quoteAt: now - i * 100, ts: now - i * 100, price: 100 + i, displayName: 'x'.repeat(200) })), i < 2);
    }
    await store.flush();
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    assert.ok(raw.entries.length <= 2);
    assert.ok(raw.entries.every(x => x.symbol === 'S0.HK' || x.symbol === 'S1.HK'));
    assert.ok((await fsp.stat(filePath)).size <= 2_000);
  } finally { await rm(dir); }
}

// Two stores flushing concurrently must merge their newest symbol entries instead of
// last-writer-wins erasing one store's quote.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'concurrent.json');
    const a = createRecoveryStore({ filePath, now: () => now });
    const b = createRecoveryStore({ filePath, now: () => now });
    a.load(); b.load();
    a.remember(mkQuote('000001.SS', { price: 10, quoteAt: now - 2_000, ts: now - 2_000 }));
    b.remember(mkQuote('005930.KS', { price: 70_000, quoteAt: now - 1_000, ts: now - 1_000 }));
    await Promise.all([a.flush(), b.flush()]);
    const check = createRecoveryStore({ filePath, now: () => now });
    check.load();
    assert.equal(check.get('000001.SS').price, 10);
    assert.equal(check.get('005930.KS').price, 70_000);
  } finally { await rm(dir); }
}

// Load fails closed for oversized, malformed, invalid, or symlinked files, and write
// errors are diagnostics rather than application exceptions.
{
  const dir = await tempDir();
  try {
    const oversized = path.join(dir, 'oversized.json');
    await fsp.writeFile(oversized, 'x'.repeat(2_000), { mode: 0o600 });
    const tooBig = createRecoveryStore({ filePath: oversized, now: () => now, maxBytes: 100 });
    assert.equal(tooBig.load(), false);
    assert.equal(tooBig.get('7203.T'), null);
    assert.match(tooBig.diagnostics().error, /size|large|byte/i);

    const malformed = path.join(dir, 'malformed.json');
    await fsp.writeFile(malformed, '{oops', { mode: 0o600 });
    const badJson = createRecoveryStore({ filePath: malformed, now: () => now });
    assert.equal(badJson.load(), false);
    assert.equal(badJson.get('7203.T'), null);

    const link = path.join(dir, 'link.json');
    await fsp.symlink(malformed, link);
    const symlink = createRecoveryStore({ filePath: link, now: () => now });
    assert.equal(symlink.load(), false);
    assert.equal(await symlink.flush(), false);
    assert.match(symlink.diagnostics().error, /symlink/i);

    const directory = createRecoveryStore({ filePath: dir, now: () => now });
    assert.equal(await directory.flush(), false);
    assert.match(directory.diagnostics().error, /directory|file|write/i);
  } finally { await rm(dir); }
}

// Recovery is bounded by the current clock, and recoverySavedAt records when the
// quote was actually accepted rather than when a caller happens to read it.
{
  const dir = await tempDir();
  try {
    let clock = now;
    const filePath = path.join(dir, 'expiry.json');
    const store = createRecoveryStore({ filePath, now: () => clock });
    store.load();
    assert.equal(store.remember(mkQuote('7203.T')), true);
    await store.flush();
    clock += 1_000;
    const first = store.get('7203.T');
    assert.equal(first.recoverySavedAt, now);
    clock += 7 * 86_400_000 + 1;
    assert.equal(store.get('7203.T'), null);

    clock = now;
    const restarted = createRecoveryStore({ filePath, now: () => clock });
    restarted.load();
    assert.equal(restarted.get('7203.T').recoverySavedAt, now);
  } finally { await rm(dir); }
}

// An expired record is pruned during load/merge while a still-valid record remains.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'prune.json');
    const valid = mkQuote('000001.SS');
    const expired = mkQuote('0700.HK', { quoteAt: now - 8 * 86_400_000, ts: now - 8 * 86_400_000 });
    await fsp.writeFile(filePath, JSON.stringify({ version: 1, entries: [valid, expired] }), { mode: 0o600 });
    const store = createRecoveryStore({ filePath, now: () => now });
    assert.equal(store.load(), true);
    assert.equal(store.get('000001.SS').price, valid.price);
    assert.equal(store.get('0700.HK'), null);
  } finally { await rm(dir); }
}

// New numeric/FX metadata fields and chart validation stay inside the whitelist.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'fields.json');
    const store = createRecoveryStore({ filePath, now: () => now });
    store.load();
    const quote = mkQuote('005930.KS', {
      volume: 123,
      fxKind: 'spot', fxSource: 'fixture', fxTransport: 'https', fxDate: '2026-09-05', fxFetchedAt: now - 100, fxAsOfPrecision: 'minute',
      calendarCoverage: { known: false, source: 'weekends-only', year: 2026, date: '09-05', closed: false, halfDay: false, evil: { secret: true } },
      sourceCheckedAt: now - 100, feedDelayMinutes: 15, pollAfterMs: 2_000, checkIntervalMs: 60_000,
      ext: { reg: { t: now / 1000, price: 100, change: 1, changePct: 1, close: 101, volume: 2, ignored: 'drop' } },
      charts: { daily30: [
        { t: 0, c: 10, v: 1 },
        { t: 1, c: 0, v: 1 },
        { t: 2, c: -1, v: 1 },
        { t: 3, c: 10, v: -1 },
        { t: 4, c: 10, v: null },
        { t: 5, c: 10, v: 2, ignored: 'drop' },
      ] },
      staleInfo: { reason: 'must reject' },
    });
    assert.equal(store.remember(quote), false);
    delete quote.staleInfo;
    assert.equal(store.remember(quote), true);
    await store.flush();
    const saved = JSON.parse(await fsp.readFile(filePath, 'utf8')).entries[0];
    assert.equal(saved.volume, 123);
    assert.equal(saved.fxKind, 'spot');
    assert.equal(saved.fxSource, 'fixture');
    assert.equal(saved.fxTransport, 'https');
    assert.equal(saved.fxDate, '2026-09-05');
    assert.equal(saved.fxFetchedAt, now - 100);
    assert.equal(saved.fxAsOfPrecision, 'minute');
    assert.deepEqual(saved.calendarCoverage, { known: false, source: 'weekends-only', year: 2026, date: '09-05', closed: false, halfDay: false });
    assert.equal(saved.sourceCheckedAt, now - 100);
    assert.equal(saved.feedDelayMinutes, 15);
    assert.equal(saved.pollAfterMs, 2_000);
    assert.equal(saved.checkIntervalMs, 60_000);
    assert.equal(saved.ext.reg.t, now / 1000);
    assert.equal(saved.ext.reg.price, 100);
    assert.equal(saved.ext.reg.change, 1);
    assert.equal(saved.ext.reg.changePct, 1);
    assert.equal(saved.ext.reg.ignored, undefined);
    assert.deepEqual(saved.charts.daily30.map(x => x.t), [4, 5]);
    assert.equal(saved.charts.daily30[1].v, 2);
    assert.equal(store.get('005930.KS').calendarCoverage.known, false);
  } finally { await rm(dir); }
}

// The enabled flag is a cheap read for the gateway, and diagnostics reuses the
// bytes cached on mutation rather than serializing all entries on every poll.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'diagnostics.json');
    const store = createRecoveryStore({ filePath, now: () => now });
    assert.equal(store.enabled, true);
    store.load();
    const before = store.diagnostics().bytes;
    store.remember(mkQuote('000001.SS'));
    const after = store.diagnostics().bytes;
    assert.ok(after > before);
    assert.equal(store.diagnostics().bytes, after);
  } finally { await rm(dir); }
}

// Parsing failures never echo the untrusted JSON payload into diagnostics/logs.
{
  const dir = await tempDir();
  try {
    const filePath = path.join(dir, 'secret.json');
    const logs = [];
    await fsp.writeFile(filePath, '{"secretToken":"DO_NOT_LOG_THIS",', { mode: 0o600 });
    const store = createRecoveryStore({ filePath, now: () => now, log: message => logs.push(String(message)) });
    assert.equal(store.load(), false);
    assert.ok(logs.length > 0);
    assert.equal(logs.some(message => message.includes('DO_NOT_LOG_THIS')), false);
  } finally { await rm(dir); }
}

// A remember() that lands while the atomic write is awaiting must survive the
// retry/merge pass instead of being overwritten by the first snapshot.
{
  const dir = await tempDir();
  const originalOpen = fsp.open;
  try {
    const filePath = path.join(dir, 'write-race.json');
    const store = createRecoveryStore({ filePath, now: () => now });
    store.load();
    store.remember(mkQuote('7203.T', { price: 2_500, quoteAt: now - 2_000, ts: now - 2_000 }));
    let intercepted = false;
    fsp.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'wx' && !intercepted) {
        intercepted = true;
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...writeArgs) => {
          await new Promise(resolve => setImmediate(resolve));
          return writeFile(...writeArgs);
        };
      }
      return handle;
    };
    const flushing = store.flush();
    while (!intercepted) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.remember(mkQuote('7203.T', { price: 2_600, quoteAt: now - 1_000, ts: now - 1_000 })), true);
    assert.equal(await flushing, true);
    const saved = JSON.parse(await fsp.readFile(filePath, 'utf8')).entries[0];
    assert.equal(saved.price, 2_600);
  } finally {
    fsp.open = originalOpen;
    await rm(dir);
  }
}

{
  const dir=await tempDir();
  try{
    const fifo=path.join(dir,'fifo.json');
    assert.equal(spawnSync('mkfifo',[fifo]).status,0);
    const moduleUrl=new URL('../lib/recovery-store.js',import.meta.url).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {createRecoveryStore} from ${JSON.stringify(moduleUrl)};const s=createRecoveryStore({filePath:process.argv[1]});if(s.load()!==false)process.exit(2);`,fifo],{timeout:1500});
    assert.equal(child.status,0,'non-regular recovery file must fail without blocking');
  }finally{await rm(dir);}
}
console.log('PASS recovery store contract');
