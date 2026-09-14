// tests/_test_cors_allowlist.mjs — T9 CORS Origin 白名单契约测试(RED→GREEN)
// 契约: 所有 /api/* 的 Access-Control-Allow-Origin: '*' 收紧为白名单回显:
//   请求带 Origin 且 === https://qqqsp.digital-reality.shop → 回显该 Origin;
//   其他 Origin(恶意站)/无 Origin(同源/curl) → 一律不带 CORS 头。
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

const WL = 'https://qqqsp.digital-reality.shop';
const TX_QQQ = 'v_usQQQ="200~纳指100ETF-Invesco~QQQ.OQ~711.95~709.24~710.85~9217218~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-09-03 10:50:20~2.71~0.38~713.85~709.69~USD~9217218~6559912038~~~~~~0.59~~~Invesco Qqq Trust Unit Ser 1~~747.83~554.99~0~~~~16.17~-1.27~GP-ETF~~~0.14~-0.38~0.69~~~1.44~~~711.70~~~"';
const TX_HINT = 'v_hint="us~NVDA~英伟达~Nvidia~gp"';

async function main() {
  const S = await import('../server.js');
  for (let i = 0; i < 100 && !(S.httpServer && S.httpServer.address()); i++) await sleep(20);
  const port = S.httpServer.address().port;

  S.__upstream.impl = (url) => {
    const u = String(url);
    if (u.includes('fc.yahoo.com')) return { status: 404, headers: { 'set-cookie': ['y=v=1'] }, body: '' };
    if (u.includes('getcrumb')) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
    if (u.includes('/v8/finance/chart/')) return { status: 429, headers: {}, body: 'Edge: Too Many Requests' };
    if (u.includes('qt.gtimg.cn/q=')) return { status: 200, headers: {}, body: u.includes('usQQQ') ? TX_QQQ : 'v_pv_none_match="1";' };
    if (u.includes('smartbox.gtimg.cn')) return { status: 200, headers: {}, body: TX_HINT };
    return { status: 200, headers: {}, body: '' };   // news/macro 源: 空体 → 各自解析失败回空
  };

  const reqOnce = (p, origin) => new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: origin ? { Origin: origin } : {} },
      (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, h: r.headers, b })); });
    req.on('error', rej);
  });
  const acao = (r) => r.h['access-control-allow-origin'];

  console.log('[T9] /api/macro');
  const r1 = await reqOnce('/api/macro', WL);
  check('白名单 Origin → 回显 ACAO(不再 *)', r1.status === 200 && acao(r1) === WL, JSON.stringify(acao(r1)));
  const r2 = await reqOnce('/api/macro', 'https://evil.example.com');
  check('恶意 Origin → 无 CORS 头', r2.status === 200 && acao(r2) === undefined, JSON.stringify(acao(r2)));
  const r3 = await reqOnce('/api/macro', null);
  check('无 Origin(同源/curl) → 无 CORS 头', r3.status === 200 && acao(r3) === undefined, JSON.stringify(acao(r3)));

  console.log('[T9] 其余 /api/* 端点');
  const r4 = await reqOnce('/api/news?symbols=QQQ', WL);
  check('/api/news 白名单回显', acao(r4) === WL, JSON.stringify(acao(r4)));
  const r5 = await reqOnce('/api/news?symbols=QQQ', 'https://evil.example.com');
  check('/api/news 恶意 Origin 无 CORS 头', acao(r5) === undefined, JSON.stringify(acao(r5)));
  const r6 = await reqOnce('/api/search?q=nvda', 'https://evil.example.com');
  check('/api/search 恶意 Origin 无 CORS 头', acao(r6) === undefined, JSON.stringify(acao(r6)));
  const r7 = await reqOnce('/api/search?q=nvda', WL);
  check('/api/search 白名单回显', acao(r7) === WL, JSON.stringify(acao(r7)));
  const r8 = await reqOnce('/api/market?symbols=QQQ', WL);
  check('/api/market 白名单回显(响应体正常)', r8.status === 200 && acao(r8) === WL && Array.isArray(JSON.parse(r8.b)) && JSON.parse(r8.b)[0].price != null, JSON.stringify(acao(r8)));
  const r9 = await reqOnce('/api/market?symbols=QQQ', 'https://evil.example.com');
  check('/api/market 恶意 Origin 无 CORS 头', acao(r9) === undefined, JSON.stringify(acao(r9)));
  const r10 = await reqOnce('/api/market?symbols=QQQ', null);
  check('/api/market 无 Origin 无 CORS 头(数据仍可取, 同源不受影响)', r10.status === 200 && acao(r10) === undefined && Array.isArray(JSON.parse(r10.b)) && JSON.parse(r10.b)[0].price != null, JSON.stringify(acao(r10)));
}

main().then(() => { console.log('\n[CORS ALLOWLIST] ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
