import { volumeNumber } from '../quote-contract.js';
import { log as defaultLog } from '../../log.mjs';
import { timezoneOffsetFor } from '../../mkt.mjs';
import { priceSessionFor } from '../sessions.js';
import { tencentCodeFor, validWeek52Range } from '../instruments.js';
import { cacheSet as boundedCacheSet } from '../cache.js';
  // 腾讯响应中文两种形态的统一智能解码(v56, 合并原 txDecodeName 与 usSnapshot 内联 GBK 块):
  // ① smartbox: \uXXXX 转义串 ② qt.gtimg.cn: GBK 原始字节被 node 按 latin1 读成坏串。两处调用方共用。
export function decodeGbkSmart(s) {
    let out = String(s || '');
    if (/\\u([0-9a-fA-F]{4})/.test(out)) out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (/[\u0080-\u00ff]/.test(out)) {                                 // 仍含 latin1 高位字符 = GBK 字节被误读
      try {
        const gbk = new TextDecoder('gbk').decode(Buffer.from(out, 'latin1'));
        if (!gbk.includes('\ufffd')) out = gbk;                        // 解不出合法中文时保底原样
      } catch (e) { defaultLog.debug('[gbk decode fail]', { err: String(e && e.message || e) }); }
    }
    return out;
  }

  // ---- 腾讯 ~ 分隔行字段索引常量表(v56, 唯一事实源, 消除 usSnapshot/txQuoteSnapshot 双写漂移) ----
  // quote: qt.gtimg.cn 实时快照行(市场专属索引: cnQuote使用官网映射的67/68列52周字段; [30] 墙钟: A股='YYYYMMDDHHMMSS' 紧凑, 美股='YYYY-MM-DD HH:MM:SS')
  // day:   ifzq fqkline 日K行 [日期,开,收,高,低,量];  minute: ifzq 分时行 'HHMM 价格 累计量'(空格分隔)
export const TX_FIELDS = {
    quote: { name: 1, code: 2, price: 3, prevClose: 4, open: 5, volume: 6, time: 30, change: 31, changePct: 32, high: 33, low: 34, currency: 35, week52High: 48, week52Low: 49 },
    cnQuote: { name: 1, code: 2, price: 3, prevClose: 4, open: 5, volume: 6, time: 30, change: 31, changePct: 32, high: 33, low: 34, week52High:67,week52Low:68 },
    day: { date: 0, open: 1, close: 2, high: 3, low: 4, volume: 5 },
    minute: { hhmm: 0, price: 1, volume: 2 },
  };
  const TX_STR_FIELDS = new Set(['name', 'code', 'currency', 'date', 'time', 'hhmm']);   // 字符串字段(其余转数值, 非法→null)
  // 统一行解析: 输入一行原始串 + 分隔符, 按 TX_FIELDS[kind] 输出命名对象(raw=原始切分数组, 调用方各取所需)
export function txParseLine(line, kind = 'quote', sep = '~') {
    const f = String(line ?? '').split(sep);
    const out = { raw: f };
    for (const [k, i] of Object.entries(TX_FIELDS[kind] || {})) {
      if (TX_STR_FIELDS.has(k)) out[k] = f[i] == null ? '' : String(f[i]);
      else if(k==='volume')out[k]=volumeNumber(f[i]);
      else { const v = parseFloat(f[i]); out[k] = Number.isFinite(v) ? v : null; }
    }
    return out;
  }


