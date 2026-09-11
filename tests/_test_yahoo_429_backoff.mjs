// tests/_test_yahoo_429_backoff.mjs — YAHOO-429 退避与熔断契约测试(RED→GREEN)
// 线上问题: Yahoo 边缘 429("Edge: Too Many Requests")期间, 服务端自我强化风暴导致全部/部分
// 卡片长期"数据延迟":
//   1) getCrumb 把 429 错误体当 crumb 缓存 55 分钟(不查状态码)
//   2) fetchChart 拿到 429 仍重试并重置 crumb → 每符号每次尝试 ~5 个上游请求
//   3) failAt 冷却固定 10s 无退避 → 限流器永远得不到喘息
// 契约:
//   A. fetchChart 收到 429: 抛 RateLimitError, 不重试(1 次即停), 不重置/重取 crumb
//   B. getCrumb 收到非 200(429 错误体): 不缓存垃圾, 进入 30s 负缓存短路, 不反复打 fc.yahoo/getcrumb
//   C. 全局熔断: 任一 429 后, 熔断窗口内所有符号直接回 stale 快照, 完全不打上游
//   D. per-symbol 冷却指数退避: 10s→20s→40s…封顶 120s; 成功后复位
//   E. 恢复痊愈: 上游恢复后(状态清空)正常拉新, stale 解除, 熔断/退避状态复位
process.env.PORT = '0';
process.env.CACHE_MS = '300';
process.env.QUOTE_MAX_AGE = '300';   // v45 温缓存控频: 本测试聚焦熔断契约, 令温缓存窗退化=热缓存窗
import http from 'node:http';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const META = { symbol: 'X', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
  gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000),
  instrumentType: 'ETF', previousClose: 475 };
