import { volumeNumber } from '../quote-contract.js';
import { log as defaultLog } from '../../log.mjs';
import { cacheSet as boundedCacheSet } from '../cache.js';
export function createSinaProvider({ now = () => Date.now(), httpsGet, slowMap = new Map(), cacheSet = boundedCacheSet, log = defaultLog, slowTtl = 300000 } = {}) {
  let closed=false,generation=0;
  const ensure=owner=>{if(closed||owner!==generation)throw Object.assign(new Error('Provider stopped'),{code:'STOPPED'});};
  // Sina daily history fallback. Cache and failure cooldown are owned by the
  // provider so the composition root only wires lifecycle dependencies.

  const sinaCache = new Map();
  const sinaFailAt = new Map();
  function resetSina() { sinaCache.clear(); sinaFailAt.clear(); }

  async function getSinaDaily(symbol) {
    const owner=generation;ensure(owner);
    const m = /^(\d{6})\.(SS|SZ)$/.exec(String(symbol).toUpperCase());
    if (!m) return [];
    const k = symbol + ':sina';
    const c = sinaCache.get(k);
    if (c && now() - c.ts < slowTtl) return c.data;
    const f = sinaFailAt.get(k);
    if (f && now() - f < 60000) return [];
    try {
      const code = (m[2] === 'SS' ? 'sh' : 'sz') + m[1];
      const r = await httpsGet('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + code + '&scale=240&ma=no&datalen=1023', { Referer: 'https://finance.sina.com.cn' });
      ensure(owner);
      let arr;
      try { arr = JSON.parse(r.body); } catch { log.warn('[sina] json fail', { symbol, status: r.status, head: r.body.slice(0, 80) }); }
      if (!Array.isArray(arr)) return [];
      const num = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
      const bars = arr.map(x => ({
        t: Math.floor(new Date(String(x.day).includes(' ') ? String(x.day).replace(' ', 'T') + '+08:00' : String(x.day) + 'T00:00:00+08:00').getTime() / 1000),
        o: num(x.open), h: num(x.high), l: num(x.low), c: num(x.close), v: volumeNumber(x.volume),
      })).filter(b => b.c != null && b.t > 0).reverse();
      if (bars.length) { (cacheSet || ((m, key, value) => m.set(key, value)))(sinaCache, k, { data: bars, ts: now() }); sinaFailAt.delete(k); }
      else { (cacheSet || ((m, key, value) => m.set(key, value)))(sinaFailAt, k, now()); }
      return bars;
    } catch (e) {
      ensure(owner);
      log.debug('[sina daily fail]', { symbol, err: String(e?.message || e) });
      (cacheSet || ((m, key, value) => m.set(key, value)))(sinaFailAt, k, now());
      return sinaCache.get(k)?.data || [];
    }
  }
  return { close:()=>{closed=true;generation++;},reopen:()=>{closed=false;},sinaCache, sinaFailAt, resetSina, getSinaDaily };
}
