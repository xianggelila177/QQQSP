// tests/_test_429_smooth.mjs — YAHOO-429 平滑控频契约测试(RED→GREEN)
// v44 线上遗留问题: 沙箱 IP 对 Yahoo 的限流预算很小, 而 v44 仍有两个爆发点:
//   ① 冷启动/熔断到期时所有符号同时过期 → 一波 ~25 个并发上游请求 → 立刻再 429 → 熔断翻倍
//   ② fetchQuote 并行子请求中"部分成功"会取消活动熔断(成功路径清零 until) → 振荡
//   ③ 熔断期完全躺平, 无半开探针 → 恢复慢; 10min 封顶对实时面板太长
// 契约:
//   A. Yahoo 上游串行网关: 并发 chart 请求被 ≥Y_MIN_GAP 间隔串行化(去突发)
//   B. 温缓存控频: age<CACHE_MS 热缓存; CACHE_MS≤age<QUOTE_MAX_AGE 温缓存(不打上游);
//      age≥QUOTE_MAX_AGE 才真拉新 → 稳态上游速率 ≈ 符号数/QUOTE_MAX_AGE
//   C. 半开探针: 熔断过半后允许每窗口恰好一次真实探测; 成功且本次抓取无新 429 → 提前痊愈;
//      探测再 429 → 重新升窗
//   D. 窗口基准/封顶可调: 单次 429 → 窗口≈Y429_BASE; 连败翻倍, 封顶 Y429_CAP
process.env.PORT = '0';
process.env.CACHE_MS = '300';
process.env.QUOTE_MAX_AGE = '1200';
process.env.Y_MIN_GAP = '100';
process.env.Y429_BASE = '2000';
process.env.Y429_CAP = '8000';
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

  const calls = { chart: 0 };
  const chartTimes = [];
  let mode = { chart: 'ok' };
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v8/finance/chart/')) {
      calls.chart++;
      chartTimes.push(Date.now());
      if (mode.chart === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      const intraday = u.includes('interval=5m');
      return { status: 200, headers: {}, body: envelope({ ...META, symbol: u.split('/chart/')[1].split('?')[0] }, intraday ? [480, 481] : [478, 479]) };
    }
    if (u.includes('/v7/finance/quote')) return { status: 200, headers: {}, body: JSON.stringify({ quoteResponse: { result: [
      { symbol: 'CNY=X', regularMarketPrice: 7.12 }, { symbol: 'USDKRW=X', regularMarketPrice: 1380 },
      { symbol: 'USDJPY=X', regularMarketPrice: 151 }, { symbol: 'USDHKD=X', regularMarketPrice: 7.8 }] } }) };
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows: [] } } }) };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };
  const st = () => S.__test.yahoo429.state();

  // ===== A. 串行网关去突发 =====
  console.log('[A] 串行网关');
  S.__test.resetState();
  chartTimes.length = 0; calls.chart = 0;
  await Promise.all(['QQQ', 'SPY', 'NVDA', 'INTC'].map(s => S.__deps.getCachedQuote(s)));
  check('冷启动 4 符号全部拉新成功', calls.chart >= 4, 'chart=' + calls.chart);
  let minGap = Infinity;
  for (let i = 1; i < chartTimes.length; i++) minGap = Math.min(minGap, chartTimes[i] - chartTimes[i - 1]);
  check('上游 chart 调用被串行化(相邻间隔 ≥ Y_MIN_GAP-10ms)', chartTimes.length < 2 || minGap >= 90, 'minGap=' + minGap + 'ms n=' + chartTimes.length);

  // ===== B. 温缓存控频 =====
  console.log('[B] 温缓存控频');
  S.__test.resetState();
  calls.chart = 0;
  await S.__deps.getCachedQuote('QQQ');               // 播种
  const c0 = calls.chart;
  await sleep(500);                                    // age≈500ms: >CACHE_MS(300) <QUOTE_MAX_AGE(1200)
  const w1 = await S.__deps.getCachedQuote('QQQ');
  check('温缓存期不打上游(chart 计数不变)', calls.chart === c0, 'chart=' + calls.chart + '/' + c0);
  check('温缓存不标 stale(数据仍新鲜)', !w1.stale, String(w1.stale));
  await sleep(900);                                    // age≈1400ms ≥ QUOTE_MAX_AGE
  await S.__deps.getCachedQuote('QQQ');
  check('超过 QUOTE_MAX_AGE 后才真拉新', calls.chart > c0, 'chart=' + calls.chart + '/' + c0);

  // ===== C. 半开探针 + 成功不取消活动熔断 =====
  console.log('[C] 半开探针');
  S.__test.resetState();
  calls.chart = 0;
  await S.__deps.getCachedQuote('QQQ');
  await S.__deps.getCachedQuote('SPY');
  await S.__deps.getCachedQuote('NVDA');
  mode.chart = 429;
  await sleep(1300);                                   // 越过温缓存窗
  const s1 = await S.__deps.getCachedQuote('QQQ');     // 429 → 熔断(窗口≈2s)
  check('429 入熔断', s1.stale === true && st().until > Date.now(), JSON.stringify(st()));
  const c1 = calls.chart;
  const s2 = await S.__deps.getCachedQuote('SPY');     // 熔断前半程: 纯 stale
  check('熔断前半程不打上游', calls.chart === c1 && s2.stale === true, 'chart=' + calls.chart + '/' + c1);
  await sleep(1100);                                   // 越过半程(窗口2s的1s)
  mode.chart = 'ok';
  const before = calls.chart;
  const [p1, p2] = await Promise.all([S.__deps.getCachedQuote('SPY'), S.__deps.getCachedQuote('NVDA')]);
  check('过半程后允许探针: 有真实上游调用', calls.chart > before, 'chart=' + calls.chart + '/' + before);
  check('探针成功 → 提前痊愈(until=0)', st().until === 0, JSON.stringify(st()));
  check('探针符号返回新鲜数据', !p1.stale, String(p1.stale));
  check('探针排他: 同窗口其余符号仍回 stale', p2.stale === true, String(p2.stale));

  // ===== D. 窗口基准/翻倍/封顶 =====
  console.log('[D] 窗口参数');
  S.__test.resetState();
  calls.chart = 0;
  mode.chart = 'ok';
  await S.__deps.getCachedQuote('QQQ');                // 播种
  mode.chart = 429;
  await sleep(1300);
  await S.__deps.getCachedQuote('QQQ');                // 第一次 429: 窗口≈BASE(2s)
  let w1ms = st().until - st().setAt;
  check('单次 429 窗口 ≈ Y429_BASE', w1ms >= 1500 && w1ms <= 2600, 'w=' + w1ms + 'ms');
  await sleep(1100);                                   // 过半程 → 探针(仍 429) → 翻倍
  await S.__deps.getCachedQuote('QQQ');
  let w2ms = st().until - st().setAt;
  check('探针再 429 → 窗口翻倍(≈2×BASE)', w2ms >= 3500 && w2ms <= 4600, 'w=' + w2ms + 'ms');
  check('探针失败后 probeUsed 复位(下窗口可再探)', st().probeUsed === false, String(st().probeUsed));
}

main().then(() => { console.log('\n[429 SMOOTH] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
