import {test as base,expect} from '@playwright/test';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
import {semiNow,semiUpstream,soxExchange,json} from '../v2/semiconductor-fixture.mjs';
const test=base.extend({semiServer:async({},use)=>{
 const state={clock:semiNow,requests:[]};
 const app=createApplication({now:()=>state.clock,env:{PORT:0,LOG_FILE:'',FUNDAMENTALS_ENABLED:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:''},telemetry:createTelemetry(),
  upstream:async url=>{
   state.requests.push(url);const u=new URL(url);
   if(u.hostname==='polling.finance.naver.com'&&u.pathname.includes('/stock/SOXX.O'))return json({pollingInterval:7000,datas:[{reutersCode:'SOXX.O',symbolCode:'SOXX',stockName:'iShares Semiconductor ETF',stockExchangeType:soxExchange,currencyType:{code:'USD'},closePrice:'525.12',compareToPreviousClosePrice:'6.02',compareToPreviousPrice:{name:'RISING'},localTradedAt:'2026-09-18T10:15:33-04:00',marketStatus:'OPEN'}]});
   if(u.hostname.endsWith('yahoo.com'))return {status:429,headers:{'retry-after':'120'},body:'{}'};
   if(u.hostname==='hq.sinajs.cn'||u.hostname==='qt.gtimg.cn')return {status:200,body:''};
   if(u.hostname==='news.google.com')return {status:200,body:'<rss><channel/></rss>'};
   if(u.hostname==='zhibo.sina.com.cn')return json({});
   return semiUpstream(url);
  }});
 app.start();await once(app.httpServer,'listening');try{await use({app,state,url:'http://127.0.0.1:'+app.httpServer.address().port});}finally{await app.stop();}
}});
test('SOX and SOXX recover real-source charts after Yahoo429 with correct points/ETF units',async({page,semiServer},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('qqq-watchlist','["^SOX","SOXX"]');window.__PANEL_TEST_HOOK__=h=>window.__hooks=h;});
 await page.goto(semiServer.url);
 const index=page.locator('.price-card[data-sym="^SOX"]'),etf=page.locator('.price-card[data-sym="SOXX"]');
 await expect(index.locator('.cur')).toHaveText('11,752.61');await expect(index.locator('.unit')).toHaveText('点');await expect(index.locator('.ccyseg')).toBeHidden();
 await expect(etf.locator('.cur')).toHaveText('525.12');await expect(etf.locator('.unit')).toHaveText('USD');
 for(const [card,symbol,source] of [[index,'^SOX','Naver 指数历史'],[etf,'SOXX','Nasdaq']]){
  await expect(card.locator('.chart-summary')).toContainText('3 个数据点');
  expect(await page.evaluate(s=>window.__hooks.cardCache.get(s).d.charts.intraday.length,symbol)).toBe(2);
  await expect(card.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
  for(const [key,label] of [['daily30','日K'],['weekly','周K'],['monthly','月K'],['yearly','年K']]){
   await card.locator('[data-tf="'+key+'"]').click();
   await expect(card.locator('.chart-summary')).toContainText(new RegExp(symbol.replace('^','\\^')+' '+label+'，\\d+ 个数据点'));
   await expect(card.locator('.chart-state')).toContainText(source);
  }
 }
 expect(semiServer.state.requests.filter(u=>u.includes('api.nasdaq.com/api/quote/SOXX')).every(u=>new URL(u).searchParams.get('assetclass')==='etf')).toBe(true);
 await page.reload();await expect(index.locator('.cur')).toHaveText('11,752.61');await expect(etf.locator('.cur')).toHaveText('525.12');
 await page.screenshot({path:info.outputPath('semiconductor.png'),fullPage:true});expect(errors).toEqual([]);
});
