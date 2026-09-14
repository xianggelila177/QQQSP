import { test, expect, openPanel } from './fixtures.mjs';

// CDP emits trusted native touch input, allowing Chromium to arbitrate pan-y
// scrolling and dispatch pointercancel. No synthetic PointerEvent substitutes.
test('Chromium touch horizontal drag, vertical scroll cancellation and subsequent card selection', async ({ page, context, panelServer }, testInfo) => {
  panelServer.state.longCharts = true;
  await openPanel(page, panelServer, ['QQQ', 'SPY', 'AAPL']);
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  const cdp = await context.newCDPSession(page);
  const card = page.locator('.price-card[data-sym="QQQ"]');
  const canvas = card.locator('.chart-main');
  await canvas.scrollIntoViewIfNeeded();
  await canvas.evaluate(node => {
    window.__touchEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) node.addEventListener(type, event => window.__touchEvents.push({type, trusted:event.isTrusted, pointerType:event.pointerType}));
  });
  const drag = async (start, end) => {
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:start.x,y:start.y,id:1}]});
    for (let i=1;i<=8;i++) await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*i/8,y:start.y+(end.y-start.y)*i/8,id:1}]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  };
  let rect = await canvas.boundingBox();
  const before = Number(await card.locator('.xslide').inputValue());
  await drag({x:rect.x+rect.width*.2,y:rect.y+rect.height*.5},{x:rect.x+rect.width*.7,y:rect.y+rect.height*.5});
  await expect.poll(async () => Number(await card.locator('.xslide').inputValue())).toBeLessThan(before);
  expect(await page.evaluate(() => window.__touchEvents.some(e=>e.type==='pointermove'&&e.trusted&&e.pointerType==='touch'))).toBe(true);
  rect = await canvas.boundingBox();
  const scrollBefore = await page.evaluate(() => scrollY);
  await drag({x:rect.x+rect.width*.5,y:rect.y+rect.height*.8},{x:rect.x+rect.width*.5,y:Math.max(20,rect.y+rect.height*.8-160)});
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBefore+30);
  expect(await page.evaluate(() => window.__touchEvents.some(e=>e.type==='pointercancel'&&e.trusted&&e.pointerType==='touch'))).toBe(true);
  expect(await canvas.evaluate(node => node.style.cursor)).toBe('crosshair');
  const next = page.locator('.price-card[data-sym="SPY"]');
  await next.locator('.chart-main').scrollIntoViewIfNeeded();
  rect = await next.locator('.chart-main').boundingBox();
  await page.touchscreen.tap(rect.x+rect.width*.6,rect.y+rect.height*.5);
  await expect(next.locator('.chart-point')).toContainText(/SPY.*价.*第/);
  await testInfo.attach('touch-evidence.json',{body:JSON.stringify({engine:'Chromium',hasTouch:true,isMobile:true,events:await page.evaluate(()=>window.__touchEvents),webkit:false,physicalDevice:false},null,2),contentType:'application/json'});
  await cdp.detach();
});
