import { test, expect, openPanel } from './fixtures.mjs';
test.use({serviceWorkers:'block'});

function history(period,count=79){
  const latest=new Date(period==='yearly'?'2026-01-01T00:00:00Z':period==='monthly'?'2026-09-01T00:00:00Z':period==='weekly'?'2026-09-07T00:00:00Z':'2026-09-10T00:00:00Z');
  const date=i=>{const d=new Date(latest);if(period==='yearly')d.setUTCFullYear(d.getUTCFullYear()+i-count+1);else if(period==='monthly')d.setUTCMonth(d.getUTCMonth()+i-count+1);else d.setUTCDate(d.getUTCDate()+(i-count+1)*(period==='weekly'?7:1));return d.toISOString().slice(0,10);};
  return {schemaVersion:1,symbol:'QQQ',period,seriesId:'fixture-'+period,revision:'r'+count,source:'fixture',currency:'USD',adjustmentBasis:'raw',volumeUnit:'shares',coverageStatus:'unknown',status:'ready',warnings:[],historyAsOf:'2026-09-10',sourceCheckedAt:Date.now(),stale:false,hasMore:false,bars:Array.from({length:count},(_,i)=>({t:Date.parse(date(i)+'T00:00:00Z')/1000,periodStart:date(i),periodEndExclusive:date(i+1),firstTradingDate:date(i),lastTradingDate:date(i),periodState:i===count-1?'open':'closed',coverageStatus:'unknown',o:100+i,h:103+i,l:99+i,c:101+i,v:null}))};
}

test('period history is isolated from quote refresh and supports keyboard/zoom', async ({page,panelServer}, testInfo) => {
  await page.route('**/api/history**', async route => {
    const period = new URL(route.request().url()).searchParams.get('period');
    await route.fulfill({contentType:'application/json',body:JSON.stringify(history(period, period==='yearly'?39:79))});
  });
  await openPanel(page,panelServer,['QQQ']);
  const card=page.locator('.price-card[data-sym="QQQ"]');
  await card.locator('[data-tf="yearly"]').click();
  await expect(card.locator('[data-tf="yearly"]')).toHaveAttribute('aria-pressed','true');
  await expect(card.locator('.chart-summary')).toContainText('年K');
  await expect(card.locator('.chart-summary')).toContainText('20 个数据点');
  for (const [period,label] of [['weekly','weekly'],['monthly','monthly'],['yearly','yearly']]) {
    await card.locator(`[data-tf="${period}"]`).click();
    await expect(card.locator(`[data-tf="${period}"]`)).toHaveAttribute('aria-pressed','true');
    for (const width of [390,768,1440,1920]) { await page.setViewportSize({width,height:900}); await testInfo.attach(`${label}-${width}.png`, {body:await page.screenshot(),contentType:'image/png'}); }
  }
  await card.locator('[data-z="in"]').click();
  await card.locator('.chart-main').focus(); await card.locator('.chart-main').press('Home');
  await expect(card.locator('.chart-point')).toContainText(/第 \d+\/39 点/);
  await page.evaluate(() => window.__hooks.refresh(true));
  await expect(card.locator('.chart-summary')).toContainText('年K');
});

test('all five timeframe controls remain keyboard reachable at narrow and wide widths', async ({page,panelServer}) => {
  await page.route('**/api/history**', async route => route.fulfill({contentType:'application/json',body:JSON.stringify(history(new URL(route.request().url()).searchParams.get('period'),79))}));
  await openPanel(page,panelServer,['QQQ']);
  for (const width of [390,768,1440,1920]) { await page.setViewportSize({width,height:900}); const tabs=page.locator('.price-card .tfbtn'); await expect(tabs).toHaveCount(5); for(let i=0;i<5;i++){await tabs.nth(i).focus();await expect(tabs.nth(i)).toBeFocused();} }
});


