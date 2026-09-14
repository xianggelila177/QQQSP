// T3 "连接正常"标签诚实化 v2 —— vm 沙箱行为测试(2026-09-04 用户报告后修订)
// 用户报告: 明明刚刷新成功, 顶栏却显示「更新于 16.5 小时前」。
// 根因: v1 契约用「最旧符号的数据 ts」驱动顶栏, 而全球自选里总有市场处于收盘
//       (如 ^IXIC 的 regularMarketTime 冻结在昨夜美股收盘 ≈16.5h) → 顶栏永远显示 N 小时前。
// v2 契约: 顶栏「更新于」只反映**响应新鲜度**(lastRefresh 距今); 收盘市场的数据年龄由
//          卡片上的「已收盘」chip 表达, 不再污染顶栏。
//   A. updateAtInfo(s, anyStale): anyStale → 「部分延迟」; s≤15 → 「连接正常」;
//      16~89s → 「更新于 Ns 前」; ≥90s → 人性化(分钟/小时, 50000s → 13.9 小时前)
//   B. 回归(用户 bug): 自选含收盘市场(ts 冻结 16.5h) + 刚刷新成功 → 顶栏「连接正常」而非「N 小时前」
//   C. 集成: refresh 后 tickClock 驱动顶栏; anyStale 仍优先「部分延迟」
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };

const mkQ = (sym, extra = {}) => ({
  symbol: sym, price: 480, change: 1.2, changePct: 0.25,
  open: 479, dayHigh: 482, dayLow: 477, prevClose: 478.8,
  volume: 3131131, week52High: 620, week52Low: 210,
  marketState: 'REGULAR', currency: 'USD', name: 'X',
  charts: { intraday: [{ t: Math.floor(Date.now() / 1000) - 30, c: 480, v: 900 }] },
  ...extra,
});

try {
  const env = await loadApp({ fakeWorker: true, watchlist: ['QQQ', '^IXIC'] });
  await env.drain();
  const H = () => env.hooks();
  const info = (...a) => H().updateAtInfo(...a);

  // ---- A. 纯函数: 响应新鲜度分档 ----
  ok(info(0, false).text === '连接正常' && info(0, false).stale === false, 'A1 s=0 → 「连接正常」非stale');
  ok(info(15, false).text === '连接正常', 'A2 s=15(边界) → 仍「连接正常」档');
  ok(info(16, false).text === '更新于 16s 前' && info(16, false).stale === true, 'A3 s=16 → 「更新于 16s 前」且置stale');
  ok(info(7, true).text.includes('延迟'), 'A4 anyStale 优先 → 「部分延迟」');
  ok(info(50000, false).text === '更新于 13.9 小时前' && info(50000, false).stale === true, 'A5 大龄 50000s → 「更新于 13.9 小时前」(用户 5 万秒场景)');

  // ---- B. 用户 bug 回归: 收盘市场不污染顶栏 ----
  console.log('[B] 收盘市场回归(用户报告场景)');
  const CLOSED_TS = Date.now() - 16.5 * 3600 * 1000;   // ^IXIC: ts 冻结在昨夜美股收盘(≈16.5h 前)
  await refreshWith([mkQ('QQQ', { ts: Date.now() - 1000 }), mkQ('^IXIC', { ts: CLOSED_TS, marketState: 'CLOSED' })]);
  ok(H().lastDataRef().some(d => d.symbol === '^IXIC' && d.marketState === 'CLOSED'), 'B3 收盘市场数据仍在列表(卡片以「已收盘」chip 表达)');
  await tick();
  ok(B_ua().textContent === '连接正常', 'B1 刚刷新成功 + 列表含收盘市场 → 顶栏「连接正常」(而非 16.5 小时前)', B_ua().text);
  ok(!B_ua().classList.contains('stale'), 'B2 顶栏无 stale class(收盘不是故障)', B_ua().className);

  // ---- C. 集成: 响应新鲜度驱动顶栏 ----
  await refreshWith([mkQ('QQQ')]);   // 刚刷新: lastRefresh=now
  await tick();
  ok(B_ua().textContent === '连接正常', 'C1 刚刷新 → 「连接正常」', B_ua().text);

  H().lastRefreshSet(Date.now() - 30000);   // 响应 30s 未成功刷新
  await tick();
  ok(B_ua().textContent === '更新于 30s 前' && B_ua().classList.contains('stale'), 'C2 响应 30s 前 → 「更新于 30s 前」+stale', B_ua().text);

  // 任一卡 stale(后端标记) → 「部分延迟」优先于响应新鲜度
  await refreshWith([mkQ('QQQ', { stale: true, staleInfo: { reason: 'rate-limited', etaMs: 30000 } })]);
  await tick();
  ok(B_ua().textContent.includes('延迟'), 'C3 后端 stale 标记 → 「部分延迟」优先', B_ua().text);

  // ---- D. 旧调用兼容 ----
  ok(String(info(30, false).text).includes('更新于'), 'D1 (30,false) → 「更新于 Ns 前」(旧契约)');

  function refreshWith(bodies) { return (async () => { if (!bodies.some(d => d.symbol === '^IXIC')) bodies = [...bodies, mkQ('^IXIC', { ts: CLOSED_TS, marketState: 'CLOSED' })]; env.fetch.push('market', { body: bodies }); await H().refresh(false); await env.drain(); })(); }
  function tick() { H().tickClock(); return await2(); }
  function await2() { return new Promise(r => setImmediate(r)); }
  function B_ua() { return env.byId('updateAt'); }
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T3 honest_realtime v2] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
