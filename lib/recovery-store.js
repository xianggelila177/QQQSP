import {isUsableChartFamily} from './quote-contract.js';
import {ensureParent} from './atomic-file.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FORMAT_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 86400000;
const MAX_SYMBOL_LENGTH = 64;
const MAX_STRING_LENGTH = 512;
const MAX_BARS = 1500;
const MAX_CADENCE_MS = 7 * 86400000;
const CHART_KEYS = new Set(['intraday', 'daily30', 'daily', 'weekly', 'monthly']);
const SLOW_KEYS = new Set(['week52Range', 'intraday', 'daily30', 'charts', 'fx']);
const NUMERIC_KEYS = new Set([
  'gmtoff', 'gmtoffset', 'price', 'regularPrice', 'prevClose', 'open', 'dayHigh', 'dayLow',
  'week52High', 'week52Low', 'ts', 'quoteAt', 'fetchedAt', 'fxAsOf', 'currency2cny', 'daily30Version',
  'change', 'changePct', 'volume', 'fxFetchedAt', 'recoverySavedAt', 'sourceCheckedAt',
  'feedDelayMinutes', 'pollAfterMs', 'checkIntervalMs',
]);
const STRING_KEYS = new Set([
  'symbol', 'market', 'name', 'displayName', 'exchangeName', 'fullExchangeName', 'currency',
  'instrumentType', 'instrumentTypeSource', 'src', 'priceSession', 'ohlcSession', 'marketState',
  'fxKind', 'fxSource', 'fxTransport', 'fxDate', 'fxAsOfPrecision',
  'feedDelaySource','feedDelaySourceUrl',
]);
const BOOLEAN_KEYS = new Set(['ohlcConsistent', 'fxStale']);
const EXT_KEYS = new Set(['pre', 'post', 'reg']);
const EXT_NUMERIC_KEYS = new Set(['t', 'price', 'change', 'changePct', 'open', 'high', 'low', 'close', 'volume', 'vwap', 'n']);
const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.^=&-]{0,63}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const pathQueues = new Map();

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

function canonicalSymbol(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SYMBOL_LENGTH || value.trim() !== value) return null;
  const symbol = value.toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

