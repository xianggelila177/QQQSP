import { test, expect } from './real-fixtures.mjs';
import { openPanel, symbols12 } from './fixtures.mjs';

test('real market directory adds FTSE by keyboard without subscribing the entire catalog or changing saved preferences', async ({page,panelServer}) => {
  await page.clock.install();
  await openPanel(page,panelServer,['QQQ','SPY'],{QQQ:'CNY'});
  const before=panelServer.state.marketRequests;
  await page.locator('#marketDirectory summary').focus();await page.keyboard.press('Enter');
  const featured=page.locator('.directory-featured button[data-symbol="^FTSE"]');
  await expect(featured).toContainText('富时');await expect(page.locator('.directory-market')).toHaveCount(21);
  expect(panelServer.state.marketRequests).toBe(before);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('qqq-watchlist')))).toEqual(['QQQ','SPY']);
  await page.getByLabel('浏览市场',{exact:true}).selectOption('uk');
  await expect(page.locator('.directory-market:visible')).toHaveCount(1);
  await test.info().attach('global-market-directory',{body:await page.screenshot(),contentType:'image/png'});
  await featured.focus();await page.keyboard.press('Enter');
  const card=page.locator('.price-card[data-sym="^FTSE"]');
  await expect(card.locator('.cur')).not.toHaveText('—');await expect(card.locator('.unit')).toHaveText('点');
  await expect(card.locator('.ccyseg')).toBeHidden();
  await expect(card.locator('.chart-main')).toHaveAttribute('aria-label',/\^FTSE/);
  await card.locator('.chart-main').focus();await page.keyboard.press('End');
  await expect(card.locator('.chart-point')).toContainText('^FTSE');await expect(card.locator('.chart-point')).not.toContainText('¥');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('qqq-card-cur')))).toEqual({QQQ:'CNY'});
  await featured.click();await expect(page.locator('.price-card')).toHaveCount(3);
  await expect(page.locator('#marketDirectoryStatus')).toContainText('已在自选');
});

test('real UI keeps native pence and cents intact across card, chart, storage and unavailable FX at 320px', async ({page,panelServer}) => {
  await page.clock.install();await page.setViewportSize({width:320,height:820});
  const common={fxKind:'reference',fxDate:'2026-09-04',fxMap:{USD:7,GBP:0.8,ZAR:18},fxStale:false,marketState:'CLOSED',instrumentType:'EQUITY',priceSession:'REGULAR',charts:{intraday:[{t:1788508800,o:900,h:1100,l:800,c:1000,v:100}],daily30:[{t:1788480000,o:900,h:1100,l:800,c:1000,v:100}]}};
  panelServer.state.quotePatches={'VOD.L':{...common,price:1000,change:100,currency:'GBp',market:'英股'},'NPN.JO':{...common,price:1800,change:180,currency:'ZAc',market:'南非股'}};
  await openPanel(page,panelServer,['VOD.L','NPN.JO'],{'VOD.L':'NATIVE'});
  const vod=page.locator('.price-card[data-sym="VOD.L"]'),npn=page.locator('.price-card[data-sym="NPN.JO"]');
  await expect(vod.locator('.cur')).toHaveText('1,000.00');await expect(vod.locator('.unit')).toHaveText('GBp');
  await expect(vod.locator('.fx-note')).toContainText('100 GBp = 1 GBP');
  await expect(npn.locator('.cur')).toHaveText('≈1.00');
  await test.info().attach('global-market-native-320px',{body:await page.screenshot(),contentType:'image/png'});
  await vod.getByRole('button',{name:'CNY',exact:true}).click();await expect(vod.locator('.cur')).toHaveText('≈¥87.50');
  await vod.locator('.chart-main').focus();await page.keyboard.press('End');await expect(vod.locator('.chart-point')).toContainText('87.50');
  await vod.getByRole('button',{name:'原币',exact:true}).click();await expect(vod.locator('.cur')).toHaveText('1,000.00');
  await expect(vod.locator('.ohlcbar')).toContainText('1,000.00');
  await page.reload();await expect(vod.locator('[data-ccy="NATIVE"]')).toHaveAttribute('aria-pressed','true');
  await expect(vod.locator('.unit')).toHaveText('GBp');
  panelServer.state.quotePatches['VOD.L']={...panelServer.state.quotePatches['VOD.L'],fxMap:{USD:7}};
  panelServer.app.services.quote.cacheMap.clear();await page.evaluate(()=>window.__hooks.refresh(true));
  await vod.getByRole('button',{name:'USD',exact:true}).click();await expect(vod.locator('.cur')).toHaveText('1,000.00');
  await expect(vod.locator('.fx-note')).toContainText('汇率暂缺或过期');
  const dimensions=await page.evaluate(()=>({viewport:innerWidth,body:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.price-card')].map(card=>({client:card.clientWidth,scroll:card.scrollWidth}))}));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);for(const card of dimensions.cards)expect(card.scroll).toBeLessThanOrEqual(card.client);
});

test.describe('directory transport failure',()=>{
// This test injects one HTTP failure via Playwright routing, which does not
// intercept page requests already owned by a service worker. SW behavior has
// separate real-browser journeys; keep this fault injection deterministic.
test.use({serviceWorkers:'block'});
test('directory failure retries independently and cannot add a thirteenth watch item',async({page,panelServer})=>{
  await page.clock.install();await openPanel(page,panelServer,symbols12);
  let first=true;await page.route('**/api/markets',route=>{if(first){first=false;return route.fulfill({status:503,body:'{}',contentType:'application/json'});}return route.continue();});
  await page.locator('#marketDirectory summary').click();await expect(page.locator('#marketDirectoryStatus')).toContainText('加载失败');
  await expect(page.locator('.price-card')).toHaveCount(12);
  await page.getByRole('button',{name:'重试加载市场目录'}).click();
  await page.locator('.directory-featured button[data-symbol="^FTSE"]').click();
  await expect(page.locator('#marketDirectoryStatus')).toContainText('未添加');await expect(page.locator('.price-card')).toHaveCount(12);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('qqq-watchlist')))).toEqual(symbols12);
});
});

test('unannounced session exposes source warning and never reports the market as closed',async({page,panelServer})=>{
  await page.clock.install();panelServer.state.quotePatches={'M&M.NS':{marketState:'UNKNOWN',currency:'INR',market:'印股',calendarCoverage:{known:false,pending:true,reason:'session-pending',note:'特殊交易日时间尚未公布'}}};
  await openPanel(page,panelServer,['M&M.NS']);
  const card=page.locator('.price-card[data-sym="M&M.NS"]');
  await expect(card.locator('.state')).toHaveText('交易时段待公布');
  await expect(card.locator('.quote-meta')).toContainText('特殊交易日时间尚未公布');
  await expect(page.locator('#session')).toContainText('时段待公布');
  await expect(card.locator('.state')).not.toContainText(/已收盘|非交易时段/);
});
