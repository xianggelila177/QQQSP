// T1 图表条件传输客户端 —— vm 沙箱行为测试
// 契约:
//   A. refresh() 请求拼 &cv=SYM:iVer:dVer;...(每个自选符号, 无缓存用 0)
//   B. 响应 charts.intraday/daily30 === 'same' → 复用本地缓存数组(引用相等), 不重建
//   C. intradayLast:[t,c] → 原位更新缓存最后一根 t/c(引用不变, 值可见)
//   D. 防御: 'same' 但本地无缓存/ver 为 0 → 当作空数组, 不崩溃; 畸形 intradayLast 无害;
//      全量数组 + 版本入库; 旧后端同版本全量重发仍复用旧引用
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };

const now = Math.floor(Date.now() / 1000);
const mkQ = (sym, extra = {}) => ({
  symbol: sym, price: 480, change: 1.2, changePct: 0.25,
  open: 479, dayHigh: 482, dayLow: 477, prevClose: 478.8,
  volume: 3131131, week52High: 620, week52Low: 210,
  marketState: 'REGULAR', currency: 'USD', name: 'X',
  charts: { intraday: [{ t: now - 30, c: 480, v: 900 }], daily30: [{ t: now - 86400, o: 470, h: 481, l: 469, c: 479, v: 800 }] },
  ...extra,
});
const lastMarketUrl = (env) => env.fetchLog.filter(u => u.includes('/api/market')).pop() || '';

try {
  const env = await loadApp();
  await env.drain();
  const H = () => env.hooks();

  // ---- A. 首次请求: 无缓存 → 全 0 版本 (cv 经 encodeURIComponent 编码) ----
  ok(lastMarketUrl(env).includes('&cv=QQQ%3A0%3A0%3BSPY%3A0%3A0'),
    'A1 首次 /api/market 请求拼 &cv=QQQ:0:0;SPY:0:0(每自选符号, 无缓存用0)', lastMarketUrl(env));

  // ---- B. 全量响应入库带版本 ----
  const iBars = [
    { t: now - 60, c: 479, v: 900 },
    { t: now - 30, c: 479.5, v: 900 },
    { t: now, c: 480, v: 900 },
  ];
  const dBars = [
    { t: now - 86400 * 2, o: 470, h: 481, l: 469, c: 479, v: 800 },
    { t: now - 86400, o: 479, h: 483, l: 478, c: 481, v: 800 },
  ];
  env.fetch.push('market', { body: [mkQ('QQQ', { charts: { intraday: iBars, daily30: dBars }, intradayVer: 101, daily30Version: 202 })] });
  await H().refresh(false);
  await env.drain();
  const q = H().cardCache.get('QQQ');
  ok(!!q, 'B0 卡片已创建');
  const iRef = q.d.charts.intraday, dRef = q.d.charts.daily30;
  const ic = H().intradayCacheRef().QQQ, dc = H().daily30CacheRef().QQQ;
  ok(ic && ic.ver === 101 && ic.bars === iRef, 'B1 全量分时入库 intradayCache {ver:101, bars:数组引用}');
  ok(dc && dc.ver === 202 && dc.bars === dRef, 'B2 全量日K入库 daily30Cache {ver:202, bars:数组引用}');

  // ---- C. 'same' 复用缓存 + intradayLast 原位补丁; 请求携带已入库版本 ----
  env.fetch.push('market', { body: [mkQ('QQQ', { charts: { intraday: 'same', daily30: 'same' }, intradayVer: 101, daily30Version: 202, intradayLast: [now + 30, 481.25] })] });
  await H().refresh(false);
  await env.drain();
  ok(lastMarketUrl(env).includes('&cv=QQQ%3A101%3A202%3BSPY%3A0%3A0'),
    'C1 入库后请求携带 &cv=QQQ:101:202;SPY:0:0', lastMarketUrl(env));
  ok(q.d.charts.intraday === iRef, "C2 charts.intraday === 'same' → 复用缓存数组(引用相等, 服务端未重发)");
  ok(q.d.charts.daily30 === dRef, "C3 charts.daily30 === 'same' → 复用缓存数组(引用相等)");
  ok(iRef[2].t === now + 30 && iRef[2].c === 481.25,
    'C4 intradayLast [t,c] 原位更新缓存最后一根(前2根不动: t=' + iRef[0].t + ')');

  // ---- D. 防御: 无缓存 'same' → 空数组; 畸形 intradayLast; 无 charts 字段 ----
  env.fetch.push('market', { body: [
    mkQ('SPY', { charts: { intraday: 'same', daily30: 'same' }, intradayVer: 5, daily30Version: 6, intradayLast: 'garbage' }),
    mkQ('QQQ', { charts: undefined }),
  ] });
  await H().refresh(false);
  await env.drain();
  const spy = H().cardCache.get('SPY');
  ok(Array.isArray(spy.d.charts.intraday) && spy.d.charts.intraday.length === 0, "D1 'same' 但本地无缓存 → 分时按空数组处理");
  ok(Array.isArray(spy.d.charts.daily30) && spy.d.charts.daily30.length === 0, "D2 'same' 但本地无缓存 → 日K按空数组处理");
  ok(!H().intradayCacheRef().SPY, "D3 'same' 防御路径不污染缓存(无 SPY 缓存条目)");
  ok(iRef[2].c === 481.25, "D4 畸形 intradayLast('garbage') 无害, 缓存最后一根保持原值");
  ok(!!H().cardCache.get('QQQ').d, 'D5 响应缺 charts 字段 → 不崩溃, 卡片照常保活');

  // ---- E. 旧后端兼容: 同版本全量重发仍复用旧引用 ----
  env.fetch.push('market', { body: [mkQ('QQQ', { charts: { intraday: [{ t: now, c: 999, v: 1 }], daily30: [] }, intradayVer: 101, daily30Version: 202 })] });
  await H().refresh(false);
  await env.drain();
  ok(q.d.charts.intraday === iRef, 'E1 同版本全量重发(旧后端) → 仍复用缓存旧引用, 不重处理');
  ok(q.d.charts.daily30 === dRef, 'E2 日K同版本全量重发 → 复用旧引用');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T1 chart_conditional] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
