// tests/_test_chart_sources.mjs — 图表备源契约测试(RED→GREEN)
// 问题: Yahoo 被封期间(v46+)卡片有价无图——fallbackQuote 的 charts 恒空;
// 且 getNasdaqDaily 硬编码 assetclass=etf, NVDA 等个股日K永远拿不到(实测 stocks 分类可用);
// 英文搜索只走 Yahoo, 断源即死(smartbox 腾讯联想已存在但只用于 CJK)。
// 契约:
//   A. txDailyBarsCn: A股日K←腾讯 ifzq fqkline(qfq 必需), 30根 {t,o,c,h,l,v} 升序 + SLOW_TTL 缓存
//   B. txMinuteBarsCn: A股分时←腾讯 ifzq minute/query, {t,c,v} 北京时间 epoch 秒升序
//   C. getNasdaqDaily: ^指数不打 nasdaq(不支持); NVDA→assetclass=stocks; QQQ stocks空→etf 重试
//   D. fallbackQuote(Yahoo 全 429): 美股 daily30←Nasdaq+version>0; A股 分时+日K 全有
//   E. /api/search 英文查询 Yahoo 挂 → 腾讯 smartbox 兜底返回结果
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

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  const calls = { nasdaq: [], smartbox: 0, ifzqday: 0, ifzqmin: 0 };
  let mode = { yahoo: 429, nasdaqStocks: 'rows', nasdaqEtf: 'rows' };   // 'rows' | 'empty'
  const TX_DAY = JSON.stringify({ code: 0, data: { sh000001: { day: Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 20 + i) / 1).toISOString().slice(0, 10);
    return [d, '3850', String(3860 + i), '3870', '3840', '1000'];
  }) } } });
  const TX_MIN = JSON.stringify({ code: 0, data: { sh000001: { data: { date: '20260903', data: ['0930 3952.79 4513', '0931 3956.42 17690', '0932 3958.10 15000'] }, qt: { sh000001: [] } } } });
  const TX_HINT = 'v_hint="us~NVDA~英伟达~Nvidia~gp;us~NVDS~NVDA 3X~Leveraged~gp"';
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
    if (u.includes('/v8/finance/chart/')) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
    if (u.includes('api.nasdaq.com')) {
      const ac = (u.match(/assetclass=(\w+)/) || [])[1] || '?';
      calls.nasdaq.push(ac);
      const kind = ac === 'stocks' ? mode.nasdaqStocks : ac === 'etf' ? mode.nasdaqEtf : 'empty';
      if (kind !== 'rows') return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows: [] } } }) };
      return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows: [
        { date: '09/02/2026', open: '$480', high: '$482', low: '$479', close: '$481', volume: '157,104,700' },
        { date: '09/03/2026', open: '$481', high: '$483', low: '$480', close: '$482', volume: '144,283,360' }] } } }) };
    }
    if (u.includes('fqkline/get')) {
      if (u.includes('sh000001')) { calls.ifzqday++; return { status: 200, headers: {}, body: TX_DAY }; }
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { usQQQ: { day: [['2026-09-03', '710', '717', '718', '709', '1000']] } } }) };
    }
    if (u.includes('minute/query')) {
      if (u.includes('sh000001')) { calls.ifzqmin++; return { status: 200, headers: {}, body: TX_MIN }; }
      return { status: 200, headers: {}, body: JSON.stringify({ code: 0, data: { usQQQ: { data: { data: ['1144 717.34 14428'], date: '' }, qt: { usQQQ: [] } } } }) };
    }
    if (u.includes('smartbox.gtimg.cn')) { calls.smartbox++; return { status: 200, headers: {}, body: TX_HINT }; }
    if (u.includes('qt.gtimg.cn/q=')) {
      if (u.includes('usQQQ')) return { status: 200, headers: {}, body: 'v_usQQQ="200~QQQ~QQQ.OQ~711.95~709.24~710.85~9217218~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~2.71~0.38~713.85~709.69~USD~9217218~6559912038~~~~~~0.59~~~Invesco~~747.83~554.99~0~~~~16.17~-1.27~GP-ETF~~~0.14~-0.38~0.69~~~1.44~~~711.70~~~"' };
      if (u.includes('sh000001')) return { status: 200, headers: {}, body: 'v_sh000001="1~上证指数~000001~3860.71~3882.01~3863.37~85757118~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~20260903105020~-21.30~-0.55~3869.72~3859.87~0.25~603868.26~682969.86~0.00~-1~-1~3.40~0~3865.23~~~~~~15468862.6486~0.0000~0~ ~ZS~-2.72~-3.25~~~~4258.86~3732.84~-1.87~1.24~-4.86~4847563574053~~2.04~-0.38~4847563574053~~~-0.59~-0.16~~CNY~0~~0.00~0~"' };
      return { status: 200, headers: {}, body: 'v_pv_none_match="1";' };
    }
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };

  // ===== A. A股日K =====
  console.log('[A] A股日K(腾讯)');
  S.__test.resetState();
  const d30 = await S.__deps.txDailyBarsCn('000001.SS');
  check('txDailyBarsCn 导出并返回30根', Array.isArray(d30) && d30.length === 30, 'n=' + (d30 || []).length);
  check('bar 形状 {t,o,c,h,l,v} 数值且升序', d30.length > 1 && d30.every(b => Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.c)) && d30[0].t < d30[1].t, JSON.stringify(d30[0]));
  const c0 = calls.ifzqday;
  await S.__deps.txDailyBarsCn('000001.SS');
  check('SLOW_TTL 内走缓存不再打上游', calls.ifzqday === c0, 'ifzqday=' + calls.ifzqday + '/' + c0);

  // ===== B. A股分时 =====
  console.log('[B] A股分时(腾讯)');
  const mins = await S.__deps.txMinuteBarsCn('000001.SS');
  check('txMinuteBarsCn 返回3根分钟bar', Array.isArray(mins) && mins.length === 3, 'n=' + (mins || []).length);
  check('分钟bar {t,c,v} 且 t 为当日北京时间 epoch 秒', mins.length === 3 && Number.isFinite(mins[0].t) && mins[0].c === 3952.79 && mins[0].t < mins[1].t, JSON.stringify(mins[0]));

  // ===== C. getNasdaqDaily assetclass =====
  console.log('[C] Nasdaq assetclass');
  S.__test.resetState();
  calls.nasdaq.length = 0;
  mode.nasdaqStocks = 'rows'; mode.nasdaqEtf = 'empty';
  const nv = await S.__deps.getNasdaqDaily('NVDA');
  check('个股用 assetclass=stocks 且一次命中', calls.nasdaq.join(',') === 'stocks' && nv.length === 2, calls.nasdaq.join(',') + ' n=' + nv.length);
  S.__test.resetState();
  calls.nasdaq.length = 0;
  mode.nasdaqStocks = 'empty'; mode.nasdaqEtf = 'rows';
  const qq = await S.__deps.getNasdaqDaily('QQQ');
  check('ETF: stocks 空 → 自动重试 etf', calls.nasdaq.join(',') === 'stocks,etf' && qq.length === 2, calls.nasdaq.join(',') + ' n=' + qq.length);
  S.__test.resetState();
  calls.nasdaq.length = 0;
  const ix = await S.__deps.getNasdaqDaily('^IXIC');
  check('指数不消耗 nasdaq 调用(该源不支持)', calls.nasdaq.length === 0 && ix.length === 0, calls.nasdaq.join(','));

  // ===== D. fallbackQuote 带图 =====
  console.log('[D] fallbackQuote 图表');
  S.__test.resetState();
  mode.nasdaqStocks = 'rows'; mode.nasdaqEtf = 'rows';
  const qus = await S.__deps.getCachedQuote('QQQ');
  check('美股降级报价带日K(Nasdaq 源)', qus.price === 711.95 && Array.isArray(qus.charts.daily30) && qus.charts.daily30.length === 2, 'daily30=' + (qus.charts.daily30 || []).length);
  check('daily30Version = 最新bar t', qus.daily30Version > 0 && qus.charts.daily30.length && qus.daily30Version === qus.charts.daily30[qus.charts.daily30.length - 1].t, String(qus.daily30Version));
  const qcn = await S.__deps.getCachedQuote('000001.SS');
  check('A股降级报价 分时+日K 全有', qcn.price === 3860.71 && qcn.charts.intraday.length === 3 && qcn.charts.daily30.length === 30, 'intra=' + qcn.charts.intraday.length + ' d30=' + qcn.charts.daily30.length);

  // ===== E. 英文搜索兜底 =====
  console.log('[E] 搜索兜底');
  const port = S.httpServer.address().port;
  const get = (path) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(b)); }).on('error', rej));
  const raw = await get('/api/search?q=nvda');
  let j = null; try { j = JSON.parse(raw); } catch {}
  const arr = Array.isArray(j) ? j : (j && j.items) || [];
  check('Yahoo 挂时英文搜索落到腾讯联想', arr.length > 0 && arr.some(x => x.symbol === 'NVDA'), JSON.stringify(arr).slice(0, 120));
}

main().then(() => { console.log('\n[CHART SOURCES] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
