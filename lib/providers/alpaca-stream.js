import {marketKeyFor} from '../instruments.js';
import {providerRetryAt} from './provider-retry.js';

function integer(env, name, fallback, min, max) {
  const n = env[name] == null || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new TypeError('Invalid ' + name);
  return n;
}

export function alpacaConfig(env = {}) {
  const enabled = env.ALPACA_ENABLED === '1';
  const feed = env.ALPACA_FEED || 'iex';
  if (!['iex', 'sip'].includes(feed)) throw new TypeError('Invalid ALPACA_FEED; only explicit real-time feeds are supported');
  const key = env.APCA_API_KEY_ID || '', secret = env.APCA_API_SECRET_KEY || '';
  if (enabled && (!key || !secret)) throw new TypeError('Alpaca enabled but server credentials are missing');
  return Object.freeze({enabled, feed, key, secret,
    maxSymbols: integer(env, 'ALPACA_MAX_SYMBOLS', 30, 1, 200),
    snapshotMs: integer(env, 'ALPACA_SNAPSHOT_MS', 60000, 15000, 3600000),
    minRestGapMs: integer(env, 'ALPACA_REST_MIN_GAP_MS', 2000, 1000, 60000),
    activeTtlMs: integer(env, 'ALPACA_ACTIVE_TTL_MS', 300000, 180000, 3600000)
  });
}

import {tradeTimestamp} from './provider-timestamp.js';
export {tradeTimestamp};
import {alpacaOrderBook} from './alpaca-book.js';

