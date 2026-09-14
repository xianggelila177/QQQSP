// tests/_test_tx_parse_unified.mjs — T6 腾讯字段解析统一 + T7 GBK解码合并契约测试(RED→GREEN)
// T6: TX_FIELDS 常量表 + txParseLine(line, kind, sep) 统一解析器 —— usSnapshot/txQuoteSnapshot/
//     txDailyBarsCn/txMinuteBarsCn 四处共用; A股[30]='YYYYMMDDHHMMSS' 紧凑/美股[30]='YYYY-MM-DD HH:MM:SS' 分别处理。
// T7: txDecodeName 与 usSnapshot 内联 GBK 块合并为 decodeGbkSmart(s)(\uXXXX 转义 + latin1→GBK 双形态)。
process.env.PORT = '0';
process.env.CACHE_MS = '300';
process.env.QUOTE_MAX_AGE = '300';
process.env.Y_MIN_GAP = '10';
process.env.Y429_BASE = '2000';
process.env.Y429_CAP = '8000';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实负载骨架(与 _test_us_fallback 一致): 数字字段位置与线上一致
const TX_QQQ_INNER = '200~纳指100ETF-Invesco~QQQ.OQ~711.95~709.24~710.85~9217218~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~2.71~0.38~713.85~709.69~USD~9217218~6559912038~~~~~~0.59~~~Invesco Qqq Trust Unit Ser 1~~747.83~554.99~0~~~~16.17~-1.27~GP-ETF~~~0.14~-0.38~0.69~~~1.44~~~711.70~~~';
const TX_SH_INNER = '1~上证指数~000001~3860.71~3882.01~3863.37~85757118~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260903105020~-21.30~-0.55~3869.72~3859.87~0.25~603868.26~682969.86~0.00~-1~-1~3.40~0~3865.23~~~~~~15468862.6486~0.0000~0~ ~ZS~-2.72~-3.25~~~~4258.86~3732.84~-1.87~1.24~-4.86~4847563574053~~2.04~-0.38~4847563574053~~~-0.59~-0.16~~CNY~0~~0.00~0~';
const CN_TS = Date.UTC(2026, 8, 3, 10, 50, 20) - 8 * 3600e3;   // A股[30] 紧凑墙钟(北京) → epoch ms

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);
  const T = S.__test;

  // ===== T6. TX_FIELDS + txParseLine 统一解析器 =====
  console.log('[T6] TX_FIELDS + txParseLine');
  check('TX_FIELDS 常量表导出(quote.price=3/prevClose=4/open=5/time=30/high=33/low=34)',
    T.TX_FIELDS && T.TX_FIELDS.quote && T.TX_FIELDS.quote.price === 3 && T.TX_FIELDS.quote.prevClose === 4 && T.TX_FIELDS.quote.open === 5 && T.TX_FIELDS.quote.time === 30 && T.TX_FIELDS.quote.high === 33 && T.TX_FIELDS.quote.low === 34,
    JSON.stringify(T.TX_FIELDS && T.TX_FIELDS.quote));
  check('TX_FIELDS 含 day/minute 行表', !!(T.TX_FIELDS && T.TX_FIELDS.day && T.TX_FIELDS.minute), JSON.stringify(T.TX_FIELDS && { d: T.TX_FIELDS.day, m: T.TX_FIELDS.minute }));
  check('txParseLine 导出', typeof T.txParseLine === 'function', String(typeof T.txParseLine));
  if (typeof T.txParseLine === 'function') {
    const pu = T.txParseLine(TX_QQQ_INNER, 'quote');
    check('美股快照解析: 价/昨收/开/高低/量', pu.price === 711.95 && pu.prevClose === 709.24 && pu.open === 710.85 && pu.high === 713.85 && pu.low === 709.69 && pu.volume === 9217218, JSON.stringify({ p: pu.price }));
    check('美股快照解析: 涨跌/%/币种/52周/名称/代码', pu.change === 2.71 && pu.changePct === 0.38 && pu.currency === 'USD' && pu.week52High === 747.83 && pu.week52Low === 554.99 && pu.name === '纳指100ETF-Invesco' && pu.code === 'QQQ.OQ', JSON.stringify({ n: pu.name, c: pu.code }));
    check('美股[30] 原样保留(YYYY-MM-DD HH:MM:SS, 调用方处理)', pu.time === '2026-09-03 10:50:20', String(pu.time));
    const pc = T.txParseLine(TX_SH_INNER, 'quote');
    check('A股快照解析: 价/昨收/开/高低', pc.price === 3860.71 && pc.prevClose === 3882.01 && pc.open === 3863.37 && pc.high === 3869.72 && pc.low === 3859.87, JSON.stringify({ p: pc.price }));
    check('A股[30] 原样保留(YYYYMMDDHHMMSS 紧凑)', pc.time === '20260903105020', String(pc.time));
    const pd = T.txParseLine('2026-09-03~710~717~718~709~1000', 'day');
    check('日K行解析: 日期/开/收/高/低/量', pd.date === '2026-09-03' && pd.open === 710 && pd.close === 717 && pd.high === 718 && pd.low === 709 && pd.volume === 1000, JSON.stringify(pd));
    const pm = T.txParseLine('0930 3952.79 4513', 'minute', ' ');
    check('分时行解析(空格分隔): 时刻/价/量', pm.hhmm === '0930' && pm.price === 3952.79 && pm.volume === 4513, JSON.stringify(pm));
  }

  console.log('[T6-i] 统一解析器集成: A股快照 ts(紧凑墙钟)');
  S.__test.resetState();
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('qt.gtimg.cn/q=sh000001')) return { status: 200, headers: {}, body: 'v_sh000001="' + TX_SH_INNER + '";' };
    return { status: 404, headers: {}, body: '' };
  };
  const cn = await S.__deps.cnSnapshot('000001.SS');
  check('A股快照 ts 来自紧凑墙钟(北京→epoch)', !!cn && cn.ts === CN_TS, JSON.stringify({ ts: cn && cn.ts, want: CN_TS }));

  // ===== T7. decodeGbkSmart 合并 =====
  console.log('[T7] decodeGbkSmart');
  check('decodeGbkSmart 导出', typeof T.decodeGbkSmart === 'function', String(typeof T.decodeGbkSmart));
  if (typeof T.decodeGbkSmart === 'function') {
    check('\\uXXXX 转义形态还原(smartbox)', T.decodeGbkSmart('\\u7EB3\\u6307100ETF-Invesco') === '纳指100ETF-Invesco', String(T.decodeGbkSmart('\\u7EB3\\u6307100ETF-Invesco')));
    check('latin1 高位字符 → GBK 还原(qt.gtimg)', T.decodeGbkSmart('\u00C4\u00C9\u00D6\u00B8') === '纳指', String(T.decodeGbkSmart('\u00C4\u00C9\u00D6\u00B8')));
    check('纯 ASCII 原样透传', T.decodeGbkSmart('QQQ.OQ') === 'QQQ.OQ', String(T.decodeGbkSmart('QQQ.OQ')));
  }
  // T7 集成: usSnapshot 内联 GBK 块合并后, 真实字节往返(GBK字节→latin1误读→decodeGbkSmart 还原)不变
  S.__test.resetState();
  const TX_QQQ_FULL = 'v_usQQQ="' + TX_QQQ_INNER + '";';
  const moji = '\u00C4\u00C9\u00D6\u00B8100ETF-Invesco';   // "纳指" GBK 字节按 latin1 读成的坏串
  S.__upstream.impl = (u) => String(u).includes('qt.gtimg.cn/q=usQQQ')
    ? { status: 200, headers: {}, body: TX_QQQ_FULL.replace('纳指100ETF-Invesco', moji) }
    : { status: 404, headers: {}, body: '' };
  const usGbk = await S.__deps.usSnapshot('QQQ');
  check('usSnapshot GBK 名称还原(合并块行为不变)', !!usGbk && usGbk.name === '纳指100ETF-Invesco', JSON.stringify(usGbk && usGbk.name));
  check('usSnapshot 其余字段不受合并影响', !!usGbk && usGbk.price === 711.95 && usGbk.currency === 'USD', JSON.stringify(usGbk && { p: usGbk.price, c: usGbk.currency }));
}

main().then(() => { console.log('\n[TX PARSE UNIFIED] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
