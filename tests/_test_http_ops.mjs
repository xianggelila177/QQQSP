// HTTP/operations contract tests. These use only injected in-memory services.
process.env.PORT = '0';
process.env.SYMBOLS = 'QQQ,SPY';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-http-'));
process.env.LOG_FILE = path.join(testDir,'http.log');
process.on('exit',()=>fs.rmSync(testDir,{recursive:true,force:true}));

import http from 'node:http';
import { once } from 'node:events';

const pass = [];
const fail = [];
const check = (name, condition, detail = '') => {
  (condition ? pass : fail).push(name);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || !detail ? '' : ` | ${detail}`}`);
};

const H = await import('../lib/http.js');
const newsCache = new Map();
const quote = (symbol) => ({
  symbol,
  price: 100,
  quoteAt: Date.now(),
  marketState: "REGULAR",
  charts: { intraday: Array.from({ length: 80 }, (_, i) => ({ t: i + 1, o: 9, h: 11, l: 8, c: 10, v: i })), daily30: [] },
});
H.initHttp({
  getCachedQuote: async (symbol) => {
    if (symbol === 'FAIL') throw Object.assign(new Error('unavailable'), { code: 'UPSTREAM_UNAVAILABLE' });
    return quote(symbol);
  },
  getMacro: async () => ({ items: [] }),
  requestNews: async (symbol) => ({ items: [{ symbol }], updatedAt: 1, stale: false }),
  cacheSizes: () => ({ quote: 1, news: newsCache.size }),
  newsCache,
  cacheSet: (map, key, value) => map.set(key, value),
});
H.startListen();
while (!H.httpServer.address()) await new Promise((resolve) => setTimeout(resolve, 1));
const port = H.httpServer.address().port;

function request(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

check('chartRevision empty is zero', H.chartRevision([]) === 0);
const baseBar = [{ t: 10, o: 9, h: 11, l: 8, c: 10, v: 1 }];
check('chartRevision changes on same-timestamp OHLCV edit', H.chartRevision(baseBar) !== H.chartRevision([{ ...baseBar[0], c: 10.1 }]));
check('chartRevision is a safe decimal 48-bit value', Number.isSafeInteger(H.chartRevision(baseBar)) && H.chartRevision(baseBar) >= 0);
check('shared symbol rule accepts native markets and hyphenated shares', H.symbolValid('7203.T') && H.symbolValid('005930.KS') && H.symbolValid('BRK-B'));
check('shared symbol rule rejects malformed input', !H.symbolValid('QQQ!') && !H.symbolValid('123456'));

const empty = await request('GET', '/api/market?symbols=');
check('explicit empty symbols returns []', empty.status === 200 && JSON.parse(empty.body) instanceof Array && JSON.parse(empty.body).length === 0, empty.body.toString());
const one = await request('GET', '/api/market?symbols=QQQ');
check('single quote response is an array', one.status === 200 && Array.isArray(JSON.parse(one.body)));
const partial = await request('GET', '/api/market?symbols=QQQ,FAIL');
const partialBody = JSON.parse(partial.body);
check('partial quote failures preserve sibling results', partial.status === 200 && partialBody.length === 2 && partialBody[1].error && partialBody[1].code === 'UPSTREAM_UNAVAILABLE');
const direct = await request('GET', '/api/AAPL');
check('direct symbol route returns an array', direct.status === 200 && Array.isArray(JSON.parse(direct.body)));
const invalid = await request('GET', '/api/market?symbols=QQQ%20BAD');
check('invalid nonempty symbol input is HTTP 400', invalid.status === 400);
const tooMany = await request('GET', '/api/market?symbols=' + Array.from({ length: 13 }, (_, i) => `Q${i}`).join(','));
check('symbol cap is enforced with HTTP 400', tooMany.status === 400);
const post = await request('POST', '/api/market?symbols=QQQ');
check('invalid method is HTTP 405 with Allow', post.status === 405 && post.headers.allow === 'GET, HEAD, OPTIONS');
const options = await request('OPTIONS', '/api/market', { Origin: 'https://quotes.example.com' });
check('OPTIONS is explicit and CORS-safe', options.status === 204 && options.headers['access-control-allow-origin'] === 'https://quotes.example.com');
await request('GET','/api/market?symbols=SPY');
const live = await request('GET', '/healthz');
const ready = await request('GET', '/readyz');
check('healthz is liveness and remains HTTP 200', live.status === 200 && JSON.parse(live.body).ok === true);
check('readyz accepts recent usable responses including injected/fallback paths', ready.status === 200 && JSON.parse(ready.body).ready === true);
check('health diagnostics include bounded disk thresholds', JSON.parse(live.body).disk && typeof JSON.parse(live.body).disk.warning === 'boolean' && typeof JSON.parse(live.body).disk.critical === 'boolean');
const publicStats = await request('GET', '/api/stats', { Host: 'quotes.example.com' });
check('public proxy cannot read stats without an admin token', publicStats.status === 404);
const news = await request('GET', '/api/news?symbols=QQQ', { Origin: 'https://quotes.example.com' });
check('news keeps compatibility object shape', news.status === 200 && Array.isArray(JSON.parse(news.body).QQQ));
check('news freshness metadata is ASCII-safe', !news.headers['x-news-meta'] || /^[A-Za-z0-9_-]+$/.test(news.headers['x-news-meta']) && news.headers['x-news-meta-encoding'] === 'base64url-json');
const big = await request('GET', '/api/market?symbols=QQQ', { Origin: 'https://quotes.example.com', 'Accept-Encoding': 'gzip' });
check('gzip and CORS preserve both Vary values', big.headers['content-encoding'] === 'gzip' && String(big.headers.vary).toLowerCase().includes('origin') && String(big.headers.vary).toLowerCase().includes('accept-encoding'));

H.httpServer.close();
await once(H.httpServer, 'close').catch(() => {});
console.log(`[_test_http_ops] ${pass.length} pass / ${fail.length} fail`);
process.exit(fail.length ? 1 : 0);
