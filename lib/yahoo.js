import {barsFrom} from './chart-bars.js';
export {barsFrom} from './chart-bars.js';
import { volumeNumber } from './quote-contract.js';
import { FX_CURRENCIES, usableFxRates } from './currency.js';
import { sleep } from './transport.js';
import { log as defaultLog } from '../log.mjs';
import { timezoneOffsetFor } from '../mkt.mjs';
import { cacheSet as boundedCacheSet } from './cache.js';
export function createYahooService({ now = () => Date.now(), env = {}, httpsGet, slowMap = new Map(), getCrumb, clearCrumb, yahoo429Hit, clear429Streak, cacheSet = boundedCacheSet, getSinaDaily, chartOverride, breaker, log = defaultLog, slowTtl = 300000, fxFailureCooldown = 60000 } = {}) {
  // lib/yahoo.js — Yahoo 上游控频/图表抓取/日线/汇率
  // Credentials, breaker callbacks and cache ownership are per instance.

  class RateLimitError extends Error {
    constructor(msg = 'Yahoo rate limited', retryAt = null) { super(msg); this.name = 'RateLimitError'; this.code = 'RATE_LIMITED'; this.rateLimited = true; this.retryAt = retryAt; }
  }
  const Y_TASK_DEADLINE=Number(env.Y_TASK_DEADLINE??20000);
  let closed=false,generation=0;
  let lifecycle=new AbortController();
  class ClosedError extends Error { constructor(){super('Yahoo service stopped');this.code='STOPPED';} }
  class DeadlineError extends Error { constructor(){super('Yahoo deadline exceeded');this.code='DEADLINE';} }
  async function yGated(impl,opts={}){
    if(closed)throw new ClosedError();
    const state=breaker?.state();
    if(state?.blocked)throw new RateLimitError('Yahoo source cooling down',state.until);
    const ms=Math.min(Y_TASK_DEADLINE,Number(opts.deadlineMs)||Y_TASK_DEADLINE);
    const signal=AbortSignal.any([lifecycle.signal,AbortSignal.timeout(ms),...(opts.signal?[opts.signal]:[])]);
    // Host gate in transport owns spacing, queueing and 429. Never nest a second queue.
    const response=await impl(signal,ms);
    if(response?.status===429)throw new RateLimitError('Yahoo source rate limited',breaker?.state().until);
    return response;
  }
  function close(){closed=true;generation++;lifecycle.abort(new ClosedError());dailyInflight.clear();fxInflight=null;return Promise.resolve();}
  function reopen(){if(closed){closed=false;generation++;lifecycle=new AbortController();}}
  async function fetchChart(symbol,query,options={}){
    if(closed)throw new ClosedError();
    const base='https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+query;
    const request=(url,headers={})=>yGated((signal,remaining)=>httpsGet(url,headers,{signal,timeout:remaining}),{...options,source:symbol});
    let response=await request(base);
    // The chart endpoint often accepts anonymous requests. Only acquire credentials
    // when explicitly required, instead of burning cookie/crumb quota on every boot.
    if(response.status===401){
      clearCrumb?.();const {crumb,cookie}=await getCrumb();
      response=await request(base+'&crumb='+encodeURIComponent(crumb),{Cookie:cookie});
    }
    let result;try{result=JSON.parse(response.body)?.chart?.result?.[0];}catch{}
    if(response.status===200&&result)return result;
    const error=new Error('Yahoo chart unavailable');
    error.code=response.status===404?'HISTORY_NOT_FOUND':response.status===403?'HISTORY_FORBIDDEN':'HISTORY_BAD_RESPONSE';
    error.statusCode=response.status===404?404:response.status===403?403:502;
    throw error;
  }

  async function fetchQuoteSummary(symbol,options={}) {
    if(closed)throw new ClosedError();
    const base='https://query1.finance.yahoo.com/v10/finance/quoteSummary/'+encodeURIComponent(symbol)+'?modules=price,summaryDetail,defaultKeyStatistics,quoteType&formatted=false';
    const request=(url,headers={})=>yGated((signal,remaining)=>httpsGet(url,headers,{signal,timeout:remaining}),options);
    let response=await request(base);
    if(response.status===401){
      const {crumb,cookie}=await getCrumb();options.signal?.throwIfAborted();
      response=await request(base+'&crumb='+encodeURIComponent(crumb),{Cookie:cookie});
      if(response.status===401)clearCrumb?.();
    }
    if(response.status!==200)throw Object.assign(new Error('Yahoo financial source unavailable'),{code:'FUNDAMENTALS_SOURCE',retryAt:breaker?.state().until||null});
    return JSON.parse(response.body);
  }

  // One successful daily history read supplies both OHLC and chart views.
  // Failed refreshes retain the raw snapshot with its original successful time.
  const dailyInflight = new Map();
  async function dailyHistory(symbol) {
    if (closed) throw new ClosedError();
    const owner=generation,k=symbol+':yraw',cached=slowMap.get(k);
    if(cached?.data&&now()-cached.ts<slowTtl)return cached;
    if(cached?.retryAt>now())throw new Error('Yahoo daily history cooldown');
    if(dailyInflight.has(k))return dailyInflight.get(k);
    const work=(async()=>{
      try {
        const data=await fetchChart(symbol,'?interval=1d&range=6mo');
        if(closed||owner!==generation)throw new ClosedError();
        if(!barsFrom(data).length)throw new Error('Yahoo daily history empty');
        const value={data,ts:now()};cacheSet(slowMap,k,value);return value;
      }catch(error){
        if(closed||owner!==generation)throw new ClosedError();
        cacheSet(slowMap,k,{...cached,failedAt:now(),retryAt:Math.max(now()+60000,Number(error.retryAt)||0)});
        throw error;
      }finally{if(owner===generation)dailyInflight.delete(k);}
    })();dailyInflight.set(k,work);return work;
  }

  // 今日OHLC + 昨收(慢缓存). 日线在盘前/早盘常滞后一日: 需按日期判断, 否则昨收会错成前天
  async function getDayOhlc(symbol, todayKey) {
    if (closed) throw new ClosedError();
    const startedGeneration = generation;
    const k = symbol + ':ohlc:' + String(todayKey || 'unknown');
    const c = slowMap.get(k);
    if (c && now() - c.ts < slowTtl) return c.data;
    let obj = { open: null, high: null, low: null, prevClose: null };
    try {
      const history = await dailyHistory(symbol), res = history.data;
      const t = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
      const rows = [];
      for (let i = 0; i < t.length; i++) {
        if (q.close?.[i] == null) continue;
        const d = new Date((t[i] + (timezoneOffsetFor(symbol,t[i]*1000) ?? res.meta?.gmtoffset ?? 0)) * 1000);
        rows.push({ key: d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate(),
          o: q.open?.[i] ?? null, h: q.high?.[i] ?? null, l: q.low?.[i] ?? null, c: q.close[i] });
      }
      if (rows.length) {
        const last = rows[rows.length - 1];
        if (todayKey && last.key === todayKey) {          // 日线已含今日: 今日OHLC + 前一日收盘
          obj = { open: last.o, high: last.h, low: last.l, prevClose: rows.length > 1 ? rows[rows.length - 2].c : null };
        } else {                                          // 日线滞后: 今日OHLC未知, 昨收=最后一根日线收盘
          obj = { open: null, high: null, low: null, prevClose: last.c };
        }
      }
      if (closed || startedGeneration !== generation) throw new ClosedError();
      cacheSet(slowMap, k, { data: obj, ts: history.ts });
    } catch (e) { log.debug('[day ohlc fail]', { sym: symbol, err: String(e && e.message || e) }); if(c?.data)obj=c.data; }
    return obj;
  }

  // 多币种兑人民币汇率(各币种独立), 缓存 60s —— KRW/JPY/HKD 股票换算不能用美元率
  let fxCache = null;
  let fxInflight = null;
  let fxAsOf = null;
  let fxStale = true;
  let fxRetryAt = 0;
  const FX_SRC = Object.freeze(Object.fromEntries(FX_CURRENCIES.map(c=>[c,c==='USD'?'CNY=X':'USD'+c+'=X'])));
  async function getFxRates() {
    if (closed) throw new ClosedError();
    if (now() < fxRetryAt) return fxCache?.rates || {};
    if (fxCache && now() - fxCache.ts < 60000) return fxCache.rates;
    if (fxInflight) return fxInflight;                          // 单飞: 冷启动多符号共享一次汇率抓取
    fxInflight = (async () => {
      const startedGeneration = generation;
      let pairs = [], batchFailed = false;
      try {
        // P1-P4: Yahoo v7 quote 多符号一次批量查询
        const { cookie } = await getCrumb();
        const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(Object.values(FX_SRC).join(',')) + '&fields=regularMarketPrice';
        const r = await yGated((signal, remaining) => httpsGet(url, { Cookie: cookie }, { signal, timeout: remaining }));
        if (r.status !== 200) throw new Error('Yahoo FX HTTP '+r.status);
        let j; try { j = JSON.parse(r.body); } catch {}
        const rows = ((j && j.quoteResponse && j.quoteResponse.result) || []);
        const bySym = new Map(rows.map(x => [String(x.symbol || '').toUpperCase(), x.regularMarketPrice ?? null]));
        pairs = Object.entries(FX_SRC).map(([k, y]) => [k, bySym.get(y.toUpperCase()) ?? null]);
      } catch (e) { batchFailed = !!e.rateLimited || e.code === 'STOPPED' || e.code === 'DEADLINE' || closed; log.debug('[fx v7 fail]', { host: 'query1.finance.yahoo.com', err: String(e && e.message || e) }); }
      if (!batchFailed && (pairs.length < Object.keys(FX_SRC).length || pairs.some(([, v]) => v == null))) {
        // v7不可用/缺项时退回逐符号chart; 已有值不重复请求也不被覆盖
        const have = Object.fromEntries(pairs.filter(([, v]) => v != null));
        const missing=Object.entries(FX_SRC).filter(([k])=>!(Number.isFinite(have[k])&&have[k]>0)).slice(0,4);
        const filled = await Promise.all(missing.map(async ([k, y]) => {
          try { const res = await (chartOverride || fetchChart)(y, '?interval=5m&range=1d'); return [k, res?.meta?.regularMarketPrice ?? null]; }
          catch (e) { log.debug('[fx chart fail]', { pair: y, err: String(e && e.message || e) }); return [k, null]; }
        }));
        pairs=[...Object.entries(have),...filled];
      }
      if (closed || startedGeneration !== generation) throw new ClosedError();
      const fresh = Object.fromEntries(pairs.filter(([, v]) => Number.isFinite(v) && v > 0));
      if (!usableFxRates(fresh)) {
        fxStale = true;
        fxRetryAt = Math.max(now()+fxFailureCooldown,breaker?.state().until || 0);
        return fxCache ? fxCache.rates : {};
      }
      fxStale = false;
      fxRetryAt = fxStale ? now()+fxFailureCooldown : 0;
      fxAsOf = now();
      // Publish only this attempt's coherent set. Missing currencies disable
      // their own conversions, never borrow a previous attempt's old rate.
      fxCache = { rates: fresh, ts: fxAsOf };
      return fxCache.rates;
    })();
    const work=fxInflight;
    try { return await work; } finally { if(fxInflight===work)fxInflight = null; }
  }
  // 全失败时回退快照(供 fetchQuote 兜底; fxCache 为本模块私有态)
  function fxFallbackRates() { return fxCache ? fxCache.rates : {}; }
  function fxMetadata() { return { fxAsOf, fxStale: !!fxStale || fxAsOf == null || now()-fxAsOf>=60000, retryAt:fxRetryAt || null }; }

  async function getYahooDaily(symbol) {
    if (closed) throw new ClosedError();
    const startedGeneration = generation;
    const k = symbol + ':ydl';
    const c = slowMap.get(k);
    if (c && now() - c.ts < slowTtl) return c.data;
    let bars = [], source='yahoo', updatedAt=null;
    try {
      const history=await dailyHistory(symbol);bars=barsFrom(history.data);updatedAt=history.ts;
    } catch (e) { log.debug('[yahoo daily fail]', { symbol, err: String(e && e.message || e) }); }
    if (closed || startedGeneration !== generation) throw new ClosedError();
    // Yahoo 对部分A股指数日线只给1根 → Sina兜底, 结果并入同一缓存(每10分钟至多解析一次)
    if (/^\d{6}\.(SS|SZ)$/i.test(symbol) && bars.length < 30) {
      const sd = await getSinaDaily(symbol.toUpperCase());
      if (sd.length > bars.length) { bars = sd; source='sina';updatedAt=now(); }
    }
    if (closed || startedGeneration !== generation) throw new ClosedError();
    if (bars.length) cacheSet(slowMap, k, { data: bars, ts: updatedAt, source });
    return bars.length ? bars : c?.data || [];
  }

  function yahooDailyMetadata(symbol) {const c=slowMap.get(symbol+':ydl');return {source:c?.source || 'yahoo',updatedAt:c?.ts || null,stale:!c || now()-c.ts>=slowTtl};}

  function resetYahooState() {
    close(); reopen();dailyInflight.clear();
    fxCache = null; fxInflight = null; fxAsOf = null; fxStale = true; fxRetryAt = 0;
  }
  return { close, reopen, yahooDailyMetadata, RateLimitError, DeadlineError, yGated, fetchChart, fetchQuoteSummary, barsFrom, getDayOhlc, FX_SRC, getFxRates, fxFallbackRates, fxMetadata, getYahooDaily, resetYahooState };
}
