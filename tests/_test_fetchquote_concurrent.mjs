// tests/_test_fetchquote_concurrent.mjs — P1-P2 fetchQuote 并行化回归测试
// 问题: fetchQuote 在 Promise.allSettled 之后才串行 await getYahooDaily → 多等一整段上游延迟
// 期望: getYahooDaily 并入 allSettled; 总耗时 ≈ 分时(先行) + max(四路并行源), 而非逐段相加
process.env.PORT = '0';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const S = await import('../server.js');
  S.__upstream.impl = async () => ({ status: 200, headers: {}, body: '' });   // 防御兜底

  const meta = { symbol: 'QQQ', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
    gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000),
    instrumentType: 'ETF', previousClose: 475 };
  const hits = {};
  const mk = (name, ms, val) => async () => { hits[name] = (hits[name] || 0) + 1; await sleep(ms); return val; };

  // 各协作方打桩延迟: 分时50ms(fetchQuote必先行的底数据) + 四路可并行源各400ms
  S.__deps.fetchChart     = mk('fetchChart', 50, { meta, timestamp: [] });
  S.__deps.getDayOhlc     = mk('getDayOhlc', 400, { open: 477, high: 481, low: 476, prevClose: 475 });
  S.__deps.getFxRates     = mk('getFxRates', 400, { USD: 7.1 });
  S.__deps.getNasdaqDaily = mk('getNasdaqDaily', 400, [{ t: 1756000000, o: 477, h: 481, l: 476, c: 480 }]);
  S.__deps.getYahooDaily  = mk('getYahooDaily', 400, [{ t: 1756000001, o: 477, h: 481, l: 476, c: 480.5 }]);

  const t0 = Date.now();
  const q = await S.__deps.fetchQuote('QQQ');
  const ms = Date.now() - t0;

  check('四路慢源各恰好调用1次', hits.getYahooDaily === 1 && hits.getNasdaqDaily === 1 && hits.getDayOhlc === 1 && hits.getFxRates === 1, JSON.stringify(hits));
  check('返回有效报价(QQQ/price)', !!(q && q.symbol === 'QQQ' && q.price != null), JSON.stringify(q && { s: q.symbol, p: q.price, d30: q.charts && q.charts.daily30 && q.charts.daily30.length }));
  // 并行下限 ≈ 50+400 = 450ms; 串行旧路径 ≈ 50 + 400(allSettled) + 400(getYahooDaily串行) = 850ms
  check('总耗时 < 700ms(getYahooDaily 已并行)', ms < 700, ms + 'ms');
  console.log('    [耗时] ' + ms + 'ms | 阈值700ms | 串行旧路径预期~850ms, 并行预期~450ms');
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
