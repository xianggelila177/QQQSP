import {test as base,expect} from '@playwright/test';
import {createNikkeiApp} from '../support/nikkei-app.mjs';
import {nikkeiSnapshot} from '../v2/nikkei-fixture.mjs';
const test=base.extend({nikkei:async({},use)=>{const f=await createNikkeiApp();try{await use(f);}finally{await f.close();}}});
test('Nikkei index renders points, genuine source history and native SSE recovery',async({page,nikkei},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('qqq-watchlist','["^N225"]');window.__PANEL_TEST_HOOK__=h=>window.__hooks=h;});
  await page.goto(nikkei.url);const card=page.locator('.price-card[data-sym="^N225"]');
  await expect(card.locator('.cur')).toHaveText('64,136.25');await expect(card.locator('.unit')).toHaveText('点');await expect(card.locator('.ccyseg')).toBeHidden();
  await expect(card.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
  await expect(card.locator('.chart-state')).toContainText('Naver 指数历史');
  await expect(card).toContainText('源延迟 15 分钟');await expect(card).toContainText('时间为来源发布时刻');
  await expect.poll(()=>page.evaluate(()=>window.__hooks.cardCache.get('^N225').plot.bars.length)).toBeGreaterThan(0);
  for(const [key,label] of [['daily30','日K'],['weekly','周K'],['monthly','月K'],['yearly','年K']]){
    await card.locator('[data-tf="'+key+'"]').click();
    await expect(card.locator('.chart-summary')).toContainText(new RegExp('\\^N225 '+label+'，\\d+ 个数据点'));
    await expect(card.locator('.chart-state')).toContainText('Naver 指数历史');
  }
  const before=await page.evaluate(()=>window.__hooks.cardCache.get('^N225').d.sourceCheckedAt);
  nikkei.state.now+=71000;nikkei.state.snapshot=nikkeiSnapshot({price:'64,137.25',at:'2026-09-17T15:46:03+09:00'});
  await expect(card.locator('.cur')).toHaveText('64,137.25');
  expect(await page.evaluate(()=>window.__hooks.cardCache.get('^N225').d.sourceCheckedAt)).toBeGreaterThan(before);
  expect(nikkei.quoteCalls()).toBe(2);
  await page.reload();await expect(card.locator('.cur')).toHaveText('64,137.25');
  await expect(card.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
  expect(nikkei.quoteCalls()).toBe(2);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath('nikkei-history.png'),fullPage:true});
});
