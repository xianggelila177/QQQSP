// tests/_test_market_field.mjs — P1-Q1 fetchQuote 返回体 market 字段回归测试
// 问题: fetchQuote 返回体无 market 字段(前端市场标签只能靠搜索接口兜底)
// 期望: 返回体带 market: classifyMarket(meta.symbol||symbol, exchangeName, fullExchangeName, instrumentType)
process.env.PORT = '0';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };

async function main() {
  const S = await import('../server.js');
  S.__upstream.impl = async () => ({ status: 200, headers: {}, body: '' });

  // 打桩: Yahoo chart 返回 QQQ meta(NASDAQ/NasdaqGS → 应判为美股)
  const meta = { symbol: 'QQQ', exchangeName: 'NGM', fullExchangeName: 'NasdaqGS', currency: 'USD',
    gmtoffset: -14400, regularMarketPrice: 480.5, regularMarketTime: Math.floor(Date.now() / 1000),
    instrumentType: 'ETF', previousClose: 475 };
  S.__deps.fetchChart     = async () => ({ meta, timestamp: [] });
  S.__deps.getDayOhlc     = async () => ({ open: null, high: null, low: null, prevClose: 475 });
  S.__deps.getFxRates     = async () => ({ USD: 7.1 });
  S.__deps.getNasdaqDaily = async () => [];
  S.__deps.getYahooDaily  = async () => [];

  console.log('[T1] QQQ 行情返回体携带 market 字段');
  const q = await S.__deps.fetchQuote('QQQ');
  check('market 字段存在且非空字符串', typeof q.market === 'string' && q.market.length > 0, 'market=' + JSON.stringify(q.market));
  check("QQQ → market='美股'", q.market === '美股', 'market=' + JSON.stringify(q.market));
  check('其余字段不回归(symbol/price/charts)', q.symbol === 'QQQ' && q.price != null && !!q.charts, JSON.stringify({ s: q.symbol, p: q.price }));
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
