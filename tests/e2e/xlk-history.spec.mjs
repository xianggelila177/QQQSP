import {test as base,expect} from '@playwright/test';
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {nasdaqXlkResponse} from '../v2/xlk-fixture.mjs';

const at=Date.parse('2026-09-13T15:20:00Z');
const test=base.extend({xlkServer:async({},use)=>{
 const requests=[];
 const app=createApplication({now:()=>at,env:{PORT:0,SYMBOLS:'XLK',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:''},telemetry:createTelemetry(),
  upstream:async raw=>{const url=new URL(raw);requests.push(raw);if(url.hostname==='api.nasdaq.com')return nasdaqXlkResponse(raw);if(url.hostname.endsWith('yahoo.com'))return {status:429,headers:{'retry-after':'60'},body:'{}'};if(url.hostname==='zhibo.sina.com.cn')return {status:200,body:'{}'};if(url.hostname==='news.google.com')return {status:200,body:'<rss><channel/></rss>'};throw Error('unexpected fixture upstream '+url.hostname);},
  providerOverrides:{fetchSnapshotBatch:async symbols=>({quotes:symbols.map(symbol=>({symbol,displayName:'XLK 测试样本',price:187.66,regularPrice:187.67,quoteAt:Date.parse('2026-09-12T00:00:00Z'),sourceCheckedAt:at,src:'fixture',currency:'USD',instrumentType:'ETF',marketState:'CLOSED',priceSession:'POST',pollAfterMs:70000})),pollAfterMs:70000})}});
 app.start();await once(app.httpServer,'listening');try{await use({app,requests,url:'http://127.0.0.1:'+app.httpServer.address().port});}finally{await app.stop();}
}});
test('XLK fallback draws genuine source intraday and all four candle periods as an ETF',async({page,xlkServer},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('qqq-watchlist','["XLK"]');window.__PANEL_TEST_HOOK__=h=>window.__hooks=h;});
 await page.goto(xlkServer.url);const card=page.locator('.price-card[data-sym="XLK"]');
 await expect(card.locator('.cur')).toHaveText('187.66');await expect(card.locator('.chart-state')).toContainText('Nasdaq 分时');
 await expect(card.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
 await expect(card.locator('.chart-summary')).toContainText('2 个数据点');
 for(const [key,label] of [['daily30','日K'],['weekly','周K'],['monthly','月K'],['yearly','年K']]){
  await card.locator('[data-tf="'+key+'"]').click();
  await expect(card.locator('.chart-summary')).toContainText(new RegExp('XLK '+label+'，\\d+ 个数据点'));
  await expect(card.locator('.chart-state')).toContainText('Nasdaq 历史');
  expect(await page.evaluate(()=>window.__hooks.cardCache.get('XLK').plot.candle)).toBe(true);
 }
 const nasdaq=xlkServer.requests.filter(url=>new URL(url).hostname==='api.nasdaq.com');expect(nasdaq.length).toBeGreaterThanOrEqual(2);expect(nasdaq.every(url=>new URL(url).searchParams.get('assetclass')==='etf')).toBe(true);
 await info.attach('xlk-adapter-requests',{body:JSON.stringify(nasdaq,null,2),contentType:'application/json'});
 await page.screenshot({path:info.outputPath('xlk-yearly-test.png'),fullPage:true});expect(errors).toEqual([]);
});
