import { test, expect, openPanel, version, symbols12 } from './fixtures.mjs';

test('market identity, failures, recovery and watchlist/news generation', async ({ page, panelServer }) => {
  await openPanel(page, panelServer, ['QQQ', '^N225']);
  const qqq = page.locator('.price-card[data-sym="QQQ"]');
  await expect(qqq).toContainText('ETF');
  await expect(page.locator('.price-card[data-sym="^N225"] .mkttag')).toContainText('日股');
  panelServer.state.marketError = true;
  await page.locator('#btnRefresh').click();
  await expect(qqq).toContainText(/失败|不可用|旧|异常/);
  panelServer.state.marketError = false;
  await page.locator('#btnRefresh').click();
  await expect(qqq.locator('.cur')).not.toHaveText('—');
  panelServer.state.newsDelay = 400;
  await page.evaluate(() => { window.__pendingNews = window.__hooks.refreshNews(); });
  await qqq.locator('.cardclose').click();
  await page.evaluate(() => window.__pendingNews);
  await expect(qqq).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qqq-watchlist')))).toEqual(['^N225']);
  await page.locator('#q').fill('Apple');
  await expect(page.locator('#sresults')).toBeVisible();
  await page.locator('#q').press('ArrowDown'); await page.locator('#q').press('Enter');
  await expect(page.locator('.price-card[data-sym="AAPL"]')).toBeVisible();
});

test('macro cache, error/retry status and stable keyboard focus', async ({ page, panelServer }) => {
  await openPanel(page, panelServer);
  await page.locator('.macrohead').click();
  await expect(page.locator('#macrolist')).toContainText('Fixture macro headline');
  const filter = page.locator('.mfbtn[data-f="经济"]');
  await filter.focus();
  await page.evaluate(async () => { window.__oldFilter = document.activeElement; await window.__hooks.refreshMacro(); });
  expect(await page.evaluate(() => window.__oldFilter === document.activeElement && document.activeElement.isConnected)).toBe(true);
  panelServer.state.macroError = true;
  await page.evaluate(() => window.__hooks.refreshMacro());
  await expect(page.locator('#macroStatus')).toContainText(/失败|不可用|旧|异常/);
  await expect(page.locator('#macrolist')).toContainText('Fixture macro headline');
  await expect(page.locator('#macroRetry')).toBeVisible();
  panelServer.state.macroError = false; panelServer.state.macroStale = true;
  await page.locator('#macroRetry').click();
  await expect(page.locator('#macroStatus')).toContainText(/旧|延迟|缓存/);
  await expect(page.locator('#macroStatus')).toHaveAttribute('data-state', 'stale');
  panelServer.state.macroStale = false;
  await page.evaluate(() => window.__hooks.refreshMacro());
  await expect(page.locator('#macroRetry')).toBeHidden();
});

