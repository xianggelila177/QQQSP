// tests/_test_fallback_daily_full.mjs — T5 备源日K拉满 + T10 指数日K回归契约测试(RED→GREEN)
// T5: 备源日K从 30 根拉满到 126 根: 美股 dailyUs.slice(-126) / A股 txDailyBarsCn(symU,130)+slice(-126)。
//     桩给 40 根日K → 备源报价 daily30 必须有 40 根(不被截到 30)。
// T10: getNasdaqDaily 保持 limit=220; 未验证caret指数只能使用Yahoo，不能伪造腾讯备用价。
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

const META = { symbol: 'X', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
  gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000), instrumentType: 'ETF', previousClose: 475 };
const TX_QQQ = 'v_usQQQ="200~纳指100ETF-Invesco~QQQ.OQ~711.95~709.24~710.85~9217218~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~2.71~0.38~713.85~709.69~USD~9217218~6559912038~~~~~~0.59~~~Invesco Qqq Trust Unit Ser 1~~747.83~554.99~0~~~~16.17~-1.27~GP-ETF~~~0.14~-0.38~0.69~~~1.44~~~711.70~~~"';
const TX_SH = 'v_sh000001="1~上证指数~000001~3860.71~3882.01~3863.37~85757118~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260903105020~-21.30~-0.55~3869.72~3859.87~0.25~603868.26~682969.86~0.00~-1~-1~3.40~0~3865.23~~~~~~15468862.6486~0.0000~0~ ~ZS~-2.72~-3.25~~~~4258.86~3732.84~-1.87~1.24~-4.86~4847563574053~~2.04~-0.38~4847563574053~~~-0.59~-0.16~~CNY~0~~0.00~0~"';
// 40 根日K(桩数据: 检验不被截到 30)
const day40 = Array.from({ length: 40 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1) + i * 86400e3).toISOString().slice(0, 10);
  return [d, '3850', String(3860 + i), '3870', '3840', '1000'];
});
const TX_DAY40 = JSON.stringify({ code: 0, data: { sh000001: { day: day40 } } });
const mdY = (iso) => { const p = iso.split('-'); return (+p[1]) + '/' + (+p[2]) + '/' + p[0]; };   // nasdaq 桩日期格式 MM/DD/YYYY
const ndRows40 = day40.map((r) => ({ date: mdY(r[0]), open: '$480', high: '$482', low: '$479', close: String(480 + +r[2] - 3860), volume: '1000' })).reverse();
const LAST40_T = Math.floor(Date.parse(day40[39][0] + 'T00:00:00Z') / 1000);

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  const calls = { nasdaq: [], tencent: [] };
  let mode = { yahoo: 429, ndq: 40 };
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return mode.yahoo === 429 ? { status: 429, headers: {}, body: 'Edge: Too Many Requests' } : { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v8/finance/chart/')) {
      if (mode.yahoo === 429) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
      const symbol = decodeURIComponent(u.split('/chart/')[1].split('?')[0]);
      const intraday = u.includes('interval=5m');
      const bars = intraday ? [480, 481] : [478, 479];
      return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { ...META, symbol, instrumentType:symbol.startsWith('^')?'INDEX':'ETF' }, timestamp: bars.map((c, i) => 1756000000 + i * 300), indicators: { quote: [{ open: bars.map(c => c - 0.5), high: bars.map(c => c + 1), low: bars.map(c => c - 1), close: bars, volume: bars.map(() => 1000) }] } }] } }) };
    }
    if (u.includes('qt.gtimg.cn/q=')) {
      calls.tencent.push(u);
      if (u.includes('usQQQ')) return { status: 200, headers: {}, body: TX_QQQ };
      if (u.includes('sh000001')) return { status: 200, headers: {}, body: TX_SH };
      return { status: 200, headers: {}, body: 'v_pv_none_match="1";' };
    }
    if (u.includes('fqkline/get')) return { status: 200, headers: {}, body: TX_DAY40 };
    if (u.includes('api.nasdaq.com')) {
      calls.nasdaq.push(u);
      const rows = mode.ndq === 40 ? ndRows40 : [];
      return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows } } }) };
    }
    if (u.includes('minute/query')) return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { sh000001: { data: { date: '20260903', data: ['0930 3952.79 4513'] }, qt: { sh000001: [] } } } }) };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };

  // ===== T5. 备源日K拉满(40 根不被截到 30) =====
  console.log('[T5] 备源日K拉满');
  S.__test.resetState();
  const qus = await S.__deps.getCachedQuote('QQQ');     // 美股: Nasdaq 日K备源
  check('美股备源日K 40 根不截断(旧 slice(-30) 在此变红)', Array.isArray(qus.charts.daily30) && qus.charts.daily30.length === 40, 'n=' + (qus.charts.daily30 || []).length);
  check('美股 daily30Version = 第40根 t', qus.daily30Version === LAST40_T, 'v=' + qus.daily30Version + '/' + LAST40_T);
  const qcn = await S.__deps.getCachedQuote('000001.SS');   // A股: 腾讯日K备源
  check('A股备源日K 40 根不截断(旧 slice(-30) 在此变红)', Array.isArray(qcn.charts.daily30) && qcn.charts.daily30.length === 40, 'n=' + (qcn.charts.daily30 || []).length);
  check('A股 daily30Version = 第40根 t', qcn.daily30Version === LAST40_T, 'v=' + qcn.daily30Version + '/' + LAST40_T);

  // 未验证指数在Yahoo不可用时失败关闭，不伪造备用价或图表。
  console.log('[T10] 指数Yahoo-only契约');
  S.__test.resetState();
  const ndqBefore = calls.nasdaq.length, txBefore = calls.tencent.length;
  let indexFailure;
  try { await S.__deps.getCachedQuote('^IXIC'); } catch(error) { indexFailure=error; }
  check('^IXIC Yahoo不可用时明确失败', !!indexFailure, 'unexpected quote');
  check('^IXIC 不请求未经验证的腾讯代码', calls.tencent.length===txBefore, calls.tencent.slice(txBefore));
  check('^IXIC 不消耗Nasdaq股票历史调用', calls.nasdaq.length===ndqBefore, calls.nasdaq.slice(ndqBefore));

  S.__test.resetState();
  mode.yahoo = 'ok';
  const indexQuote=await S.__deps.getCachedQuote('^IXIC');
  check('^IXIC Yahoo恢复后保持指数身份及提供者图表',indexQuote.instrumentType==='INDEX' && indexQuote.charts.intraday.length>0 && indexQuote.charts.daily30.length>0,JSON.stringify(indexQuote.instrumentType));
  check('^IXIC 恢复仍不调用Tencent/Nasdaq',calls.tencent.length===txBefore && calls.nasdaq.length===ndqBefore,'unexpected index fallback request');
  await S.__deps.getCachedQuote('NVDA');                // 美股全量路径 → getNasdaqDaily
  check('getNasdaqDaily 请求保持 limit=220', calls.nasdaq.length > 0 && calls.nasdaq.some(u => /limit=220/.test(u)), calls.nasdaq[0] || 'no-call');
}

main().then(() => { console.log('\n[FALLBACK DAILY FULL] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
