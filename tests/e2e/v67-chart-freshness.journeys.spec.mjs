import {test,expect,openPanel} from './fixtures.mjs';

test.use({serviceWorkers:'block'});
const cardFor=page=>page.locator('.price-card[data-sym="QQQ"]');
const snapshot=page=>page.evaluate(()=>{
 const q=window.__hooks.cardCache.get('QQQ');
 return {tail:{...q.plot.bars.at(-1)},allTail:{...q.d.charts.intraday.at(-1)},revision:q.d.intradayVer,
  followEnd:q.followEnd,start:q.winStart,count:q.plot.all.length,canvas:q.cv.toDataURL()};
});

test('v67 frontend redraws changed full intraday data at an unchanged tail timestamp within the same refresh',async({page,panelServer})=>{
 await page.clock.install();await openPanel(page,panelServer,['QQQ']);
 const before=await snapshot(page);
 panelServer.state.tailDelta=3.25;
 await page.evaluate(()=>window.__hooks.refresh(true));
 const after=await snapshot(page);
 expect(after.tail.t).toBe(before.tail.t);
 expect(after.tail.c).toBe(before.tail.c+3.25);
 expect(after.revision).not.toBe(before.revision);
 expect(after.canvas).not.toBe(before.canvas);
 await expect(cardFor(page).locator('.ohlcbar')).toContainText(after.tail.c.toFixed(2));
 await expect(cardFor(page).locator('.chart-point')).toContainText(after.tail.c.toFixed(2));
});

test('v67 frontend redraws legacy same tail patches with unchanged revision and timestamp',async({page,panelServer})=>{
 await page.clock.install();await openPanel(page,panelServer,['QQQ']);
 const before=await snapshot(page);
 const payload=await page.evaluate(()=>JSON.parse(JSON.stringify(window.__hooks.cardCache.get('QQQ').d)));
 payload.charts={intraday:'same',daily30:'same'};
 payload.intradayLast=[before.tail.t,before.tail.c+1.25];
 payload.price=before.tail.c+1.25;
 await page.route('**/api/market?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([payload])}));
 await page.evaluate(()=>window.__hooks.refresh(true));
 const after=await snapshot(page);
 expect(after.revision).toBe(before.revision);expect(after.tail.t).toBe(before.tail.t);
 expect(after.tail.c).toBe(before.tail.c+1.25);expect(after.canvas).not.toBe(before.canvas);
 await expect(cardFor(page).locator('.ohlcbar')).toContainText(after.tail.c.toFixed(2));
});

test('v67 frontend preserves same data and follows new points unless user selected a historical window',async({page,panelServer})=>{
 await page.clock.install();await openPanel(page,panelServer,['QQQ']);
 const before=await snapshot(page);
 await page.evaluate(()=>window.__hooks.refresh(true));
 const same=await snapshot(page);expect(same.canvas).toBe(before.canvas);expect(same.tail).toEqual(before.tail);
 expect(panelServer.state.requests.at(-1)).toContain('QQQ:'+before.revision+':');
 panelServer.state.extra++;
 await page.evaluate(()=>window.__hooks.refresh(true));
 const appended=await snapshot(page);expect(appended.followEnd).toBe(true);expect(appended.tail.t).toBe(before.tail.t+60);expect(appended.start).toBe(before.start+1);
 const slider=cardFor(page).locator('.xslide');
 await slider.evaluate(node=>{node.value='0';node.dispatchEvent(new Event('input',{bubbles:true}));});
 const history=await snapshot(page);expect(history.followEnd).toBe(false);
 panelServer.state.extra++;await page.evaluate(()=>window.__hooks.refresh(true));
 const retained=await snapshot(page);expect(retained.start).toBe(0);expect(retained.tail).toEqual(history.tail);
 await cardFor(page).getByRole('button',{name:'跟随最新',exact:true}).click();
 const latest=await snapshot(page);expect(latest.followEnd).toBe(true);expect(latest.tail).toEqual(latest.allTail);
});

test('v67 separate latest quote point replaces only the overlay on same history and preserves the historical viewport',async({page,panelServer})=>{
 panelServer.state.startedAt=Date.now()-60000;
 await page.clock.install();await openPanel(page,panelServer,['QQQ']);
 const before=await snapshot(page),t=before.tail.t+25,date=new Date(t*1000).toISOString().slice(0,10);
 panelServer.state.quotePatch={price:before.tail.c+2,quoteAt:t*1000,marketState:'REGULAR',intradayLiveStatus:'ready',
  intradayLivePoint:{t,c:before.tail.c+2,v:null,currency:'USD',source:'fixture',sessionDate:date,historyDate:date}};
 await page.evaluate(()=>window.__hooks.refresh(true));
 const first=await snapshot(page);
 expect(first.tail.c).toBe(before.tail.c+2);expect(first.tail.v).toBeNull();expect(first.revision).toBe(before.revision);
 expect(first.allTail).toEqual(before.allTail);expect(first.count).toBe(before.count+1);
 await expect(cardFor(page).locator('.ohlcbar')).toContainText('最新报价点');
 await expect(cardFor(page).locator('.ohlcbar')).toContainText('fixture');
 await expect(cardFor(page).locator('.ohlcbar')).toContainText('历史分时截至');
 await expect(cardFor(page).locator('.ohlcbar')).toContainText('无成交量数据');
 await page.setViewportSize({width:320,height:900});
 await test.info().attach('latest-quote-point-320px',{body:await page.screenshot(),contentType:'image/png'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 panelServer.state.quotePatch.price+=1;panelServer.state.quotePatch.intradayLivePoint.c+=1;
 await page.evaluate(()=>window.__hooks.refresh(true));
 const replaced=await snapshot(page);expect(replaced.count).toBe(first.count);expect(replaced.tail.c).toBe(first.tail.c+1);expect(replaced.canvas).not.toBe(first.canvas);
 const slider=cardFor(page).locator('.xslide');
 await slider.evaluate(node=>{node.value='0';node.dispatchEvent(new Event('input',{bubbles:true}));});
 const history=await snapshot(page);
 panelServer.state.quotePatch.price+=1;panelServer.state.quotePatch.intradayLivePoint.c+=1;
 await page.evaluate(()=>window.__hooks.refresh(true));
 const retained=await snapshot(page);expect(retained.followEnd).toBe(false);expect(retained.start).toBe(0);expect(retained.tail).toEqual(history.tail);
 await cardFor(page).locator('[data-tf="daily30"]').click();
 await expect(cardFor(page).locator('.ohlcbar')).not.toContainText('最新报价点');
 await cardFor(page).locator('[data-tf="intraday"]').click();
 await cardFor(page).getByRole('button',{name:'跟随最新',exact:true}).click();
 await expect(cardFor(page).locator('.ohlcbar')).toContainText('最新报价点');
 panelServer.state.quotePatch.intradayLivePoint.currency='GBp';
 await page.evaluate(()=>window.__hooks.refresh(true));
 const rejected=await snapshot(page);expect(rejected.count).toBe(before.count);expect(rejected.tail).toEqual(before.tail);
 await expect(cardFor(page).locator('.ohlcbar')).not.toContainText('最新报价点');
});