test('invalid OHLC shows failure; one to three real annual bars remain usable with unknown volume', async ({page,panelServer}) => {
  let count=1,bad=true;
  await page.route('**/api/history**',async route=>{
    const j=history('yearly',count);if(bad)j.bars[0].o=null;
    await route.fulfill({contentType:'application/json',body:JSON.stringify(j)});
  });
  await openPanel(page,panelServer,['QQQ']);const card=page.locator('.price-card[data-sym="QQQ"]');
  await card.locator('[data-tf="yearly"]').click();await expect(card.locator('.ohlcbar')).toContainText('历史来源暂不可用');await expect(card.locator('.chart-retry')).toBeVisible();
  bad=false;
  await card.locator('[data-tf="intraday"]').click();await card.locator('[data-tf="yearly"]').click();
  await expect(card.locator('.chart-summary')).toContainText('1 个数据点');
  await expect(card.locator('.ohlcbar')).toContainText('未收盘');
  for(count=2;count<=3;count++){
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(card.locator('.chart-point')).toContainText('/'+count+' 点');
    await card.locator('[data-z="fit"]').click();
    await expect(card.locator('.chart-summary')).toContainText(count+' 个数据点');
    await card.locator('[data-z="in"]').click();await card.locator('[data-z="fit"]').click();
  }
  await expect(card.locator('.ohlcbar')).toContainText('历史覆盖未知');
  await expect(card.locator('.ohlcbar')).not.toContainText('[object Object]');
});

test('identity conflict retries once and minute refresh preserves keyboard focus', async ({page,panelServer}) => {
  let calls=0;const urls=[];
  await page.route('**/api/history**',async route=>{
    const url=new URL(route.request().url());urls.push(url.searchParams.get('seriesId'));calls++;
    if(calls===2)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'changed'})});
    const j=history('monthly',79);j.seriesId=calls===1?'first':'second';j.revision='r'+calls;
    await route.fulfill({contentType:'application/json',body:JSON.stringify(j)});
  });
  // Prewarm marks history freshly prepared and would suppress the 60s refresh;
  // keep the minute-refresh path deterministic (registered last, wins over the counter).
  await page.route('**/api/history/bundle**',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.route('**/api/history/watchlist**',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.clock.install();
  await openPanel(page,panelServer,['QQQ']);const card=page.locator('.price-card[data-sym="QQQ"]');
  await card.locator('[data-tf="monthly"]').click();await expect(card.locator('.chart-summary')).toContainText('月K');
  const zoom=card.locator('[data-z="in"]');await zoom.focus();
  await page.clock.fastForward(60001);await expect.poll(()=>calls).toBe(3);await expect(zoom).toBeFocused();
  expect(urls.slice(0,3)).toEqual([null,'first',null]);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>calls).toBe(4);
});

test('late historical response cannot replace selected tab or recreate a removed card', async ({page,panelServer})=>{
  let release;const delayed=new Promise(resolve=>release=resolve);let started=false;
  await page.route('**/api/history**',async route=>{
    const period=new URL(route.request().url()).searchParams.get('period');
    if(period==='weekly'){started=true;await delayed;}
    try{await route.fulfill({contentType:'application/json',body:JSON.stringify(history(period,3))});}catch{}
  });
  await openPanel(page,panelServer,['QQQ']);const card=page.locator('.price-card[data-sym="QQQ"]');
  await card.locator('[data-tf="weekly"]').click();await expect.poll(()=>started).toBe(true);
  await card.locator('[data-tf="yearly"]').click();await expect(card.locator('.chart-summary')).toContainText('年K');
  await card.locator('.cardclose').click();release();await expect(card).toHaveCount(0);
});

 test('fifty timeframe switches reuse data and removed card stops its history timer',async({page,panelServer})=>{
  let calls=0;await page.route('**/api/history**',async route=>{calls++;const period=new URL(route.request().url()).searchParams.get('period');await route.fulfill({contentType:'application/json',body:JSON.stringify(history(period,3))});});
  await page.clock.install();await openPanel(page,panelServer,['QQQ']);const card=page.locator('.price-card[data-sym="QQQ"]');
  const periods=['daily30','weekly','monthly','yearly','intraday'];
  for(let i=0;i<50;i++){await card.locator('[data-tf="'+periods[i%5]+'"]').click();}
  expect(calls).toBe(4);await card.locator('.cardclose').click();await page.clock.fastForward(120001);expect(calls).toBe(4);await expect(card).toHaveCount(0);
});