export function createTencentProvider({ now = () => Date.now(), httpsGet, slowMap = new Map(), cacheSet = boundedCacheSet, log = defaultLog, slowTtl = 300000 } = {}) {
  let closed=false,generation=0;
  const ensure=owner=>{if(closed||owner!==generation)throw Object.assign(new Error('Provider stopped'),{code:'STOPPED'});};
  // lib/providers/tx.js — 腾讯行情备源(qt.gtimg.cn / ifzq.gtimg.cn / smartbox 共用字段解析)
  // 覆盖: A股 分钟线(全天)+日K(320根) 可用; 美股 ifzq 分时仅当前1分钟/日K仅基线1-2根 → 美股分时无备源(日K用 Nasdaq 补)

  // ---- 腾讯 ifzq 图表备源(v48): Yahoo/东财断供时的 K线与分时 ----
  const txChartCode = tencentCodeFor;
  async function txDailyBarsCn(symbol, n = 30) {
    const owner=generation;ensure(owner);              // A股日K(近n根, qfq 必需, 无 qfq 返回空)
    const code = txChartCode(symbol);
    if (!code || !/^s[hz]/.test(code)) return [];
    const k = 'txday:' + code + ':' + Math.max(1, Number(n) || 30);
    const c = slowMap.get(k);
    if (c && now() - c.ts < slowTtl) return c.data;
    let bars = [];
    try {
      const r = await httpsGet('https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,,,' + n + ',qfq');
      const j = JSON.parse(r.body);
      const node = (j && j.data && j.data[code]) || {};
      const rows = node.day || node.qfqday || [];
      bars = rows.map((row) => {
        const p = txParseLine(Array.isArray(row) ? row.join('~') : String(row), 'day');   // 行解析统一走 txParseLine(day 表: [日期,开,收,高,低,量])
        return { t: Math.floor(Date.parse(p.date + 'T00:00:00Z') / 1000), o: p.open, c: p.close, h: p.high, l: p.low, v: p.volume };
      }).filter(b => Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0).sort((a, b) => a.t - b.t);
    } catch (e) { log.debug('[tx daily fail]', { code, err: String(e && e.message || e) }); }
    ensure(owner);
    cacheSet(slowMap, k, { data: bars, ts: now() });
    return bars;
  }
  async function txMinuteBarsCn(symbol) {
    const owner=generation;ensure(owner);                     // A股分时(全天分钟线, {t,c,v} 北京时间 epoch 秒)
    const code = txChartCode(symbol);
    if (!code || !/^s[hz]/.test(code)) return [];
    const k = 'txmin:' + code;
    const c = slowMap.get(k);
    if (c && now() - c.ts < 60000) return c.data;
    let bars = [];
    try {
      const r = await httpsGet('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + code);
      const j = JSON.parse(r.body);
      const node = (j && j.data && j.data[code]) || {};
      const mins = (node.data && node.data.data) || [];
      let day = (node.data && node.data.date) || '';                 // A股: '20260903'
      if (!day) {
        const q30 = (node.qt && node.qt[code] && node.qt[code][30]) || '';
        day = String(q30).slice(0, 10).replace(/-/g, '');            // 美股兜底: '2026-09-03' → '20260903'
      }
      if (/^\d{8}$/.test(day)) {
        let cumulative = null, hasPrevious = false;
        for (const row of mins) {
          const p = txParseLine(String(row), 'minute', ' ');             // 行解析统一走 txParseLine(minute 表: 'HHMM 价格 累计量')
          const price = p.price;
          if (price == null || String(p.hhmm || '').length < 4) continue;
          const hhmm = String(p.hhmm);
          const t = Math.floor(Date.parse(day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8) + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2, 4) + ':00+08:00') / 1000);
          if (!Number.isFinite(t)) continue;
          const rawVolume = volumeNumber(p.volume);
          const volume = rawVolume == null ? null : !hasPrevious ? rawVolume : cumulative == null ? null : rawVolume < cumulative ? rawVolume : rawVolume - cumulative;
          cumulative = rawVolume; hasPrevious = true;
          bars.push({ t, c: price, v: volume, vUnit: 'shares', vMode: 'delta', source: 'tencent-cumulative' });
        }
        bars.sort((a, b) => a.t - b.t);
      }
    } catch (e) { log.debug('[tx minute fail]', { code, err: String(e && e.message || e) }); }
    ensure(owner);
    cacheSet(slowMap, k, { data: bars, ts: now() });
    return bars;
  }

  async function txQuoteSnapshot(s) {
    const m = /^(\d{6})\.(SS|SZ)$/.exec(s);
    if (!m) return null;
    const r = await httpsGet('https://qt.gtimg.cn/q=' + (m[2] === 'SS' ? 'sh' : 'sz') + m[1], { Referer: 'https://gu.qq.com/' });
    const mm = r.body.match(/v_[a-z]+\d+="([^"]*)"/);
    if (!mm) { log.debug('[tx snap empty]', { symbol: s, status: r.status }); return null; }
    const p = txParseLine(mm[1], 'cnQuote');                             // 统一字段解析(A股 [30]=紧凑墙钟)
    if (p.price == null || p.price <= 0) return null;
    let ts = null;
    const tm = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(p.time || ''));   // [30]=北京墙钟(紧凑格式)
    if (tm) ts = Date.UTC(+tm[1], +tm[2] - 1, +tm[3], +tm[4], +tm[5], +tm[6]) - 8 * 3600e3;
    if (!ts) return null;
    return { price: p.price, open: p.open, high: p.high, low: p.low, volume: p.volume, prevClose: p.prevClose, ts };
  }

  // ---- 美股腾讯备源(qt.gtimg.cn, v45): Yahoo 429/熔断/出口 IP 被封期间保持卡片活着 ----
  // 腾讯对该出口 IP 无限流(A股同主机长期 0 错误), 实测支持 usQQQ/usNVDA/usIXIC。
  // 字段序(~分隔): 3=现价 4=昨收 5=今开 6=量 30=墙钟(交易所本地) 31=涨跌 32=涨跌%
  // 33=最高 34=最低 35=币种 48/49=52周高/低 2=带后缀代码(.OQ=纳交)
  const usSnapCache = new Map();
  function usCodeOf(symbol) { const code = tencentCodeFor(symbol); return code?.startsWith('us') ? code : null; }
  async function usSnapshot(symbol) {
    const owner=generation;ensure(owner);
    const code = usCodeOf(symbol);
    if (!code) return null;
    const k = code.toUpperCase();
    const c = usSnapCache.get(k);
    if (c && now() - c.ts < (c.data ? 30000 : 60000)) return c.data;
    let out = null;
    try {
      // latin1 字节保真读 + 整段 GBK 智能解码(decodeGbkSmart 合并块): utf8 直接读会把中文名毁成 \ufffd(不可逆)
      const r = await httpsGet('https://qt.gtimg.cn/q=' + code, { Referer: 'https://gu.qq.com/' }, { encoding: 'latin1' });
      const body = decodeGbkSmart(r.body);
      const mm = body.match(/v_[A-Za-z]+="([^"]*)"/);
      const p = mm ? txParseLine(mm[1], 'quote') : null;               // 统一字段解析(美股 [30]='YYYY-MM-DD HH:MM:SS', 此处仅透传快照时刻)
      const price = p ? p.price : null;
      if (r.status === 200 && p && price > 0) {
        const tm = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(p.time || ''));
        const naive = tm ? Date.UTC(+tm[1], +tm[2] - 1, +tm[3], +tm[4], +tm[5], +tm[6]) : NaN;
        const ts = Number.isFinite(naive) ? naive - timezoneOffsetFor('^GSPC', naive) * 1000 : null;
        out = { price, name: p.name || '', code: p.code || '', prevClose: p.prevClose, open: p.open, volume: p.volume,
          change: p.change, changePct: p.changePct, dayHigh: p.high, dayLow: p.low,
          currency: p.currency || 'USD', priceSession:priceSessionFor(symbol,ts),instrumentType:p.raw.includes('GP-ETF')?'ETF':undefined, ...validWeek52Range(p.week52High, p.week52Low), ts: Number.isFinite(ts) ? ts : null };
      }
    } catch (e) { log.debug('[us snap fail]', { symbol: symbol, err: String(e && e.message || e) }); }
    ensure(owner);
    cacheSet(usSnapCache, k, { data: out, ts: now() });
    return out;
  }
  function resetTxState() { usSnapCache.clear(); }   // usFailAt 熔断计数归零(usSnapCache 由组合根 resetState 统一 clear)
  return { close:()=>{closed=true;generation++;},reopen:()=>{closed=false;},txDailyBarsCn, txMinuteBarsCn, decodeGbkSmart, TX_FIELDS, txParseLine, txQuoteSnapshot, usCodeOf, usSnapshot, resetTxState, usSnapCache };
}