// One application instance owns one socket and one bounded REST batch at a time.
// No constructor side effects; no credentials or raw provider errors in diagnostics.
export function createAlpacaProvider({env = {}, now = Date.now, httpsGet,
  newSocket = url => new WebSocket(url), random = Math.random,
  schedule = setInterval, cancel = clearInterval} = {}) {
  const config = alpacaConfig(env);
  const active = new Map(), records = new Map();
  let running = false, generation = 0, timer = null, socket = null;
  let authenticated = false, connectingAt = 0, connectedAt = 0, framesAt=0;
  let nextConnectAt = 0, reconnects = 0, restUntil = 0, restFailures = 0, lastRestAt = -Infinity;
  let restJob = null, status = config.enabled ? 'idle' : 'disabled', errorCode = null;
  let fatal = false, subscriptionBlocked = false, lastSubscriptionAt = -Infinity;
  const requested = new Set(), acknowledged=new Set(), listeners=new Set();
  const notify=symbol=>{for(const fn of listeners)fn(symbol);};
  const counts = {receivedTrades:0, rejectedTrades:0, droppedSymbols:0, restCalls:0, rateLimits:0, invalidations:0};
  const supported = symbol => config.enabled && typeof symbol === 'string' &&
    /^[A-Z]{1,6}$/.test(symbol) && marketKeyFor(symbol) === 'us';

  function disconnect() {
    const previous = socket; socket = null; authenticated = false; requested.clear();acknowledged.clear();
    if (previous) { try { previous.close(); } catch {} }
  }
  function fail(code, {permanent = false, minimum = 1000} = {}) {
    errorCode = code;
    fatal ||= permanent;
    reconnects = Math.min(reconnects + 1, 12);
    const delay = Math.min(300000, 1000 * 2 ** (reconnects - 1));
    nextConnectAt = now() + Math.max(minimum, delay) + Math.floor(Math.max(0, Math.min(1, random())) * 1000);
    disconnect(); status = permanent ? 'blocked' : 'backoff';
  }
  function send(value) {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(value)); return true; }
    catch { fail('SEND_FAILED'); return false; }
  }
  function reconcile() {
    if (!authenticated || subscriptionBlocked || now() - lastSubscriptionAt < 1000) return;
    const remove = [...requested].filter(symbol => !active.has(symbol));
    const add = [...active.keys()].filter(symbol => !requested.has(symbol));
    if (!remove.length && !add.length) return;
    lastSubscriptionAt = now();
    if (remove.length && send({action:'unsubscribe', trades:remove,quotes:remove})) remove.forEach(symbol => requested.delete(symbol));
    if (add.length && send({action:'subscribe', trades:add,quotes:add})) add.forEach(symbol => requested.add(symbol));
  }
  function recordFor(symbol) {
    let record = records.get(symbol);
    if (!record) { record = {book:null,bookOrder:null,trade:null, invalidThrough:null, snapshot:null, snapshotCheckedAt:null, nextSnapshotAt:0}; records.set(symbol, record); }
    return record;
  }
  function acceptTrade(message) {
    if (!active.has(message.S)) return false;
    const stamp = tradeTimestamp(message.t), price = message.p;
    const id = typeof message.i === 'string' ? message.i : Number.isSafeInteger(message.i) ? String(message.i) : null;
    if (!stamp || stamp.milliseconds > now() + 1000 || typeof price !== 'number' || !Number.isFinite(price) || price <= 0 ||
      !id || typeof message.x !== 'string' || typeof message.s !== 'number' || !Number.isFinite(message.s) || message.s <= 0) {
      counts.rejectedTrades++; return false;
    }
    const record = recordFor(message.S), previous = record.trade;
    if (record.invalidThrough != null && stamp.order <= record.invalidThrough || previous && stamp.order < previous.order ||
      previous && stamp.order === previous.order && id === previous.id && message.x === previous.exchange) {
      counts.rejectedTrades++; return false;
    }
    record.trade = Object.freeze({symbol:message.S, price, quoteAt:stamp.milliseconds, sourceTimestamp:message.t,
      receivedAt:now(), order:stamp.order, id, exchange:message.x, size:message.s,
      conditions:Object.freeze(Array.isArray(message.c) ? message.c.filter(x => typeof x === 'string').slice(0,32) : [])});
    counts.receivedTrades++;notify(message.S);return true;
  }
  function acceptBook(message) {
    if (!active.has(message.S)) return false;
    const stamp=tradeTimestamp(message.t),record=recordFor(message.S);
    if (!stamp || record.bookOrder!==null&&stamp.order<record.bookOrder) return false;
    const book=alpacaOrderBook(message.S,message,{source:'alpaca-'+config.feed,coverage:config.feed==='iex'?'single-exchange':'us-sip',checkedAt:now(),now:now()});
    if (!book) return false;
    record.book=book;record.bookOrder=stamp.order;notify(message.S);return true;
  }
  function invalidate(message) {
    const record = records.get(message.S), previous = record?.trade;
    const id = message.T === 'c' ? message.oi : message.i;
    if (previous && String(id) === previous.id && message.x === previous.exchange) {
      // Correction timestamps describe a report, not a new trade. Do not turn
      // them into fresh prices. Await a newer valid trade/snapshot instead.
      record.invalidThrough = previous.order; record.trade = null;
      record.nextSnapshotAt = 0; counts.invalidations++;notify(message.S);
    }
  }
  function receive(data) {
    framesAt=now();
    if (typeof data !== 'string' || data.length > 1048576) { fail('INVALID_FRAME'); return; }
    let batch;
    try { batch = JSON.parse(data); } catch { fail('INVALID_JSON'); return; }
    if (!Array.isArray(batch) || batch.length > 10000) { fail('INVALID_BATCH'); return; }
    for (const message of batch) {
      if (!message || typeof message !== 'object') continue;
      if (message.T === 'success' && message.msg === 'authenticated') {
        authenticated = true; connectedAt = now(); status = 'subscribing'; errorCode = null;
        lastSubscriptionAt = -Infinity; reconcile();
      } else if(message.T==='subscription' && authenticated){
        acknowledged.clear();for(const symbol of message.trades||[])if(active.has(symbol))acknowledged.add(symbol);
        status=acknowledged.size===active.size?'streaming':'subscribing';
      } else if (message.T === 'error') {
        const code = Number(message.code);
        if (code === 405) { subscriptionBlocked = true; status = 'subscription-limited'; errorCode = 'SYMBOL_LIMIT'; }
        else if ([400,401,402,409,410].includes(code)) fail('WS_' + code, {permanent:true});
        else fail('WS_' + (Number.isFinite(code) ? code : 'UNKNOWN'), {minimum:code === 406 ? 60000 : 1000});
      } else if (message.T === 'q' && authenticated) acceptBook(message);
      else if (message.T === 't' && authenticated) acceptTrade(message);
      else if (authenticated && (message.T === 'c' || message.T === 'x')) invalidate(message);
      // Connected/auth/subscription/heartbeat messages never touch quoteAt.
    }
  }
  function connect() {
    if (!running || socket || fatal || !active.size || now() < nextConnectAt) return;
    const epoch = generation;
    try {
      const ws = newSocket('wss://stream.data.alpaca.markets/v2/' + config.feed);
      socket = ws; connectingAt = now(); status = 'connecting';
      const current = () => running && generation === epoch && socket === ws;
      ws.addEventListener('open', () => { if (current()) { status = 'authenticating'; send({action:'auth', key:config.key, secret:config.secret}); } });
      ws.addEventListener('message', event => { if (current()) receive(event.data); });
      ws.addEventListener('error', () => { if (current()) fail('SOCKET_ERROR'); });
      ws.addEventListener('close', () => { if (current()) fail('SOCKET_CLOSED'); });
    } catch { fail('CONNECT_FAILED'); }
  }
  async function refreshSnapshots(symbols, epoch, job) {
    const at = now(); lastRestAt = at; counts.restCalls++;
    let deadline;
    try {
      const request = httpsGet('https://data.alpaca.markets/v2/stocks/snapshots?symbols=' + encodeURIComponent(symbols.join(',')) + '&feed=' + config.feed,
        {'APCA-API-KEY-ID':config.key, 'APCA-API-SECRET-KEY':config.secret}, {signal:job.controller.signal, timeout:5000});
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => { job.controller.abort(); reject(new Error('SNAPSHOT_TIMEOUT')); }, 5500);
        deadline.unref?.();
      });
      const response = await Promise.race([request, timeout]);
      if (!running || epoch !== generation) return;
      if (response.status === 429 || response.status === 503) {
        restFailures = Math.min(restFailures + 1, 8); counts.rateLimits++;
        restUntil = providerRetryAt(response.headers, now(), Math.min(300000, 60000 * 2 ** (restFailures - 1)));
        errorCode = 'REST_' + response.status; return;
      }
      if (response.status === 401 || response.status === 403) {
        // Stream entitlement and REST entitlement may differ; stop REST retries
        // until restart without forcibly destroying an otherwise valid stream.
        restUntil = Infinity; errorCode = 'REST_AUTH'; return;
      }
      if (response.status !== 200) throw new Error('SNAPSHOT_FAILED');
      const data = typeof response.body === 'string' ? JSON.parse(response.body) : JSON.parse(String(response.body));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('BAD_SNAPSHOT');
      restFailures = 0; if (errorCode?.startsWith('REST_')) errorCode = null;
      for (const symbol of symbols) {
        if (!active.has(symbol)) continue;
        const record = recordFor(symbol), snapshot = data[symbol];
        record.nextSnapshotAt = now() + config.snapshotMs;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        if(snapshot.latestQuote)acceptBook({...snapshot.latestQuote,S:symbol});
        const latest=snapshot.latestTrade, stamp=tradeTimestamp(latest?.t);
        if (!stamp || stamp.milliseconds>now()+1000 || typeof latest.p!=='number' || !Number.isFinite(latest.p) || latest.p<=0) continue;
        record.snapshot = snapshot; record.snapshotCheckedAt = now();
        if (snapshot.latestTrade) acceptTrade({...snapshot.latestTrade, T:'t', S:symbol});
      }
    } catch {
      if (running && epoch === generation) {
        restFailures = Math.min(restFailures + 1, 8);
        restUntil = now() + Math.min(300000, 10000 * 2 ** (restFailures - 1)); errorCode = 'REST_FAILED';
      }
    } finally {
      clearTimeout(deadline);
      if (restJob === job) restJob = null;
    }
  }
  function step() {
    if (!running) return;
    for (const [symbol, at] of active) if (now() - at >= config.activeTtlMs) { active.delete(symbol); records.delete(symbol); }
    if (!active.size) { disconnect(); status = fatal ? 'blocked' : 'idle'; return; }
    if (socket && !authenticated && now() - connectingAt >= 10000) fail('AUTH_TIMEOUT');
    if(authenticated && status==='subscribing' && now()-lastSubscriptionAt>=10000)fail('SUBSCRIPTION_TIMEOUT');
    if (authenticated && now() - connectedAt > 30000) reconnects = 0;
    connect(); reconcile();
    if (httpsGet && !restJob && now() >= restUntil && now() - lastRestAt >= config.minRestGapMs) {
      const due = [...active.keys()].filter(symbol => recordFor(symbol).nextSnapshotAt <= now());
      if (due.length) {
        const job = {controller:new AbortController()}; restJob = job;
        job.promise = refreshSnapshots(due, generation, job);
      }
    }
  }
  function touch(symbol) {
    if (!supported(symbol)) return false;
    if (!active.has(symbol) && active.size >= config.maxSymbols) { counts.droppedSymbols++; return false; }
    active.set(symbol, now()); recordFor(symbol);
    connect(); return true;
  }
  function read(symbol) {
    const record = records.get(symbol); if (!record) return null;
    const t = record.trade;
    return {orderBook:record.book,trade:t ? {symbol:t.symbol, price:t.price, quoteAt:t.quoteAt, receivedAt:t.receivedAt,
      sourceTimestamp:t.sourceTimestamp, id:t.id, exchange:t.exchange, conditions:t.conditions} : null,
      snapshot:record.snapshot, snapshotCheckedAt:record.snapshotCheckedAt, connectionCheckedAt:framesAt,delayMinutes:0,
      source:'alpaca-' + config.feed, coverage:config.feed === 'iex' ? 'single-exchange' : 'us-sip',
      state:['streaming','subscribing'].includes(status)?(acknowledged.has(symbol)?'streaming':'subscribing'):status, errorCode, invalidated:record.invalidThrough != null && !t};
  }
  function start() {
    if (running || !config.enabled) return;
    running = true; fatal = false; subscriptionBlocked = false; status = 'idle'; errorCode = null;
    nextConnectAt = 0; restUntil = 0; reconnects = 0; restFailures = 0;
    timer = schedule(step, 1000); timer?.unref?.(); step();
  }
  function stop() {
    running = false; generation++; if (timer != null) cancel(timer); timer = null;
    disconnect(); restJob?.controller.abort(); active.clear(); records.clear(); status = config.enabled ? 'stopped' : 'disabled';
  }
  function retain(symbols){const keep=new Set(symbols);for(const s of active.keys())if(!keep.has(s)){active.delete(s);records.delete(s);acknowledged.delete(s);}if(!active.size){disconnect();status=fatal?'blocked':'idle';}else reconcile();}
  return Object.freeze({start, stop, step, touch, read, retain,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}, supports:supported,
    diagnostics:() => ({enabled:config.enabled, feed:config.feed, status, errorCode, active:active.size,
      maxSymbols:config.maxSymbols, entries:records.size, socket:!!socket, restInFlight:!!restJob,
      restRetryAt:Number.isFinite(restUntil) ? restUntil : null, restBlocked:restUntil === Infinity,
      nextConnectAt, subscriptionBlocked, acknowledged:[...acknowledged], ...counts})});
}
