import { test, expect } from './real-fixtures.mjs';
import { openPanel } from './fixtures.mjs';

test('real HTTP full/same/tail chart contract, partial news metadata and quota recovery', async ({ page, panelServer }) => {
  await page.clock.install();
  const firstResponse = page.waitForResponse(response => response.url().includes('/api/market') && response.status() === 200);
  await openPanel(page, panelServer);
  const response = await firstResponse;
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
  const initial = (await response.json())[0];
  expect(initial.intradayVer).toBeGreaterThan(0); expect(initial.daily30Ver).toBeGreaterThan(0);
  expect(initial.charts.intraday.length).toBeGreaterThan(0);
  await page.evaluate(() => { window.__savedIntraday = window.__hooks.intradayCacheRef().QQQ.bars; window.__savedDrawKey = window.__hooks.cardCache.get('QQQ')._drawKey; });
  const sameResponse = page.waitForResponse(response => response.url().includes('/api/market') && new URL(response.url()).searchParams.has('cv'));
  await page.evaluate(() => window.__hooks.refresh(true));
  const same = (await (await sameResponse).json())[0];
  expect(same.charts.intraday).toBe('same'); expect(same.charts.daily30).toBe('same');
  expect(panelServer.state.requests.some(cv => cv?.includes(`QQQ:${initial.intradayVer}:${initial.daily30Ver}`))).toBe(true);
  expect(await page.evaluate(() => window.__savedIntraday === window.__hooks.intradayCacheRef().QQQ.bars)).toBe(true);
  expect(await page.evaluate(() => window.__savedDrawKey === window.__hooks.cardCache.get('QQQ')._drawKey)).toBe(true);
  panelServer.state.tailDelta = 3;
  panelServer.app.services.quote.cacheMap.clear();
  const changedResponse = page.waitForResponse(response => response.url().includes('/api/market'));
  await page.evaluate(() => window.__hooks.refresh(true));
  const changed = (await (await changedResponse).json())[0];
  expect(changed.intradayVer).not.toBe(initial.intradayVer);
  expect(changed.charts.intraday.at(-1).c).toBe(initial.charts.intraday.at(-1).c + 3);
  expect(changed.charts.intraday.slice(0, -1)).toEqual(initial.charts.intraday.slice(0, -1));
  const stored = await page.evaluate(() => window.__hooks.intradayCacheRef().QQQ.bars.at(-1).c);
  expect(stored).toBe(changed.charts.intraday.at(-1).c);
  const card = page.locator('.price-card[data-sym="QQQ"]');
  await card.locator('.chart-main').focus(); await page.keyboard.press('End');
  await expect(card.locator('.chart-point')).toContainText(changed.charts.intraday.at(-1).c.toFixed(2));
  const news = await page.request.get(panelServer.url + '/api/news?symbols=QQQ,SPY');
  expect(news.status()).toBe(200); expect(news.headers()['x-news-meta-encoding']).toBe('base64url-json');
  const meta = JSON.parse(Buffer.from(news.headers()['x-news-meta'], 'base64url').toString());
  expect(meta.QQQ.stale).toBe(false); expect(meta.QQQ.updatedAt).toBeGreaterThan(0);
  expect(meta.SPY.stale).toBe(true); expect(meta.SPY.updatedAt).toBeNull(); expect(meta.SPY.error).toContain('partial');
  await expect(card.locator('.newsbox')).toContainText('real application news');
  await expect(page.locator('.price-card[data-sym="SPY"] .newshead')).toContainText('暂不可用');
  // Exhaust the real HTTP admission quota; the browser must show the failure,
  // preserve a quote, then recover after the injected server clock's window.
  let limited;
  for (let i = 0; i < 35; i++) { limited = await page.request.get(panelServer.url + '/api/market?symbols=QQQ'); if (limited.status() === 429) break; }
  expect(limited.status()).toBe(429); expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
  await page.evaluate(() => window.__hooks.refresh(true));
  await expect(page.locator('#updateAt')).toContainText(/失败|异常|连接|重试|限流/);
  expect(await card.locator('.cur').textContent()).not.toBe('—');
  panelServer.state.clockOffset += 61000;
  await page.clock.setSystemTime(Date.now() + 61000);
  await page.evaluate(() => window.__hooks.refresh(true));
  await expect(page.locator('#updateAt')).not.toContainText(/请求失败|连接异常|重试|限流/);
  await expect(card.locator('.cur')).not.toHaveText('—');
});

