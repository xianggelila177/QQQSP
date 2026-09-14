// tests/_test_chart_cv.mjs — T3 图表条件传输协议契约测试(RED→GREEN)
// 契约: /api/* 新增可选参数 cv=SYM:iVer:dVer;SYM:iVer:dVer(分号分隔, 最多12个, 任一段畸形→整个参数忽略)。
//   服务端逐符号计算 iVer=分时末根bar的t秒(无则0) / dVer=日K末根bar的t秒(无则0);
//   客户端版本 === 服务端版本且 >0 → 该图表以字符串 "same" 占位(省带宽), 否则发全量数组。
//   响应每项新增字段: intradayVer(数值) / daily30Ver(数值) / intradayLast([t,c]|null);
//   daily30Version 保留(=dVer, 兼容旧前端)。iVer=0 → 永远发数组不发 "same"。
process.env.PORT = '0';
process.env.CACHE_MS = '300';
process.env.QUOTE_MAX_AGE = '300';
process.env.Y_MIN_GAP = '10';
import http from 'node:http';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const META = { symbol: 'QQQ', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
  gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000), instrumentType: 'ETF', previousClose: 475 };
const INTRA_BARS = genBars(20, 300, END);
const DAILY_6MO = genBars(130, DAY, END - 3 * DAY);
const DAILY_6D = genBars(5, DAY, END);
const LAST_C = INTRA_BARS[INTRA_BARS.length - 1].c;   // 480.2

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);
  const port = S.httpServer.address().port;

  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v7/finance/quote')) return { status: 200, headers: {}, body: JSON.stringify({ quoteResponse: { result: [{ symbol: 'CNY=X', regularMarketPrice: 7.12 }] } }) };
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows:
      DAILY_6D.slice(-5).reverse().map((b) => { const p = new Date(b.t * 1000).toISOString().slice(0, 10).split('-');   // nasdaq 桩日期格式 MM/DD/YYYY
        return { date: (+p[1]) + '/' + (+p[2]) + '/' + p[0], open: String(b.o), high: String(b.h), low: String(b.l), close: String(b.c), volume: String(b.v) }; }) } } }) };
    const sym = decodeURIComponent((u.match(/chart\/([^?]+)/) || [])[1] || 'QQQ');
    if (u.includes('includePrePost')) return { status: 200, headers: {}, body: envelope({ ...META, symbol: sym }, sym === 'SPY' ? [] : INTRA_BARS) };   // SPY: 分时无数据
    if (u.includes('range=6mo')) return { status: 200, headers: {}, body: envelope({ ...META, symbol: sym }, DAILY_6MO) };
    if (u.includes('range=6d')) return { status: 200, headers: {}, body: envelope({ ...META, symbol: sym }, DAILY_6D) };
    return { status: 404, headers: {}, body: '' };
  };

  const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); }).on('error', rej));

  console.log('[T3.0] 无 cv: 全量 + 版本字段(客户端据此构造 cv)');
  const j1 = JSON.parse(await get('/api/market?symbols=QQQ'))[0];
  const dVerExp = Math.max(...j1.charts.daily30.map(b => b.t));   // nasdaq 源日期按日截断 → 从响应推导日K版本
  check('intradayVer = OHLCV 内容修订号', Number.isSafeInteger(j1.intradayVer) && j1.intradayVer > 0 && j1.intradayVer !== END, 'v=' + JSON.stringify(j1.intradayVer));
  check('daily30Ver = OHLCV 内容修订号', Number.isSafeInteger(j1.daily30Ver) && j1.daily30Ver > 0 && j1.daily30Ver !== dVerExp, 'v=' + JSON.stringify(j1.daily30Ver));
  check('intradayLast = [末根t, 末根c]', Array.isArray(j1.intradayLast) && j1.intradayLast[0] === END && j1.intradayLast[1] === LAST_C, JSON.stringify(j1.intradayLast));
  check('daily30Version 保留且 = daily30Ver', j1.daily30Version === j1.daily30Ver, 'v=' + JSON.stringify(j1.daily30Version));
  check('无 cv 时图表为全量数组', Array.isArray(j1.charts.intraday) && j1.charts.intraday.length === 20 && Array.isArray(j1.charts.daily30) && j1.charts.daily30.length === 5, 'i=' + (j1.charts.intraday || []).length + ' d=' + (j1.charts.daily30 || []).length);

  console.log('[T3.1] cv 版本命中 → "same" 占位');
  const j2 = JSON.parse(await get('/api/market?symbols=QQQ&cv=' + encodeURIComponent(`QQQ:${j1.intradayVer}:${j1.daily30Ver}`)))[0];
  check('分时命中 → charts.intraday === "same"', j2.charts.intraday === 'same', JSON.stringify(j2.charts.intraday).slice(0, 60));
  check('日K命中 → charts.daily30 === "same"', j2.charts.daily30 === 'same', JSON.stringify(j2.charts.daily30).slice(0, 60));
  check('版本字段照常返回(numeric)', j2.intradayVer === j1.intradayVer && j2.daily30Ver === j1.daily30Ver && j2.daily30Version === j1.daily30Ver, JSON.stringify({ i: j2.intradayVer, d: j2.daily30Ver }));
  check('intradayLast 保留(供客户端原位补丁最新价)', Array.isArray(j2.intradayLast) && j2.intradayLast[0] === END && j2.intradayLast[1] === LAST_C, JSON.stringify(j2.intradayLast));
  check('其余字段不受影响(price)', j2.price != null, String(j2.price));

  console.log('[T3.2] cv 版本不命中 → 全量');
  const j3 = JSON.parse(await get('/api/market?symbols=QQQ&cv=' + encodeURIComponent('QQQ:123:456')))[0];
  check('分时不命中 → 全量数组', Array.isArray(j3.charts.intraday) && j3.charts.intraday.length === 20, String(j3.charts.intraday).slice(0, 40));
  check('日K不命中 → 全量数组', Array.isArray(j3.charts.daily30) && j3.charts.daily30.length === 5, String(j3.charts.daily30).slice(0, 40));

  console.log('[T3.3] cv 畸形 → 整体忽略(全量, 行为同旧版)');
  for (const bad of ['garbage', 'QQQ:x:y', 'QQQ:1', ';;', Array.from({ length: 13 }, (_, i) => 'S' + i + ':1:1').join(';')]) {
    const j = JSON.parse(await get('/api/market?symbols=QQQ&cv=' + encodeURIComponent(bad)))[0];
    check('畸形 cv(' + bad.slice(0, 24) + (bad.length > 24 ? '…' : '') + ') → 全量', Array.isArray(j.charts.intraday) && Array.isArray(j.charts.daily30), 'i=' + String(j.charts.intraday).slice(0, 20));
  }

  console.log('[T3.4] iVer=0 → 永远发数组不发 "same"');
  const j4 = JSON.parse(await get('/api/market?symbols=SPY&cv=' + encodeURIComponent(`SPY:999:${j1.daily30Ver}`)))[0];
  check('服务端分时为空 → intraday 空数组(非 "same")', Array.isArray(j4.charts.intraday) && j4.charts.intraday.length === 0, JSON.stringify(j4.charts.intraday).slice(0, 40));
  check('iVer=0 → intradayVer=0 且 intradayLast=null', j4.intradayVer === 0 && j4.intradayLast === null, JSON.stringify({ v: j4.intradayVer, l: j4.intradayLast }));
  check('日K版本命中仍可 "same"(与分时互不影响)', j4.charts.daily30 === 'same' && j4.daily30Ver === j1.daily30Ver, JSON.stringify(String(j4.charts.daily30).slice(0, 30)) + '/' + j4.daily30Ver);

  console.log('[T3.5] 多符号混合: 命中与全量共存');
  const j5 = JSON.parse(await get('/api/market?symbols=QQQ,SPY&cv=' + encodeURIComponent(`QQQ:${j1.intradayVer}:${j1.daily30Ver};SPY:0:0`)));
  check('返回数组且逐项带版本字段', Array.isArray(j5) && j5.length === 2 && j5.every(x => typeof x.intradayVer === 'number' && typeof x.daily30Ver === 'number' && 'intradayLast' in x), 'n=' + (Array.isArray(j5) ? j5.length : 'na'));
  check('QQQ 分时/日K 均 "same"', j5[0].charts.intraday === 'same' && j5[0].charts.daily30 === 'same', JSON.stringify(String(j5[0].charts.intraday).slice(0, 20)));
  check('SPY 全量(0版本不命中)且 daily30Ver 仍为数值', Array.isArray(j5[1].charts.intraday) && Array.isArray(j5[1].charts.daily30) && typeof j5[1].daily30Ver === 'number', JSON.stringify({ i: String(j5[1].charts.intraday).slice(0, 20), d: j5[1].daily30Ver }));
}

main().then(() => { console.log('\n[CHART CV] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