test('v58 service-worker upgrade preserves preferences and serves offline assets', async ({ page, context, panelServer }) => {
  expect(Number(version)).toBeGreaterThan(58);
  await page.goto(panelServer.url + '/legacy.html');
  await page.evaluate(async () => {
    localStorage.setItem('qqq-watchlist', JSON.stringify(['SPY', 'QQQ']));
    localStorage.setItem('qqq-card-cur', JSON.stringify({ SPY: 'CNY' }));
    await navigator.serviceWorker.register('/legacy-v58.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain('qqq-panel-v58');
  await page.goto(panelServer.url + '/');
  await expect(page.locator('.price-card')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => caches.keys())).toContain('qqq-panel-v' + version);
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain('qqq-panel-v58');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qqq-watchlist')))).toEqual(['SPY', 'QQQ']);
  await expect(page.locator('.price-card[data-sym="SPY"] [data-ccy="CNY"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#q')).toBeVisible();
  await expect(page.locator('#updateAt')).toContainText(/失败|异常|连接|重试|离线/);
  await context.setOffline(false);
  await page.locator('#btnRefresh').click();
  await expect(page.locator('.price-card .cur').first()).not.toHaveText('—');
});

test('12-card long-chart pointer/layout benchmark and independent timeframe follow', async ({ page, panelServer }, testInfo) => {
  panelServer.state.longCharts = true;
  await openPanel(page, panelServer, symbols12);
  const first = page.locator('.price-card').first();
  await first.locator('[data-tf="daily30"]').click();
  await expect(first.locator('.chart-summary')).toContainText('日K');
  await first.locator('[data-z="in"]').click();
  const second = page.locator('.price-card').nth(1);
  await expect(second.locator('[data-tf="intraday"]')).toHaveAttribute('aria-pressed', 'true');
  const canvas = first.locator('.chart-main'); const rect = await canvas.boundingBox();
  const before = await page.evaluate(() => { window.__perfEntries = []; window.__observer = new PerformanceObserver(list => window.__perfEntries.push(...list.getEntries().map(e => e.duration))); window.__observer.observe({ entryTypes: ['longtask'] }); return performance.now(); });
  for (let i = 0; i < 48; i++) await page.mouse.move(rect.x + 5 + (rect.width - 10) * i / 48, rect.y + rect.height / 2);
  const metrics = await page.evaluate(start => { window.__observer.disconnect(); return { durationMs: performance.now() - start, longTasks: window.__perfEntries, canvases: document.querySelectorAll('canvas.chart-main').length }; }, before);
  await testInfo.attach('pointer-benchmark.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect(metrics.canvases).toBe(12);
  expect(metrics.durationMs).toBeLessThan(10000);
  expect(metrics.longTasks.filter(ms => ms > 200).length).toBe(0);
  const slider = first.locator('.xslide');
  await slider.evaluate(node => { node.value = '0'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  panelServer.state.extra++;
  await page.evaluate(() => window.__hooks.refresh(true));
  await expect(slider).toHaveValue('0');
  await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/history'),page.evaluate(()=>window.dispatchEvent(new Event('focus')))]);
  await expect(slider).toHaveValue('0');
  await first.locator('[data-tf="intraday"]').click();
  await first.locator('[data-tf="daily30"]').click();
  await expect(slider).toHaveValue('0');
  await first.locator('[data-z="latest"]').click();
  await expect.poll(() => slider.evaluate(node => node.value === node.max)).toBe(true);
  const oldMax = Number(await slider.getAttribute('max'));
  panelServer.state.extra++;
  await page.evaluate(() => window.__hooks.refresh(true));
  expect(Number(await slider.getAttribute('max'))).toBe(oldMax); // Quotes cannot overwrite the independent daily history.
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(() => slider.evaluate(node => Number(node.max))).toBe(oldMax + 1);
  await expect.poll(() => slider.evaluate(node => node.value === node.max)).toBe(true);
  await expect(first.locator('[data-tf="daily30"]')).toHaveAttribute('aria-pressed', 'true');
});

test('simulated background timer throttling retains worker refresh and foreground catch-up', async ({ page, panelServer }) => {
  await page.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
    const nativeInterval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => nativeInterval(() => { if (!window.__hidden) callback(...args); }, ms);
    window.__setHidden = value => { window.__hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  });
  await openPanel(page, panelServer);
  expect(await page.evaluate(() => window.__hooks.heartbeatMode())).toBe('worker');
  await page.evaluate(() => window.__hooks.setRefreshMode('continuous'));
  await page.evaluate(() => { window.__probe = 0; setInterval(() => window.__probe++, 100); window.__setHidden(true); });
  const requests = panelServer.state.marketRequests;
  await expect.poll(() => panelServer.state.marketRequests, { timeout: 10000 }).toBeGreaterThan(requests);
  expect(await page.evaluate(() => window.__probe)).toBe(0);
  const hiddenRequests = panelServer.state.marketRequests;
  await page.evaluate(() => window.__setHidden(false));
  await expect.poll(() => panelServer.state.marketRequests, { timeout: 1500 }).toBeGreaterThan(hiddenRequests);
});

test('reference conversions and offline recovery are visibly distinguished',async({page,panelServer})=>{
  panelServer.state.quotePatch={fxKind:'reference',fxSource:'ECB',fxDate:'2026-09-04'};
  await openPanel(page,panelServer,['QQQ'],{QQQ:'CNY'});
  const card=page.locator('.price-card[data-sym="QQQ"]');
  await expect(card.locator('.cur')).toHaveText('≈¥3,529.80');
  await expect(card.locator('.fx-note')).toContainText('欧洲央行 2026-09-04');
  await expect(card.locator('.fx-note')).toContainText('非实时汇率');
  await card.locator('[data-ccy="USD"]').click();
  await expect(card.locator('.cur')).toHaveText('490.25');
  await expect(card.locator('.fx-note')).toBeHidden();
  panelServer.state.quotePatch={...panelServer.state.quotePatch,recovery:true,stale:true,staleInfo:{reason:'offline-cache'},fxStale:true,quoteAt:Date.now()-86400000};
  await page.locator('#btnRefresh').click();
  await expect(card.locator('.stale-warn')).toHaveText('离线缓存·旧报价');
  await card.locator('[data-ccy="CNY"]').click();
  await expect(card.locator('.unit')).toHaveText('USD');
  panelServer.state.quotePatch={fxKind:'market',fxStale:false};
  await page.locator('#btnRefresh').click();
  await expect(card.locator('.stale-warn')).toBeHidden();
  await expect(card.locator('.cur')).toHaveText('¥3,529.80');
});
