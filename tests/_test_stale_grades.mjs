// tests/_test_stale_grades.mjs — T4 stale分级 + T8 备源兜底去重契约测试(RED→GREEN)
// T4: getCachedQuote 三处返回 stale 的地方必须附分级 staleInfo:
//     熔断期   → { reason: 'rate-limited', etaMs: yahoo429Until-now }
//     失败冷却 → { reason: 'cooldown',     etaMs: 剩余冷却ms }
//     旧快照   → { reason: 'snapshot' }                    (无 etaMs —— 仅前两者有)
//     非 stale(新鲜/备源fb)绝不带 staleInfo 字段。
// T8: 三处 "腾讯备源 → stale" 骨架合一后, 行为不变: 三条路径只要备源有真实价, 一律返回备源(非 stale)。
process.env.PORT = '0';
process.env.CACHE_MS = '250';
process.env.QUOTE_MAX_AGE = '250';
process.env.Y_MIN_GAP = '10';
process.env.Y429_BASE = '2000';
process.env.Y429_CAP = '8000';
import http from 'node:http';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const META = { symbol: 'X', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
  gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000), instrumentType: 'ETF', previousClose: 475 };
const TX_SPY = 'v_usSPY="200~标普500指数ETF-SPDR~SPY.AM~770.50~765.16~767.90~12475933~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~5.34~0.70~770.63~764.53~USD~12475933~41500000000~~~~~~0.57~~~SPDR S&P 500 ETF Trust~~775.23~562.34~0~~~~13.60~-0.53~GP-ETF~~~1.28~0.20~2.82~~~1.58~~~770.50~~"';

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  const calls = { chart: 0, us: 0 };
  let mode = { yahoo: 'ok' };
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v8/finance/chart/')) {
      calls.chart++;
      if (mode.yahoo === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      const intraday = u.includes('interval=5m');
      const bars = intraday ? [480, 481] : [478, 479];
      return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { ...META, symbol: u.split('/chart/')[1].split('?')[0] }, timestamp: bars.map((c, i) => 1756000000 + i * 300), indicators: { quote: [{ open: bars.map(c => c - 0.5), high: bars.map(c => c + 1), low: bars.map(c => c - 1), close: bars, volume: bars.map(() => 1000) }] } }] } }) };
    }
    if (u.includes('qt.gtimg.cn/q=')) { calls.us++; return { status: 200, headers: {}, body: u.includes('usSPY') ? TX_SPY : '' }; }
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: null }) };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };
  const st = () => S.__test.yahoo429.state();

  // ===== T4-A. 新鲜报价不带 staleInfo =====
  console.log('[A] 新鲜/备源报价不带 staleInfo');
  S.__test.resetState();
  const q0 = await S.__deps.getCachedQuote('SPY');
  check('新鲜报价无 staleInfo 字段', !q0.stale && !('staleInfo' in q0), JSON.stringify(q0 && q0.staleInfo));

  // ===== T8-A. 三条路径备源优先(SPY 有腾讯备源) =====
  console.log('[B] T8: 三路径备源优先(骨架去重后行为不变)');
  S.__test.resetState();
  await S.__deps.getCachedQuote('SPY');            // 播种新鲜缓存
  mode.yahoo = 429;
  await sleep(400);                                 // 越过 CACHE_MS/QUOTE_MAX_AGE
  const b1 = await S.__deps.getCachedQuote('SPY'); // 上游故障 → catch → 备源
  check('路径③(上游故障): 备源有价则非 stale', !b1.stale && b1.price === 770.50 && !('staleInfo' in b1), JSON.stringify({ p: b1.price, s: b1.stale }));
  const b2 = await S.__deps.getCachedQuote('SPY'); // 已入熔断 → 备源
  check('路径①(熔断期): 备源有价则非 stale', !b2.stale && b2.price === 770.50 && !('staleInfo' in b2), JSON.stringify({ p: b2.price, s: b2.stale }));
  await sleep(2200);                                // 熔断窗(2s)过期, failAt 冷却(10s)仍活
  const b3 = await S.__deps.getCachedQuote('SPY'); // 失败冷却 → 备源
  check('路径②(失败冷却): 备源有价则非 stale', !b3.stale && b3.price === 770.50 && !('staleInfo' in b3), JSON.stringify({ p: b3.price, s: b3.stale }));

  // ===== T4-B. 0700.HK(无备源覆盖)三路径 staleInfo 分级 =====
  console.log('[C] T4: stale 三路径分级');
  S.__test.resetState();
  mode.yahoo = 'ok';
  await S.__deps.getCachedQuote('0700.HK');        // 播种(0700.HK 无腾讯/东财备源 → fb=null)
  mode.yahoo = 429;
  await sleep(400);
  const c1 = await S.__deps.getCachedQuote('0700.HK');   // 429 → catch → 无备源 → 旧快照(路径③)
  check('路径③(旧快照): stale 且 reason=snapshot', c1.stale === true && c1.staleInfo && c1.staleInfo.reason === 'snapshot', JSON.stringify(c1.staleInfo));
  check('路径③: 无 etaMs', c1.staleInfo && !('etaMs' in c1.staleInfo), JSON.stringify(c1.staleInfo));
  const chartAfterC1 = calls.chart;
  const c2 = await S.__deps.getCachedQuote('0700.HK');   // 熔断前半程(路径①)
  check('路径①(熔断): stale 且 reason=rate-limited', c2.stale === true && c2.staleInfo && c2.staleInfo.reason === 'rate-limited', JSON.stringify(c2.staleInfo));
  check('路径①: etaMs = 剩余熔断窗(0,2000]', typeof (c2.staleInfo && c2.staleInfo.etaMs) === 'number' && c2.staleInfo.etaMs > 0 && c2.staleInfo.etaMs <= 2000, 'eta=' + JSON.stringify(c2.staleInfo && c2.staleInfo.etaMs) + ' until=' + st().until);
  check('路径①: 纯 stale 不打上游', calls.chart === chartAfterC1, 'chart=' + calls.chart + '/' + chartAfterC1);
  await sleep(2200);                                 // 熔断窗过期, failAt 冷却仍活(路径②)
  const c3 = await S.__deps.getCachedQuote('0700.HK');
  check('路径②(冷却): stale 且 reason=cooldown', c3.stale === true && c3.staleInfo && c3.staleInfo.reason === 'cooldown', JSON.stringify(c3.staleInfo));
  check('路径②: etaMs = 剩余冷却(0,10000]', typeof (c3.staleInfo && c3.staleInfo.etaMs) === 'number' && c3.staleInfo.etaMs > 0 && c3.staleInfo.etaMs <= 10000, 'eta=' + JSON.stringify(c3.staleInfo && c3.staleInfo.etaMs));
}

main().then(() => { console.log('\n[STALE GRADES] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