function envelope(meta, closes) {
  const bars = closes.map((c, i) => ({ t: 1756000000 + i * 300, o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 }));
  return JSON.stringify({ chart: { result: [{ meta, timestamp: bars.map(b => b.t),
    indicators: { quote: [{ open: bars.map(b => b.o), high: bars.map(b => b.h), low: bars.map(b => b.l), close: bars.map(b => b.c), volume: bars.map(b => b.v) }] } }] } });
}

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  // ---- 可编程上游桩: 按 URL 分端点, 行为可切换, 全量计数 ----
  const calls = { fc: 0, crumb: 0, chart: 0, other: 0 };
  let mode = { crumb: 'ok', chart: 'ok' };          // 'ok' | 429 | 500
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) { calls.fc++; return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' }; }
    if (u.includes('getcrumb')) {
      calls.crumb++;
      if (mode.crumb === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      return { status: 200, headers: {}, body: 'ok-crumb' };
    }
    if (u.includes('/v8/finance/chart/')) {
      calls.chart++;
      if (mode.chart === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      if (mode.chart === 500) return { status: 500, headers: {}, body: 'oops' };
      const intraday = u.includes('interval=5m');
      return { status: 200, headers: {}, body: envelope({ ...META, symbol: u.split('/chart/')[1].split('?')[0] }, intraday ? [480, 481] : [478, 479]) };
    }
    if (u.includes('/v7/finance/quote')) return { status: 200, headers: {}, body: JSON.stringify({ quoteResponse: { result: [
      { symbol: 'CNY=X', regularMarketPrice: 7.12 }, { symbol: 'USDKRW=X', regularMarketPrice: 1380 },
      { symbol: 'USDJPY=X', regularMarketPrice: 151 }, { symbol: 'USDHKD=X', regularMarketPrice: 7.8 }] } }) };
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows:
      [{ date: '09/01/2026', open: '470', high: '482', low: '469', close: '480', volume: '1' }] } } }) };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    calls.other++; return { status: 404, headers: {}, body: '' };
  };

  const has429 = !!S.__test?.yahoo429;
  check('暴露 __test.yahoo429 测试接缝(state/expire/backoffMs)', has429, String(Object.keys(S.__test || {})));

  // ===== A. fetchChart: 429 → RateLimitError, 不重试, 不动 crumb =====
  console.log('[A] fetchChart 429 行为');
  S.__test.resetState();
  S.__test.seedCrumb('seeded-crumb');
  mode = { crumb: 'ok', chart: 429 };
  let threw = null;
  try { await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d'); } catch (e) { threw = e; }
  check('429 时抛错', !!threw, String(threw));
  check('抛 RateLimitError(带 rateLimited 标记)', threw && (threw.name === 'RateLimitError' || threw.rateLimited === true), String(threw && (threw.name + '/' + threw.rateLimited)));
  check('429 不重试: chart 仅 1 次调用', calls.chart === 1, 'chart=' + calls.chart);
  check('429 不重取 crumb: fc/getcrumb 0 次调用', calls.fc === 0 && calls.crumb === 0, 'fc=' + calls.fc + ' crumb=' + calls.crumb);
  check('进入全局熔断窗口(until > now)', S.__test?.yahoo429?.state?.().until > Date.now(), JSON.stringify(S.__test?.yahoo429?.state?.()));

  // ===== B. getCrumb: 429 错误体不缓存 + 负缓存短路 =====
  console.log('[B] getCrumb 429 卫生');
  S.__test.resetState();
  calls.fc = 0; calls.crumb = 0; calls.chart = 0;
  mode = { crumb: 429, chart: 'ok' };
  threw = null;
  try { await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d'); } catch (e) { threw = e; }
  check('getcrumb 429 时 fetchChart 抛错(不缓存垃圾 crumb)', !!threw, String(threw));
  const snap1 = S.__test?.yahoo429?.state?.();
  check('错误体未被当 crumb 使用(chart 未执行)', calls.chart === 0, 'chart=' + calls.chart);
  threw = null;
  try { await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d'); } catch (e) { threw = e; }
  check('负缓存短路: 第二次不再打 fc/getcrumb', calls.fc === 1 && calls.crumb === 1, 'fc=' + calls.fc + ' crumb=' + calls.crumb);
  check('负缓存有窗口期(crumbFailUntil > now)', snap1 && snap1.crumbFailUntil > Date.now(), JSON.stringify(snap1));
  mode = { crumb: 'ok', chart: 'ok' };
  S.__test?.yahoo429?.expire?.();
  let ok = false;
  try { const r = await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d'); ok = !!(r && r.meta && r.meta.regularMarketPrice); } catch (e) { threw = e; }
  check('负缓存过期+crumb 恢复后 fetchChart 成功', ok, String(threw));

  // ===== C. getCachedQuote: 全局熔断期内不打上游, 全员 stale =====
  console.log('[C] 全局熔断');
  S.__test.resetState();
  calls.chart = 0;
  mode = { crumb: 'ok', chart: 'ok' };
  const q0 = await S.__deps.getCachedQuote('QQQ');
  const q0s = await S.__deps.getCachedQuote('SPY');
  const q0n = await S.__deps.getCachedQuote('NVDA');
  check('前置: 三符号均成功拉新且非 stale', !q0.stale && !q0s.stale && !q0n.stale, JSON.stringify({ a: !!q0.stale, b: !!q0s.stale, c: !!q0n.stale }));
  const chartBefore = calls.chart;
  mode = { crumb: 'ok', chart: 429 };
  await sleep(350);   // 越过 CACHE_MS: 让播种的缓存过期, 迫使 429 调用真正走到 fetch 路径
  const s1 = await S.__deps.getCachedQuote('QQQ');
  check('429 符号: 回 stale 快照不 5xx', s1.stale === true && s1.price != null, JSON.stringify({ stale: s1.stale, p: s1.price }));
  const chartAfterQ = calls.chart;
  check('429 尝试确实打过上游(chart 计数增长)', chartAfterQ > chartBefore, 'before=' + chartBefore + ' after=' + chartAfterQ);
  const s2 = await S.__deps.getCachedQuote('SPY');
  const s3 = await S.__deps.getCachedQuote('NVDA');
  check('熔断期其他符号不打上游(chart 计数不再增长)', calls.chart === chartAfterQ, 'before=' + chartBefore + ' afterQ=' + chartAfterQ + ' afterAll=' + calls.chart);
  check('熔断期其他符号返回 stale 快照', s2.stale === true && s3.stale === true, JSON.stringify({ b: s2.stale, c: s3.stale }));
  check('熔断窗口 ≈ Y429_BASE(30s, v45 基准下调)', (() => { const w = S.__test.yahoo429.state().until - Date.now(); return w > 25000 && w <= 35000; })(), String(S.__test.yahoo429.state().until - Date.now()));

  // ===== D. per-symbol 指数退避 =====
  console.log('[D] 指数退避');
  const bk = S.__test.yahoo429.backoffMs;
  check('backoffMs(1)=10s', bk(1) === 10000, String(bk(1)));
  check('backoffMs(2)=20s', bk(2) === 20000, String(bk(2)));
  check('backoffMs(3)=40s', bk(3) === 40000, String(bk(3)));
  check('backoffMs(8) 封顶 120s', bk(8) === 120000, String(bk(8)));
  check('backoffMs(20) 封顶 120s', bk(20) === 120000, String(bk(20)));

  // ===== E. 恢复痊愈(完整往返: 成功播种 → 429 失败入熔断 → 时间旅行过期 → 上游恢复 → 自动痊愈) =====
  console.log('[E] 恢复痊愈');
  S.__test.resetState();
  calls.chart = 0;
  mode = { crumb: 'ok', chart: 'ok' };
  const e0 = await S.__deps.getCachedQuote('QQQ');
  check('前置: 播种成功非 stale', !e0.stale && e0.price != null, JSON.stringify({ stale: !!e0.stale }));
  mode = { crumb: 'ok', chart: 429 };
  await sleep(350);
  const e1 = await S.__deps.getCachedQuote('QQQ');
  check('429 失败: 入熔断且回 stale', e1.stale === true && S.__test.yahoo429.state().until > Date.now(), JSON.stringify(S.__test.yahoo429.state()));
  S.__test.yahoo429.expire();          // 时间旅行: 熔断/冷却窗口全部视为已过期
  mode = { crumb: 'ok', chart: 'ok' };
  const r1 = await S.__deps.getCachedQuote('QQQ');
  check('上游恢复后拉新成功且非 stale', !r1.stale && r1.price != null, JSON.stringify({ stale: !!r1.stale, p: r1.price }));
  const st = S.__test.yahoo429.state();
  check('成功后熔断/连败状态复位', st.until === 0 && st.streak === 0, JSON.stringify(st));
  const chartSnap = calls.chart;
  const r2 = await S.__deps.getCachedQuote('QQQ');
  check('CACHE_MS 内二次请求走缓存不再打上游', calls.chart === chartSnap && !r2.stale, 'chart=' + calls.chart + '/' + chartSnap);
}

main().then(() => { console.log('\n[YAHOO-429 backoff] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