test('production Node modules execute verbatim in the integration runner', async () => {
  const {readFileSync}=await import('node:fs');
  const {createRecoveryStore}=await import('../../lib/recovery-store.js');
  const original=readFileSync(new URL('../../lib/recovery-store.js',import.meta.url),'utf8');
  const expected=original.slice(original.indexOf('export function createRecoveryStore')+'export '.length).trimEnd();
  expect(createRecoveryStore.toString()).toBe(expected);
});
async function geometry(page) {
  return page.evaluate(() => [...document.querySelectorAll('.price-card')].map(c => {
    const r=c.getBoundingClientRect(), rect=s=>c.querySelector(s).getBoundingClientRect();
    return {top:Math.round(r.top),height:r.height,chart:rect('.chartframe').top-r.top,chartHeight:rect('.chartframe').height,grid:rect('.grid').top-r.top,footer:rect('.newsbox').top-r.top};
  }));
}
function aligned(items) {
  expect(items).toHaveLength(7);
  for(const key of ['height','chart','chartHeight','grid','footer']) expect(Math.max(...items.map(x=>x[key]))-Math.min(...items.map(x=>x[key])),key).toBeLessThanOrEqual(2);
}
test('phase2 strict mixed layout and mobile',async({page,panelServer},info)=>{
  await page.setViewportSize({width:1920,height:1200});
  panelServer.state.quotePatches={'000300.SS':{instrumentType:'INDEX',name:'沪深300指数'},'600519.SS':{name:'贵州茅台'}};
  await openPanel(page,panelServer,['QQQ','SPY','AAPL','^GSPC','000300.SS','600519.SS','0700.HK']);
  await expect(page.locator('.price-card')).toHaveCount(7);
  await page.evaluate(()=>{window.__phase2Canvas=[...document.querySelectorAll('.price-card canvas')];});
  await page.locator('.price-card').first().locator('[data-tf="daily30"]').click();await page.waitForTimeout(300);
  const initial=await geometry(page);aligned(initial);
  expect([...new Set(initial.map(x=>x.top))].map(t=>initial.filter(x=>x.top===t).length)).toEqual([4,3]);
  for(let i=0;i<20;i++) {
    await page.locator('#layoutPreference').selectOption(String(2+i%3));
    await page.locator('.price-card').first().locator(`[data-tf="${i%2?'intraday':'daily30'}"]`).click();
    await page.waitForTimeout(100);aligned(await geometry(page));
  }
  expect(await page.evaluate(()=>window.__phase2Canvas.every((c,i)=>c===document.querySelectorAll('.price-card canvas')[i]))).toBe(true);
  await page.locator('#layoutPreference').selectOption('4');await page.waitForTimeout(200);
  const folded=await geometry(page);
  await page.locator('.price-card').first().locator('.newshead').click();await page.waitForTimeout(200);
  const expanded=await geometry(page);expect(expanded[0].height).toBeGreaterThan(folded[0].height);
  for(let i=4;i<7;i++)expect(expanded[i].height).toBeLessThanOrEqual(folded[i].height+2);
  await page.locator('.price-card').first().locator('.newshead').click();await page.waitForTimeout(200);aligned(await geometry(page));
  await info.attach('desktop-geometry',{body:JSON.stringify({initial,folded,expanded},null,2),contentType:'application/json'});
  await page.screenshot({path:info.outputPath('desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(new Set((await geometry(page)).map(x=>x.top)).size).toBe(7);
  await page.locator('.price-card').first().locator('.newshead').click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('mobile.png'),fullPage:true});
});
test('phase2 real 60 second age cadence without new quote or chart rebuild',async({page,panelServer},info)=>{
  test.setTimeout(90000);const quoteAt=Date.now()-125000;
  panelServer.state.quotePatch={quoteAt,ts:quoteAt,sourceCheckedAt:quoteAt+100000};
  await openPanel(page,panelServer,['QQQ']);await expect(page.locator('.quote-age')).toContainText('2分');
  await page.evaluate(()=>{
    window.__ageSamples=[];window.__ageCanvas=[...document.querySelectorAll('.price-card canvas')];const el=document.querySelector('.quote-age');
    const record=()=>window.__ageSamples.push({at:performance.now(),computed:Number(el.dataset.ageComputedAtMs),quoteAt:el.dataset.quoteAsofMs,text:el.textContent});
    record();window.__ageObserver=new MutationObserver(record);window.__ageObserver.observe(el,{attributes:true,attributeFilter:['data-age-computed-at-ms']});
  });
  await page.waitForTimeout(61000);
  const result=await page.evaluate(()=>{window.__ageObserver.disconnect();return {samples:window.__ageSamples,sameCanvas:window.__ageCanvas.every((c,i)=>c===document.querySelectorAll('.price-card canvas')[i])};});
  result.maxGapMs=Math.max(...result.samples.slice(1).map((x,i)=>x.at-result.samples[i].at));
  await info.attach('age-60-second-raw',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  expect(result.samples.length).toBeGreaterThanOrEqual(60);expect(result.maxGapMs).toBeLessThanOrEqual(1200);
  expect(new Set(result.samples.map(x=>x.quoteAt))).toEqual(new Set([String(quoteAt)]));
  expect(result.samples.at(-1).computed-result.samples[0].computed).toBeGreaterThanOrEqual(60000);
  expect(result.sameCanvas).toBe(true);expect(result.samples.at(-1).text).toMatch(/3分\d{2}秒/);
});