function boundedString(value) {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH ? value : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeBars(value) {
  if (!Array.isArray(value)) return null;
  const bars = [];
  for (const source of value) {
    if (!record(source) || !positive(source.t) || !positive(source.c)) continue;
    if (own(source, 'v') && source.v !== null && (!finite(source.v) || source.v < 0)) continue;
    const bar = { t: source.t, c: source.c };
    for (const key of ['o', 'h', 'l', 'c', 'v']) if (finite(source[key])) bar[key] = source[key];
    if (own(source, 'v') && source.v === null) bar.v = null;
    if (typeof source.vMode === 'string' && source.vMode.length <= 32) bar.vMode = source.vMode;
    bars.push(bar);
  }
  return bars.slice(-MAX_BARS);
}

function normalizeCharts(value) {
  if (!record(value)) return null;
  const charts = {};
  for (const key of CHART_KEYS) {
    if (!own(value, key)) continue;
    const bars = normalizeBars(value[key]);
    if (bars) charts[key] = bars;
  }
  return Object.keys(charts).length ? charts : null;
}

function normalizeFxMap(value) {
  if (!record(value)) return null;
  const out = {};
  for (const key of Object.keys(value)) {
    const currency = key.toUpperCase();
    if (CURRENCY_RE.test(currency) && positive(value[key])) out[currency] = value[key];
  }
  return Object.keys(out).length ? out : null;
}

function normalizeSlowFields(value) {
  if (!record(value)) return null;
  const out = {};
  for (const key of SLOW_KEYS) {
    if (!own(value, key) || !record(value[key])) continue;
    const source = value[key];
    const item = {};
    if (boundedString(source.source) != null) item.source = source.source;
    for (const field of ['timeContract','timeBasis','timeZone']) if (boundedString(source[field]) != null) item[field] = source[field];
    if (finite(source.updatedAt)) item.updatedAt = source.updatedAt;
    if (typeof source.stale === 'boolean') item.stale = source.stale;
    if (boundedString(source.error) != null) item.error = source.error;
    if (Object.keys(item).length) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeCalendarCoverage(value) {
  if (!record(value) || typeof value.known !== 'boolean') return null;
  const out = { known: value.known };
  if (boundedString(value.source) != null) out.source = value.source;
  if (Number.isInteger(value.year) && value.year >= 1970 && value.year <= 3000) out.year = value.year;
  if (typeof value.date === 'string' && /^\d{2}-\d{2}$/.test(value.date)) out.date = value.date;
  if (typeof value.closed === 'boolean') out.closed = value.closed;
  if (typeof value.halfDay === 'boolean') out.halfDay = value.halfDay;
  if (typeof value.pending === 'boolean') out.pending = value.pending;
  for(const key of ['reason','note'])if(boundedString(value[key])!=null)out[key]=value[key];
  return out;
}

function normalizeExt(value) {
  if (!record(value)) return null;
  const out = {};
  for (const key of EXT_KEYS) {
    if (!own(value, key) || !record(value[key])) continue;
    const source = value[key];
    const item = {};
    for (const name of EXT_NUMERIC_KEYS) if (finite(source[name])) item[name] = source[name];
    if (Object.keys(item).length) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}

function validTime(value, current, maxAgeMs) {
  return finite(value) && value > 0 && value <= current + 60000 && current - value <= maxAgeMs;
}

function normalizeEntry(source, current, maxAgeMs, { input = false } = {}) {
  if (!record(source)) return null;
  const symbol = canonicalSymbol(source.symbol);
  if (!symbol || !positive(source.price)) return null;
  if (input && (source.error || source.pending || source.stale || source.recovery
    || own(source, 'staleInfo') || source.status === 'error' || source.status === 'pending'
    || source.status === 'stale' || source.status === 'recovery')) return null;

  let at = null;
  for (const key of ['quoteAt', 'ts']) {
    if (!own(source, key)) continue;
    if (!validTime(source[key], current, maxAgeMs)) return null;
    if (at == null) at = source[key];
  }
  if (at == null) return null;

  const out = { symbol, price: source.price };
  for (const key of STRING_KEYS) {
    if (key === 'symbol' || !own(source, key)) continue;
    const value = boundedString(source[key]);
    if (value != null) out[key] = value;
  }
  for (const key of NUMERIC_KEYS) {
    if (key === 'price' || !own(source, key) || !finite(source[key])) continue;
    if (key === 'volume' && source[key] < 0) continue;
    if (['feedDelayMinutes'].includes(key) && (source[key] < 0 || source[key] > MAX_CADENCE_MS / 60000)) continue;
    if (['pollAfterMs', 'checkIntervalMs'].includes(key) && (source[key] < 0 || source[key] > MAX_CADENCE_MS)) continue;
    if (key === 'sourceCheckedAt' && !validTime(source[key], current, maxAgeMs)) continue;
    out[key] = source[key];
  }
  for (const key of BOOLEAN_KEYS) if (own(source, key) && typeof source[key] === 'boolean') out[key] = source[key];
  if (own(source, 'charts')) {
    const charts = normalizeCharts(source.charts);
    if (charts) out.charts = charts;
  }
  if (own(source, 'fxMap')) {
    const fxMap = normalizeFxMap(source.fxMap);
    if (fxMap) out.fxMap = fxMap;
  }
  if (own(source, 'slowFields')) {
    const slowFields = normalizeSlowFields(source.slowFields);
    if (slowFields) out.slowFields = slowFields;
  }
  // 2.7 migration: old Nasdaq x-coordinates were not normalized. Do not shift
  // cached prices by a guessed offset; invalidate only the affected intraday
  // family and let normal enrichment fetch it again. Other providers are intact.
  if (!input && out.slowFields?.intraday?.source === 'nasdaq-intraday'
      && out.slowFields.intraday.timeContract !== 'nasdaq-label-et-v2' && out.charts?.intraday) {
    out.charts.intraday = [];
    out.slowFields.intraday = {...out.slowFields.intraday, stale: true, error: '旧分时时间版本已失效，等待重新获取'};
  }
  if (own(source, 'calendarCoverage')) {
    const coverage = normalizeCalendarCoverage(source.calendarCoverage);
    if (coverage) out.calendarCoverage = coverage;
  }
  if (own(source, 'ext')) {
    const ext = normalizeExt(source.ext);
    if (ext) out.ext = ext;
  }
  // quoteAt/ts are required above, but this keeps a persisted record explicit.
  if (!own(out, 'quoteAt') && !own(out, 'ts')) out.quoteAt = at;
  return out;
}

function entryTime(entry) {
  return entry.quoteAt ?? entry.ts;
}

function mergeMaps(left, right) {
  const merged = new Map();
  for (const [symbol, entry] of left) merged.set(symbol, clone(entry));
  for (const [symbol, entry] of right) {
    const previous = merged.get(symbol);
    if (!previous || entryTime(entry) >= entryTime(previous)) merged.set(symbol, clone(entry));
  }
  return merged;
}

function oldestKey(map) {
  let oldest = null;
  for (const [symbol, entry] of map) {
    if (!oldest || entryTime(entry) < entryTime(oldest[1])) oldest = [symbol, entry];
  }
  return oldest?.[0] ?? null;
}

function serialize(map) {
  const entries = [...map.values()].sort((a, b) => entryTime(b) - entryTime(a));
  const text = JSON.stringify({ version: FORMAT_VERSION, entries });
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

const sizes=new WeakMap();
function entryBytes(entry){
  if(!sizes.has(entry))sizes.set(entry,Buffer.byteLength(JSON.stringify(entry),'utf8'));
  return sizes.get(entry);
}
function mapBytes(map){return Buffer.byteLength(JSON.stringify({version:FORMAT_VERSION,entries:[]}),'utf8')+Math.max(0,map.size-1)+[...map.values()].reduce((n,entry)=>n+entryBytes(entry),0);}
function freezeTree(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}
  return value;
}
function boundMap(source, maxEntries, maxBytes) {
  const map = new Map(source);
  while (map.size > maxEntries) map.delete(oldestKey(map));
  let used=mapBytes(map);
  while(map.size&&used>maxBytes){const key=oldestKey(map);used-=entryBytes(map.get(key))+(map.size>1?1:0);map.delete(key);}
  return map;
}

function rootEntries(parsed, current, maxAgeMs) {
  if (!record(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.entries)) return null;
  const rootKeys = Object.keys(parsed);
  if (rootKeys.some(key => key !== 'version' && key !== 'entries')) return null;
  const map = new Map();
  for (const item of parsed.entries) {
    if (record(item)) {
      const times = ['quoteAt', 'ts'].filter(key => own(item, key)).map(key => item[key]);
      const expired = times.length > 0 && times.every(value => finite(value) && value > 0 && current - value > maxAgeMs);
      if (expired) continue;
    }
    const normalized = normalizeEntry(item, current, maxAgeMs);
    if (!normalized) return null;
    map.set(normalized.symbol, normalized);
  }
  return map;
}

function errorText(error) {
  return String(error?.message || error || 'unknown error').slice(0, 300);
}

export function createRecoveryStore({
  filePath,
  now = () => Date.now(),
  log = null,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  let target = null;
  try { if (typeof filePath === 'string' && filePath.trim()) target = path.resolve(filePath); } catch { target = null; }
  const enabled = target !== null;
  const entryLimit = finite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
  const byteLimit = finite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const ageLimit = finite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  let entries = new Map();
  let loaded = false;
  let dirty = false;
  let revision = 0;
  let lastFlushAt = null;
  let lastLoadAt = null;
  let error = null;
  let invalidItems = 0;
  let bytes = mapBytes(entries);

  function setEntries(next) {
    for(const entry of next.values())freezeTree(entry);
    entries = next;
    bytes = mapBytes(entries);
  }

  const currentNow = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch { return Date.now(); }
  };
  const note = (message, errorValue = null) => {
    error = `${message}${errorValue ? `: ${errorText(errorValue)}` : ''}`;
    try {
      if (typeof log === 'function') log(error);
      else if (log && typeof log.error === 'function') log.error(error);
    } catch { /* logging must not break the application */ }
  };
  const clearError = () => { error = null; };

  function readTargetSync() {
    let fd;
    try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0)); }
    catch (e) {
      if (e?.code === 'ENOENT') return { missing: true };
      if (e?.code === 'ELOOP') throw new Error('symlink target rejected');
      throw e;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('target is not a regular file');
      if (stat.size > byteLimit) throw new Error('recovery file exceeds byte limit');
      return { text: fs.readFileSync(fd, 'utf8'), size: stat.size };
    } catch (e) {
      if (e?.code === 'ELOOP') throw new Error('symlink target rejected');
      throw e;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    }
  }

  function load() {
    if (!enabled) return false;
    if (loaded) return !error;
    loaded = true;
    lastLoadAt = currentNow();
    try {
      const result = readTargetSync();
      if (result.missing) { clearError(); return true; }
      let parsed;
      try { parsed = JSON.parse(result.text); } catch { throw new Error('invalid JSON'); }
      const map = rootEntries(parsed, currentNow(), ageLimit);
      if (!map) throw new Error('invalid recovery schema or expired item');
      const bounded = boundMap(map, entryLimit, byteLimit);
      setEntries(bounded);
      dirty = bounded.size !== map.size || map.size !== parsed.entries.length;
      invalidItems = 0;
      clearError();
      return true;
    } catch (e) {
      setEntries(new Map());
      dirty = false;
      note('load failed', e);
      return false;
    }
  }

  function remember(quote) {
    if (!enabled) return false;
    if (!loaded) load();
    if (error && !loaded) return false;
    const acceptedAt = currentNow();
    const normalized = normalizeEntry(quote, acceptedAt, ageLimit, { input: true });
    if (!normalized) return false;
    normalized.recoverySavedAt = acceptedAt;
    const previous = entries.get(normalized.symbol);
    if (previous && entryTime(normalized) < entryTime(previous)) return false;
    const next = new Map(entries);
    next.set(normalized.symbol, normalized);
    const bounded = boundMap(next, entryLimit, byteLimit);
    if (!bounded.has(normalized.symbol)) return false;
    setEntries(bounded);
    dirty = true;
    revision += 1;
    return true;
  }

  async function readTargetForMerge() {
    let handle;
    try { handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0)); }
    catch (e) {
      if (e?.code === 'ENOENT') return {map:new Map(),observed:null};
      if (e?.code === 'ELOOP') throw new Error('symlink target rejected');
      throw e;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('target is not a regular file');
      if (stat.size > byteLimit) throw new Error('recovery file exceeds byte limit');
      const raw=await handle.readFile();
      const text=raw.toString('utf8');
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* invalid content can be quarantined */ }
      const map = parsed===undefined?null:rootEntries(parsed, currentNow(), ageLimit);
      if (!map) {
        // Only malformed contents of a bounded regular file are recoverable.
        // Permission, symlink, oversized and non-file errors above stay closed.
        const current=await fsp.lstat(target);
        if(!current.isFile() || current.isSymbolicLink() || current.dev!==stat.dev || current.ino!==stat.ino || current.mtimeMs!==stat.mtimeMs || current.size!==stat.size) throw new Error('recovery target changed during quarantine');
        // One atomically replaced quarantine slot bounds retention to maxBytes.
        // It is outside the valid source path and can never be served as a quote.
        await writeAtomic(raw, target+'.corrupt');
        return {map:new Map(),observed:stat};
      }
      return {map,observed:stat};
    } finally {
      try { await handle.close(); } catch { /* best effort */ }
    }
  }

  function sameFile(a,b) {
    return !a&&!b || !!a&&!!b&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  }
  function concurrentWrite() {return Object.assign(new Error('recovery target changed during write'),{code:'RECOVERY_CONCURRENT_WRITE'});}
  async function writeAtomic(text, destination=target, observed=undefined) {
    await ensureParent(destination);
    let stat;
    try { stat = await fsp.lstat(destination); }
    catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) throw new Error('symlink target rejected');
    if (stat && !stat.isFile()) throw new Error('target is not a regular file');
    if(observed!==undefined&&!sameFile(observed,stat))throw concurrentWrite();
    const temp = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let handle = null;
    try {
      handle = await fsp.open(temp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = null;
      const tempStat = await fsp.lstat(temp);
      if (!tempStat.isFile() || tempStat.isSymbolicLink()) throw new Error('temporary file validation failed');
      const current=await fsp.lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(current?.isSymbolicLink() || (current && !current.isFile())) throw new Error('unsafe destination changed before rename');
      if(!sameFile(stat,current))throw concurrentWrite();
      await fsp.rename(temp, destination);
    } finally {
      try { if (handle) await handle.close(); } catch { /* best effort */ }
      try { await fsp.unlink(temp); } catch (e) { if (e?.code !== 'ENOENT') { /* best effort */ } }
    }
  }

  async function flushOnce() {
    if (!dirty) return !error;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const startedRevision = revision;
      const {map:disk,observed} = await readTargetForMerge();
      const merged = boundMap(mergeMaps(disk, entries), entryLimit, byteLimit);
      const payload = serialize(merged);
      if (payload.bytes > byteLimit) throw new Error('recovery payload exceeds byte limit');
      try {await writeAtomic(payload.text,target,observed);}
      catch(error) {if(error.code==='RECOVERY_CONCURRENT_WRITE')continue;throw error;}
      if (revision === startedRevision) {
        setEntries(merged);
        dirty = false;
        lastFlushAt = currentNow();
        clearError();
        return true;
      }
      // A synchronous remember() happened while the file operation awaited. Merge it
      // into the next pass so a concurrent quote is never lost.
      setEntries(boundMap(mergeMaps(merged, entries), entryLimit, byteLimit));
    }
    throw new Error('flush changed repeatedly while writing');
  }

  async function flush() {
    if (!enabled) return false;
    if (!loaded) load();
    if (!dirty) return !error;
    const previous = pathQueues.get(target) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try { return await flushOnce(); }
      catch (e) { note('flush failed', e); return false; }
    });
    pathQueues.set(target, operation);
    try { return await operation; }
    finally { if (pathQueues.get(target) === operation) pathQueues.delete(target); }
  }

  function get(symbol) {
    if (!enabled || !loaded) return null;
    const key = canonicalSymbol(symbol);
    const entry = key ? entries.get(key) : null;
    if (!entry) return null;
    const current = currentNow();
    if (!validTime(entryTime(entry), current, ageLimit)) {
      entries.delete(key);
      bytes = mapBytes(entries);
      dirty = true;
      revision += 1;
      return null;
    }
    const out = {...entry};
    out.recovery = true;
    out.recoverySavedAt = out.recoverySavedAt ?? entryTime(entry);
    out.stale = true;
    out.staleInfo = { reason: 'offline-cache' };
    out.fxStale = true;
    const slowFields = {};
    if (record(out.slowFields)) for (const key of Object.keys(out.slowFields)) {
      if (record(out.slowFields[key])) slowFields[key] = { ...out.slowFields[key], stale: true };
    }
    const source = out.src || 'recovery';
    const updatedAt = out.quoteAt ?? out.ts ?? null;
    if (out.charts && !slowFields.charts) slowFields.charts = { source, updatedAt, stale: true };
    if (out.charts?.daily30 && !slowFields.daily30) slowFields.daily30 = { source, updatedAt, stale: true };
    if (out.charts?.intraday && !slowFields.intraday) slowFields.intraday = { source, updatedAt, stale: true };
    if ((out.fxMap || out.fxAsOf != null) && !slowFields.fx) slowFields.fx = { source, updatedAt: out.fxAsOf ?? updatedAt, stale: true };
    if ((out.week52High != null || out.week52Low != null) && !slowFields.week52Range) slowFields.week52Range = { source, updatedAt, stale: true };
    out.slowFields = slowFields;
    return out;
  }

  function diagnostics() {
    return {
      enabled,
      filePath: target,
      loaded,
      dirty,
      entries: entries.size,
      bytes,
      maxEntries: entryLimit,
      maxBytes: byteLimit,
      maxAgeMs: ageLimit,
      invalidItems,
      error,
      lastLoadAt,
      lastFlushAt,
      pendingFlush: enabled && pathQueues.has(target),
    };
  }

  return { enabled, load, remember, get, has:symbol=>entries.has(canonicalSymbol(symbol)), needsHistory:(symbol,charts)=>Object.keys(entries.get(canonicalSymbol(symbol))?.charts||{}).some(key=>isUsableChartFamily(entries.get(canonicalSymbol(symbol)).charts[key])&&!isUsableChartFamily(charts?.[key])), flush, diagnostics };
}
