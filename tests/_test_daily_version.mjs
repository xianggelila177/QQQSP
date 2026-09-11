// tests/_test_daily_version.mjs — P1-P1 /api/market 响体冗余回归测试
// 问题: 每2s轮询都重传 daily30(~16KB, 数据5min不变)
// 期望: 响应体带 daily30Version(最新日线bar的秒级ts); SLOW_TTL 内两次请求版本不变 → 前端可据此跳过更新
process.env.PORT = '0';
process.env.CACHE_MS = '300';   // 缩短行情缓存, 让第二次请求真正重跑 fetchQuote
process.env.QUOTE_MAX_AGE = '300';   // v45 温缓存控频: 与 CACHE_MS 对齐, 保持"第二次请求重跑"的原断言语义
import http from 'node:http';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 确定性上游桩 ----
const META = { symbol: 'QQQ', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
  gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000),
  instrumentType: 'ETF', previousClose: 475 };
const DAY = 86400;
const END = 1756000000;   // 固定结束bar(不随墙钟漂移)
function genBars(n, stepSec, endSec) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const t = endSec - i * stepSec; const c = 480 + (n - i) * 0.01; out.push({ t, o: c - 0.5, h: c + 1, l: c - 1, c, v: 1000 + i }); }
  return out;
}
function envelope(meta, bars) {
  return JSON.stringify({ chart: { result: [{ meta, timestamp: bars.map(b => b.t),
    indicators: { quote: [{ open: bars.map(b => b.o), high: bars.map(b => b.h), low: bars.map(b => b.l), close: bars.map(b => b.c), volume: bars.map(b => b.v) }] } }] } });
}
const INTRA_BARS = genBars(20, 300, END);
const DAILY_6MO = genBars(130, DAY, END - 3 * DAY);
const DAILY_6D = genBars(5, DAY, END);

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);
  const port = S.httpServer.address().port;

  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v7/finance/quote')) return { status: 200, headers: {}, body: JSON.stringify({ quoteResponse: { result: [
      { symbol: 'CNY=X', regularMarketPrice: 7.12 }, { symbol: 'USDKRW=X', regularMarketPrice: 1380 },
      { symbol: 'USDJPY=X', regularMarketPrice: 151 }, { symbol: 'USDHKD=X', regularMarketPrice: 7.8 }] } }) };
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows:
      DAILY_6D.slice(-5).reverse().map((b, i) => ({ date: new Date(b.t * 1000).toISOString().slice(0, 10).replace(/-/g, '/'),
        open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c), volume: String(b.v) })) } } }) };
    if (u.includes('includePrePost')) return { status: 200, headers: {}, body: envelope(META, INTRA_BARS) };
    if (u.includes('range=6mo')) return { status: 200, headers: {}, body: envelope(META, DAILY_6MO) };
    if (u.includes('range=6d')) return { status: 200, headers: {}, body: envelope(META, DAILY_6D) };
    return { status: 404, headers: {}, body: '' };
  };

  const get = (path) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); }).on('error', rej));

  console.log('[T1] 首次请求携带 daily30Version');
  const j1 = JSON.parse(await get('/api/market?symbols=QQQ'))[0];
  check('daily30Version 为正数', typeof j1.daily30Version === 'number' && j1.daily30Version > 0, 'v=' + JSON.stringify(j1.daily30Version));
  check('charts.daily30 存在且非空', Array.isArray(j1.charts?.daily30) && j1.charts.daily30.length > 0, 'n=' + (j1.charts?.daily30 || []).length);
  check('daily30Version = 日K内容修订号', Number.isSafeInteger(j1.daily30Version) && j1.daily30Version > 0, JSON.stringify({ v: j1.daily30Version }));

  console.log('[T2] 超过 CACHE_MS 后二次请求: 版本与内容均不变(SLOW_TTL 内)');
  await sleep(Number(process.env.CACHE_MS) + 300);
  const j2 = JSON.parse(await get('/api/market?symbols=QQQ'))[0];
  check('第二次请求确实重跑了(fetchAt不同)', j2.fetchedAt !== j1.fetchedAt, JSON.stringify({ a: j1.fetchedAt, b: j2.fetchedAt }));
  check('daily30Version 不变', j2.daily30Version === j1.daily30Version, JSON.stringify({ v1: j1.daily30Version, v2: j2.daily30Version }));
  check('daily30 内容逐字节一致', JSON.stringify(j2.charts.daily30) === JSON.stringify(j1.charts.daily30), 'len=' + (j1.charts.daily30 || []).length + '/' + (j2.charts.daily30 || []).length);
  check('其余字段照常(price/market)', j2.price != null && j2.market === '美股', JSON.stringify({ p: j2.price, m: j2.market }));
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
