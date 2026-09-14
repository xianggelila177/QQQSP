// tests/_test_us_fallback.mjs — 美股腾讯备源契约测试(RED→GREEN)
// 场景: 沙箱出口 IP 被 Yahoo 边缘硬封(连 getcrumb 都 429), 退避/熔断只能防自我放大,
// 无法变出数据 → 美股卡片永远 stale。而同主机的腾讯源(A股在用)对该 IP 零限流,
// 且 qt.gtimg.cn 支持美股(usQQQ/usNVDA 的字段格式由固定样本验证；不推断caret指数支持)。
// 契约:
//   A. Yahoo 429/熔断期: 美股符号自动降级到腾讯快照 → 卡片有价、非 stale
//   B. 腾讯快照自带 30s 缓存(成功)/60s 负缓存, 熔断期高频轮询不打爆腾讯
//   C. 代码映射: QQQ→usQQQ, 未验证caret指数不映射; A股(.SS/.SZ)绝不走 us 路径(有专属 cnSnapshot)
//   D. Yahoo 恢复后自动回到富数据(Yahoo meta+charts), 备源不污染主路径
//   E. 字段解析: 3=价 4=昨收 5=开 6=量 31/32=涨跌/% 33/34=高低 35=币种 48/49=52周; GBK 名还原
process.env.PORT = '0';
process.env.CACHE_MS = '300';
process.env.QUOTE_MAX_AGE = '300';
process.env.Y_MIN_GAP = '10';
process.env.Y429_BASE = '2000';
process.env.Y429_CAP = '8000';
import http from 'node:http';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实负载骨架(2026-09-03 实测裁剪): 数字字段位置与线上一致
const TX_QQQ = 'v_usQQQ="200~纳指100ETF-Invesco~QQQ.OQ~711.95~709.24~710.85~9217218~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~2.71~0.38~713.85~709.69~USD~9217218~6559912038~~~~~~0.59~~~Invesco Qqq Trust Unit Ser 1~~747.83~554.99~0~~~~16.17~-1.27~GP-ETF~~~0.14~-0.38~0.69~~~1.44~~~711.70~~~"';
const TX_NVDA = 'v_usNVDA="200~英伟达~NVDA.OQ~226.10~224.41~226.02~42676179~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~1.69~0.75~229.07~224.75~USD~42676179~9692287792~0.18~28.58~~46.14~~1.93~52430.73590~54595.15965~Nvidia Corporation~7.91~236.26~163.82~0~23.84~0.23~54595.15965~21.39~-0.83~GP"';
const TX_SPY = 'v_usSPY="200~标普500指数ETF-SPDR~SPY.AM~770.50~765.16~767.90~12475933~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~5.34~0.70~770.63~764.53~USD~12475933~41500000000~~~~~~0.57~~~SPDR S&P 500 ETF Trust~~775.23~562.34~0~~~~13.60~-0.53~GP-ETF~~~1.28~0.20~2.82~~~1.58~~~770.50~~"';
const TX_SH = 'v_sh000001="1~上证指数~000001~3860.71~3882.01~3863.37~85757118~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260903105020~-21.30~-0.55~3869.72~3859.87~0.25~603868.26~682969.86~0.00~-1~-1~3.40~0~3865.23~~~~~~15468862.6486~0.0000~0~ ~ZS~-2.72~-3.25~~~~4258.86~3732.84~-1.87~1.24~-4.86~4847563574053~~2.04~-0.38~4847563574053~~~-0.59~-0.16~~CNY~0~~0.00~0~"';

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  const calls = { chart: 0, us: 0 };
  let mode = { yahoo: 429, tx: 'ok' };   // 默认: Yahoo 硬封( reproduce 线上真实状态)
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return mode.yahoo === 429 ? { status: 429, headers: {}, body: 'Edge: Too Many Requests' } : { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v8/finance/chart/')) {
      calls.chart++;
      if (mode.yahoo === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      const intraday = u.includes('interval=5m');
      const bars = intraday ? [480, 481] : [478, 479];
      return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { symbol: u.split('/chart/')[1].split('?')[0], exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD', gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000), instrumentType: 'ETF', previousClose: 475 },
        timestamp: bars.map((c, i) => 1756000000 + i * 300), indicators: { quote: [{ open: bars.map(c => c - 0.5), high: bars.map(c => c + 1), low: bars.map(c => c - 1), close: bars, volume: bars.map(() => 1000) }] } }] } }) };
    }
    if (u.includes('qt.gtimg.cn/q=')) {
      calls.us++;
      const code = u.split('/q=')[1].toUpperCase();
      const map = { 'USQQQ': TX_QQQ, 'USNVDA': TX_NVDA, 'USSPY': TX_SPY, 'SH000001': TX_SH };
      const body = mode.tx === 'ok' ? (map[code] || '') : '';
      return { status: 200, headers: {}, body };
    }
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: null }) };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };
  const st = () => S.__test.yahoo429.state();

  // ===== E. usSnapshot 字段解析(单元) =====
  console.log('[E] 字段解析');
  const snap = await S.__deps.usSnapshot('QQQ');
  check('usSnapshot 导出并解析 price', !!snap && snap.price === 711.95, JSON.stringify(snap && snap.price));
  check('昨收/开/高低/量', !!snap && snap.prevClose === 709.24 && snap.open === 710.85 && snap.dayHigh === 713.85 && snap.dayLow === 709.69 && snap.volume === 9217218, JSON.stringify(snap));
  check('涨跌/涨跌%/币种/52周', !!snap && snap.change === 2.71 && snap.changePct === 0.38 && snap.currency === 'USD' && snap.week52High === 747.83 && snap.week52Low === 554.99, JSON.stringify({ c: snap && snap.change, w: snap && snap.week52High }));
  check('GBK 名称还原(真实字节往返: GBK字节→latin1误读→TextDecoder还原)', await (async () => {
    S.__test.resetState();
    const prevMode = mode.tx;
    const moji = '\u00C4\u00C9\u00D6\u00B8100ETF-Invesco';   // "纳指"的GBK字节(C4 CE? 实测C4C9 D6B8)按latin1读成的坏串(python3 生成)
    mode.tx = 'gbk';
    const gbkBody = TX_QQQ.replace('纳指100ETF-Invesco', moji);
    const realSet = S.__upstream.impl;
    S.__upstream.impl = (u) => String(u).includes('qt.gtimg.cn/q=') ? { status: 200, headers: {}, body: gbkBody } : realSet(u);
    try { const s2 = await S.__deps.usSnapshot('QQQ'); return !!s2 && s2.name === '纳指100ETF-Invesco'; }
    finally { S.__upstream.impl = realSet; mode.tx = prevMode; }
  })(), 'name 未还原');

  // ===== A. 熔断期降级到腾讯 =====
  console.log('[A] 熔断期降级');
  S.__test.resetState();
  const q = await S.__deps.getCachedQuote('QQQ');
  check('Yahoo 全 429 下报价来自腾讯备源', q.price === 711.95, JSON.stringify(q.price));
  check('备源报价不标 stale(卡片不再挂延迟徽标)', !q.stale, String(q.stale));
  check('涨跌字段正确(2.71/0.38)', q.change === 2.71 && q.changePct === 0.38, JSON.stringify({ c: q.change, p: q.changePct }));
  check('市场分类为美股', q.market === '美股', String(q.market));

  // ===== B. 腾讯快照缓存 =====
  console.log('[B] 备源缓存');
  const usBefore = calls.us;
  await S.__deps.getCachedQuote('QQQ');
  await S.__deps.getCachedQuote('QQQ');
  check('30s 内轮询不重复打腾讯', calls.us === usBefore, 'us=' + calls.us + '/' + usBefore);

  // ===== C. 代码映射与 A股隔离 =====
  console.log('[C] 代码映射');
  const indexUsBefore=calls.us;
  let indexFailure;
  try { await S.__deps.getCachedQuote('^IXIC'); } catch(error) { indexFailure=error; }
  check('未验证^IXIC在Yahoo不可用时失败关闭',!!indexFailure,'unexpected index quote');
  check('未验证^IXIC不消耗腾讯请求',calls.us===indexUsBefore,'unexpected Tencent request');
  const usCnt = calls.us;
  let threw = null;
  try { await S.__deps.getCachedQuote('000001.SS'); } catch (e) { threw = e; }
  const qcn = await S.__deps.getCachedQuote('000001.SS');
  check('A股降级到腾讯 cnSnapshot(上证指数有价非 stale)', qcn.price === 3860.71 && !qcn.stale && qcn.market === 'A股指数', JSON.stringify({ p: qcn.price, s: qcn.stale, m: qcn.market }));
  const qs = await S.__deps.getCachedQuote('SPY');
  check('NYSE Arca 后缀 .AM 也分类为美股(SPY.AM)', qs.market === '美股' && qs.price === 770.50, JSON.stringify({ m: qs.market, p: qs.price }));

  // ===== D. Yahoo 恢复 → 自动回富数据 =====
  console.log('[D] Yahoo 恢复');
  S.__test.resetState();
  S.__test.yahoo429.expire();
  mode.yahoo = 'ok';
  const rich = await S.__deps.getCachedQuote('QQQ');
  check('恢复后回到 Yahoo 富数据(含 charts)', !rich.stale && rich.charts && Array.isArray(rich.charts.intraday) && rich.charts.intraday.length > 0, 'intraday=' + (rich.charts && rich.charts.intraday || []).length);
  check('恢复后 market 字段仍为美股', rich.market === '美股', String(rich.market));
}

main().then(() => { console.log('\n[US FALLBACK] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
