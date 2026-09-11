// tests/_test_ua_ygap.mjs — T1 UA统一 + T2 串行收敛契约测试(RED→GREEN)
// T1 [防风控-P0]: server.js 的 UA 是短串(Chrome/120), 实测 Yahoo 边缘对短串直接 429(完整串正常)
//   → 必须与 relay.py 一致的完整 Chrome 串, 且全文仅此一处 UA 定义(所有上游共用)。
// T2 [延迟-P1]: yGate 串行网关默认间隔 300ms → 150ms(中继侧固有间隔已由 0.45s 降到 0.15s, 两端对齐)。
//   用桩计时断言: 相邻上游调用间隔 ≥150ms 且 <400ms(收敛后应 <250ms)。
process.env.PORT = '0';
// 注意: 此文件绝不能设置 Y_MIN_GAP —— T2 断言的是"默认值"行为
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA_FULL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);

  // ===== T1. UA 统一 =====
  console.log('[T1] UA 统一');
  S.__test.resetState();
  S.__upstream.impl = (url, headers) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 200, headers: {}, body: 'ok-crumb' };
    if (u.includes('/v8/finance/chart/')) return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { symbol: 'NVDA', regularMarketPrice: 1, gmtoffset: -14400 }, timestamp: [], indicators: { quote: [{}] } }] } }) };
    if (u.includes('api.nasdaq.com')) return { status: 200, headers: {}, body: JSON.stringify({ data: { tradesTable: { rows: [] } } }) };
    if (u.includes('qt.gtimg.cn')) return { status: 200, headers: {}, body: 'v_pv_none_match="1";' };
    if (u.includes('finance.sina.com.cn')) return { status: 200, headers: {}, body: '[]' };
    return { status: 404, headers: {}, body: '' };
  };
  await S.__deps.getNasdaqDaily('NVDA');     // nasdaq 路径(带自定义 Accept/Referer 头, UA 仍须统一注入)
  await S.__deps.getYahooDaily('NVDA');      // yahoo chart 路径
  check('__test.UA 导出 = 完整 Chrome 串(防 Yahoo 短串 429; UA 注入在 rawHttpsGet, 桩接缝之前)', S.__test.UA === UA_FULL, JSON.stringify(S.__test.UA));
  let observedUA;
  const local=http.createServer((req,res)=>{observedUA=req.headers['user-agent'];res.end('ok');});
  await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
  try {await S.__test.rawHttpsGet('http://127.0.0.1:'+local.address().port+'/');check('实际传输统一注入完整UA',observedUA===UA_FULL,observedUA);}
  finally {await new Promise(resolve=>local.close(resolve));}

  // ===== T2. yGate 串行收敛(默认 150ms) =====
  console.log('[T2] yGate 串行收敛');
  S.__test.resetState();
  S.__test.seedCrumb('seeded');
  const chartTimes = [];
  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('/v8/finance/chart/')) {
      return (async () => { await sleep(8); chartTimes.push(Date.now()); return { status: 200, headers: {}, body: JSON.stringify({ chart: { result: [{ meta: { symbol: 'QQQ', regularMarketPrice: 1, gmtoffset: -14400 }, timestamp: [1756000000], indicators: { quote: [{ close: [1] }] } }] } }) }; })();
    }
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    return { status: 404, headers: {}, body: '' };
  };
  await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d');   // 第1次: yLastAt=0 → 不等待
  await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d');   // 第2次: 等待 Y_MIN_GAP
  await S.__deps.fetchChart('QQQ', '?interval=5m&range=1d');   // 第3次: 再取一组间隔(取最小值抗抖动)
  const gaps = [];
  for (let i = 1; i < chartTimes.length; i++) gaps.push(chartTimes[i] - chartTimes[i - 1]);
  const minGap = Math.min(...gaps);
  console.log('    [计时] gaps=' + gaps.join(',') + 'ms');
  check('yGate 相邻两次上游调用间隔 ≥150ms(去突发)', gaps.length >= 2 && minGap >= 150, 'minGap=' + minGap + 'ms');
  check('yGate 相邻间隔 <250ms(收敛到新默认150; 旧默认300在此变红; 契约上界<400ms)', gaps.length >= 2 && minGap < 250, 'minGap=' + minGap + 'ms');
  check('yGate 相邻间隔 <400ms(契约上界)', gaps.length >= 2 && minGap < 400, 'minGap=' + minGap + 'ms');
}

main().then(() => { console.log('\n[UA+YGAP] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
