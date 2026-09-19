(() => {
  const MAX_WATCHLIST_SYMBOLS = 100;
  function createSafeStorage(getStorage, onUnavailable = () => {}) {
    const memory=new Map();let storage=null,failed=false;
    const fail=()=>{if(!failed){failed=true;onUnavailable();}storage=null;};
    try{storage=getStorage();if(!storage)fail();}catch{fail();}
    return Object.freeze({
      getItem(key){if(storage)try{const value=storage.getItem(key);if(value!==null)memory.set(key,value);return value;}catch{fail();}return memory.get(key)??null;},
      setItem(key,value){memory.set(key,String(value));if(storage)try{storage.setItem(key,String(value));}catch{fail();}},
      removeItem(key){memory.delete(key);if(storage)try{storage.removeItem(key);}catch{fail();}},
      persistent:()=>!failed
    });
  }

  const timestampMs = value => { const n=Number(value);return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):null; };
  const positive = value => Number.isFinite(Number(value))&&Number(value)>0?Number(value):0;
  function calendarStatus(data) {
    const coverage=data?.calendarCoverage||{};
    const pending=coverage.pending===true||['session-pending','special-session-time-unannounced'].includes(coverage.reason);
    const supplied=typeof coverage.warning==='string'?coverage.warning:typeof coverage.note==='string'?coverage.note:'';
    const message=pending?(supplied.trim().slice(0,500)||'该日具体交易时段尚未公布，暂不判定开市或休市')
      :data?.marketState==='UNKNOWN'?(supplied.trim().slice(0,500)||'交易日历或交易时段尚未核验，暂不判定开市或休市'):'';
    return {pending,message};
  }
  // A source check and a trade timestamp describe different kinds of freshness.
  // Shared by the header and individual cards, including between HTTP responses.
  function selectFreshness(data, now = Date.now(), {readIntervalMs=0} = {}) {
    if(!data)return {stale:false,reason:null};
    const quoteAt=timestampMs(data.quoteAt??data.ts);
    const checkedAt=timestampMs(data.sourceCheckedAt)??timestampMs(data.fetchedAt);
    const cadence=Math.max(positive(data.pollAfterMs),positive(data.checkIntervalMs));
    const clientCadence=Math.min(120000,positive(readIntervalMs));
    // A response may arrive near the end of a source cycle and then wait a
    // complete browser cycle. Allow both phases, capped at the supported
    // one-hour source cadence and two-minute browser cadence, plus grace.
    const checkBudgetMs=Math.max(30000,Math.min(3600000,cadence)+clientCadence+5000);
    const delayMs=positive(data.feedDelayMinutes)*60000;
    const sessionStartedAt=timestampMs(data.sessionStartedAt);
    const quoteBudgetMs=data.marketState==='BREAK'?Math.max(300000,delayMs+30000)+(sessionStartedAt&&sessionStartedAt<=now?now-sessionStartedAt:0):Math.max(15000,delayMs+cadence+clientCadence+5000);
    const active=['REGULAR','PRE','POST','AUCTION','BREAK'].includes(data.marketState);
    let reason=data.recovery?'offline-cache':data.staleInfo?.reason || (data.stale||data.staleInfo?'provider-stale':null);
    if(!reason&&checkedAt&&now-checkedAt>checkBudgetMs)reason='source-overdue';
    if(!reason&&active&&quoteAt&&now-quoteAt>quoteBudgetMs)reason='quote-overdue';
    return {stale:!!reason,reason,quoteAt,checkedAt,cadence,checkBudgetMs,quoteBudgetMs};
  }
  function pollingPolicy(data, {mode='economy',hidden=false,now=Date.now()}={}) {
    if(mode==='continuous')return {marketMs:2000,newsMs:60000,macroMs:60000};
    // Unknown/pending symbols keep the fast initial acquisition cadence. A
    // closed instrument never slows another instrument that is still trading.
    const acquiring=data.some(d=>!d||d.pending);
    const allClosed=!acquiring&&data.length>0&&data.every(d=>d&&['CLOSED','HOLIDAY','BREAK'].includes(d.marketState));
    const cadence=allClosed?Math.min(...data.map(d=>Math.max(60000,positive(d.pollAfterMs),positive(d.checkIntervalMs)))):2000;
    let marketMs=acquiring?2000:allClosed?Math.min(120000,Math.max(hidden?120000:60000,cadence)):hidden?15000:2000;
    const transitions=data.map(d=>timestampMs(d?.nextMarketTransitionAt)).filter(at=>at!=null&&at>=now-120000);
    if(transitions.length)marketMs=Math.min(marketMs,Math.max(2000,Math.min(...transitions)-now+500));
    return {marketMs,newsMs:hidden?120000:60000,macroMs:hidden?240000:60000};
  }
  function scrollToCard(element, options = {}) {
    element?.scrollIntoView?.({...options,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }
  const createState = (storage, { maxWatchlist = MAX_WATCHLIST_SYMBOLS } = {}) => {
    const readJSON = (key, fallback) => { try { const value = JSON.parse(storage.getItem(key) || ''); return value == null ? fallback : value; } catch { return fallback; } };
    const writeJSON = (key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };
    const validSymbol = (value) => /^[A-Z0-9.&\-^=]{1,16}$/i.test(String(value || ''));
    const loadWatchlist = (key, defaults = []) => {
      let saved;
      try { saved = storage.getItem(key); } catch { return [...defaults].slice(0, maxWatchlist); }
      if (saved == null) return [...defaults].slice(0, maxWatchlist);
      const list = readJSON(key, []);
      return Array.isArray(list) ? [...new Set(list.filter(validSymbol).map(x => String(x).toUpperCase()))].slice(0, maxWatchlist) : [];
    };
    const saveWatchlist = (key, list) => writeJSON(key, [...list].slice(0, maxWatchlist));
    const loadCurrencies = (key) => {
      const value = readJSON(key, {}), out = new Map();
      if (value && typeof value === 'object' && !Array.isArray(value)) for (const [symbol, currency] of Object.entries(value)) if (currency === 'CNY' || currency === 'USD' || currency === 'NATIVE') out.set(symbol, currency);
      return out;
    };
    const saveCurrencies = (key, map) => writeJSON(key, Object.fromEntries(map));
    const loadRefreshMode = () => {try{return storage.getItem('qqq-refresh-mode')==='continuous'?'continuous':'economy';}catch{return 'economy';}};
    const saveRefreshMode = value => {try{storage.setItem('qqq-refresh-mode',value==='continuous'?'continuous':'economy');}catch{}};
    function sanitizeNames(value) {
      const out=Object.create(null);
      if (!value || typeof value!=='object' || Array.isArray(value)) return out;
      for (const [symbol,name] of Object.entries(value).slice(0,200)) {
        if (validSymbol(symbol) && typeof name==='string' && name.trim()) out[symbol.toUpperCase()]=name.trim().slice(0,160);
      }
      return out;
    }
    const loadNames = key => sanitizeNames(readJSON(key, {}));
    const saveNames = (key, names) => writeJSON(key, sanitizeNames(names));
    return Object.freeze({ loadWatchlist, saveWatchlist, loadCurrencies, saveCurrencies, loadRefreshMode, saveRefreshMode, loadNames, saveNames });
  };
  function formatQuoteAge(value, current) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return '未知（来源未提供报价时间）';
    const at = raw < 1e12 ? raw * 1000 : raw;
    if (!Number.isFinite(current) || at - current > 1000) return '时间异常';
    const seconds = Math.max(0, Math.floor((current - at) / 1000));
    const pad = n => String(n).padStart(2, '0');
    if (seconds < 60) return seconds + '秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + '分' + pad(seconds % 60) + '秒';
    return Math.floor(seconds / 3600) + '时' + pad(Math.floor(seconds / 60) % 60) + '分' + pad(seconds % 60) + '秒';
  }
  function createQuoteClock({ wall = Date.now, mono = () => typeof performance === 'object' ? performance.now() : Date.now() } = {}) {
    let offset = wall() - mono(), samples = [], synced = false;
    function sync(serverValue, started, received = mono()) {
      const server = Number(serverValue), rtt = received - started;
      if (!Number.isFinite(server) || server <= 0 || !Number.isFinite(rtt) || rtt < 0 || rtt > 20000) return false;
      samples = samples.filter(s => received - s.at < 60000);
      samples.push({ at: received, rtt, offset: server + rtt / 2 - received });
      const best = samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
      offset = best.offset; synced = true;
      return true;
    }
    return { now: () => mono() + offset, monotonic: mono, sync,
      resume() { samples = []; synced = false; },
      status: () => ({ synced, uncertaintyMs: samples.length ? Math.min(...samples.map(s => s.rtt)) / 2 : null }) };
  }
  window.PANEL_STATE = Object.freeze({ MAX_WATCHLIST_SYMBOLS, createSafeStorage, createState, selectFreshness, pollingPolicy, scrollToCard, calendarStatus, formatQuoteAge, createQuoteClock });
})();
