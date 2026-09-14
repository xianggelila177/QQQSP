import { test as base, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChartVersions, parseCv } from '../../lib/http-charts.js';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicRoot = path.join(root, 'public');
export const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
export const symbols12 = ['QQQ', 'SPY', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOG', 'TSLA', '0700.HK', '600519.SS', '^N225'];
function bars(count, step, end) {
  return Array.from({ length: count }, (_, index) => {
    const c = 480 + Math.sin(index / 15) * 4 + index / 100;
    return { t: end - (count - index - 1) * step, o: c - 0.2, h: c + 1, l: c - 1, c, v: 10000 + index };
  });
}
export function quote(symbol, state) {
  const now = state.now ? state.now() : Date.now();
  const extra = state.extra || 0;
  const end = Math.floor(state.startedAt / 1000) + extra * 60;
  const intraday = bars((state.longCharts ? 1600 : 100) + extra, 60, end);
  const daily30 = bars((state.longCharts ? 1800 : 180) + extra, 86400, Math.floor(state.startedAt / 1000) + extra * 86400);
  if (state.tailDelta) { intraday.at(-1).c += state.tailDelta; intraday.at(-1).h = Math.max(intraday.at(-1).h, intraday.at(-1).c); }
  const index = symbol.startsWith('^');
  const market = symbol.endsWith('.HK') ? '港股' : symbol.endsWith('.SS') ? '沪A' : symbol === '^N225' ? '日股指数' : '美股';
  return {
    symbol, name: symbol + ' fixture', price: 490.25, change: 2.25, changePct: 0.46,
    currency: symbol.endsWith('.HK') ? 'HKD' : symbol.endsWith('.SS') ? 'CNY' : symbol === '^N225' ? 'JPY' : 'USD',
    market, instrumentType: ['QQQ', 'SPY'].includes(symbol) ? 'ETF' : index ? 'INDEX' : 'EQUITY',
    exchange: market === '美股' ? 'NASDAQ' : market, exchangeName: 'NASDAQ',
    marketState: 'CLOSED', priceSession: 'REGULAR', marketStateSource: 'fixture-calendar',
    session: 'REGULAR', priceTime: now, time: now, timestamp: now, fetchedAt: now,
    quoteAgeMs: 0, stale: false, staleGrade: 'fresh', quoteSource: 'fixture', source: 'fixture', src: 'fixture', quoteAt: now, sourceCheckedAt: now,
    open: 485, high: 493, low: 481, dayHigh: 493, dayLow: 481, prevClose: 488, previousClose: 488,
    volume: 1200000, w52h: 530, w52l: 320, week52High: 530, week52Low: 320,
    fxMap: { USD: 7.2, KRW: 1380, JPY: 150, HKD: 7.8 }, fxStale: false,
    charts: { intraday, daily30 }, intradayVer: 1 + extra, daily30Ver: 1 + extra,
    ...state.quotePatch,
    ...state.quotePatches?.[symbol],
  };
}
async function createServer() {
  const state = { startedAt: Date.now(), extra: 0, marketRequests: 0, requests: [], macroRequests: 0, marketError: false, macroError: false, macroStale: false, longCharts: false, newsDelay: 0 };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, data, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); response.end(JSON.stringify(data)); };
    if (url.pathname === '/api/market') {
      state.marketRequests++; state.requests.push(url.searchParams.get('cv'));
      const symbols = (url.searchParams.get('symbols') || 'QQQ,SPY').split(',');
      return send(200, applyChartVersions(symbols.map(symbol => state.marketError ? { symbol, error: 'fixture upstream unavailable', stale: true } : quote(symbol, state)), parseCv(url.searchParams.get('cv'))));
    }
    if(url.pathname==='/api/history'){
      const symbol=url.searchParams.get('symbol'),period=url.searchParams.get('period');
      const raw=quote(symbol,state).charts.daily30.map(b=>({...b,periodStart:new Date(b.t*1000).toISOString().slice(0,10)}));
      const normalized=raw.map(b=>({...b,t:Date.parse(b.periodStart+'T00:00:00Z')/1000,periodState:'closed',coverageStatus:'unknown'}));
      return send(200,{schemaVersion:1,symbol,period,seriesId:'fixture-daily-'+symbol,revision:String(1+state.extra),bars:normalized,status:'ready',source:'fixture',currency:quote(symbol,state).currency,historyAsOf:normalized.at(-1).periodStart,coverageStatus:'unknown',hasMore:false});
    }
    if (url.pathname === '/api/news') {
      if (state.newsDelay) await new Promise(resolve => setTimeout(resolve, state.newsDelay));
      const meta = Object.fromEntries((url.searchParams.get('symbols') || 'QQQ,SPY').split(',').map(symbol => [symbol, {updatedAt: Date.now(), stale: false}]));
      return send(200, Object.fromEntries((url.searchParams.get('symbols') || 'QQQ,SPY').split(',').map(symbol => [symbol, [{ title: `${symbol} fixture news`, link: 'https://example.invalid/news', src: 'Fixture', t: Date.now(), sent: '中性' }]])), {'X-News-Meta': Buffer.from(JSON.stringify(meta)).toString('base64url'), 'X-News-Meta-Encoding': 'base64url-json'});
    }
    if (url.pathname === '/api/macro/snapshot') {
      state.macroRequests++;
      if(state.macroError)return send(503,{error:'fixture macro unavailable'});
      return send(200,{news:{items:[{title:'Fixture macro headline',link:'https://example.invalid/macro',src:'Fixture',t:Date.now(),topic:'经济',assessment:{importance:'focus',status:'reported'}}],stale:state.macroStale,error:state.macroStale?'fixture delayed':null,updatedAt:Date.now()-(state.macroStale?600000:0),sources:{fixture:{ok:!state.macroStale}}},context:{factors:[],observations:[],observedAt:Date.now()},monitor:{enabled:true,running:true,lanes:{news:{},context:{}},persistence:{},delivery:{}}});
    }
    if (url.pathname === '/api/macro') {
      state.macroRequests++;
      if (state.macroError) return send(503, { error: 'fixture macro unavailable' });
      return send(200, { items: [{ title: 'Fixture macro headline', link: 'https://example.invalid/macro', src: 'Fixture', t: Date.now(), topic: '经济', sent: '中性' }], stale: state.macroStale, error: state.macroStale ? 'fixture delayed' : null, updatedAt: Date.now() - (state.macroStale ? 600000 : 0), sources: { fixture: { ok: !state.macroStale } } });
    }
    if (url.pathname === '/api/search') return send(200, [{ symbol: 'AAPL', name: 'Apple fixture', market: '美股', type: 'EQUITY' }]);
    if (url.pathname === '/legacy.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>v58 upgrade fixture</title>'); return; }
    if (url.pathname === '/legacy-v58.js') {
      response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/', 'cache-control': 'no-store' });
      response.end("self.addEventListener('install',e=>e.waitUntil(caches.open('qqq-panel-v58').then(c=>c.add('/index.html')).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); return;
    }
    const file = path.resolve(publicRoot, (url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\//, ''));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, { error: 'fixture route absent' });
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
export const test = base.extend({
  panelServer: async ({}, use) => { const server = await createServer(); try { await use(server); } finally { await server.close(); } },
  page: async ({ page, context, panelServer }, use, testInfo) => {
    const external = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === panelServer.url || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      external.push(url.origin); return route.abort('blockedbyclient');
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__PANEL_TEST_HOOK__ = hooks => { window.__hooks = hooks; }; });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    try { await use(page); }
    finally {
      const coverage = await page.coverage.stopJSCoverage();
      if (process.env.QQQSP_COVERAGE_DIR) {
        const directory = path.resolve(process.env.QQQSP_COVERAGE_DIR, '../browser'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, randomUUID() + '.json'), JSON.stringify(coverage));
      }
      await testInfo.attach('browser-runtime-errors', { body: JSON.stringify({ errors, external }, null, 2), contentType: 'application/json' });
      expect(errors, 'No browser runtime exception').toEqual([]);
      expect(external, 'Fixture suite must not contact public servers').toEqual([]);
    }
  },
});
export { expect };
export async function openPanel(page, panelServer, watchlist = ['QQQ', 'SPY'], currencies = {}) {
  await page.addInitScript(({ watchlist, currencies }) => {
    if (!localStorage.getItem('e2e-seeded')) {
      localStorage.setItem('qqq-watchlist', JSON.stringify(watchlist));
      localStorage.setItem('qqq-card-cur', JSON.stringify(currencies));
      localStorage.setItem('e2e-seeded', 'yes');
    }
  }, { watchlist, currencies });
  await page.goto(panelServer.url + '/');
  await expect(page.locator('.price-card')).toHaveCount(watchlist.length);
  await expect(page.locator('.price-card').first().locator('.cur')).not.toHaveText('—');
}
