import {test as base,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';

const test=base.extend({page:async({page,browserName},use)=>{
  if(browserName==='chromium')await page.coverage.startJSCoverage({resetOnNavigation:false});
  try{await use(page);}finally{if(browserName==='chromium'&&!page.isClosed()){
    const coverage=await page.coverage.stopJSCoverage();if(process.env.QQQSP_COVERAGE_DIR){const directory=path.resolve(process.env.QQQSP_COVERAGE_DIR,'../browser');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,randomUUID()+'.json'),JSON.stringify(coverage));}
  }}
},sampleServer:async({},use)=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'samples-browser-'));
  const state={clock:Date.parse('2026-09-09T14:00:00Z'),empty:false,offline:false};
  const quote=symbol=>({symbol,displayName:'测试样本 NVDA',currency:'USD',src:'fixture',instrumentType:'EQUITY',marketState:'REGULAR',priceSession:'REGULAR',gmtoff:-14400,
    price:218.26,quoteAt:state.clock,sourceCheckedAt:state.clock,charts:{intraday:state.empty?[]:[{t:state.clock/1000-60,c:218},{t:state.clock/1000,c:218.26}]},
    slowFields:{intraday:{source:'fixture',updatedAt:state.clock,stale:false}}});
  const app=createApplication({now:()=>state.clock,env:{PORT:0,MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',RECOVERY_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0',CACHE_MS:1,SAMPLES_BACKGROUND_ENABLED:'1',SAMPLES_STATE_PATH:path.join(directory,'samples')},
    telemetry:createTelemetry(),upstream:async url=>({status:200,headers:{},body:url.includes('sina')?'{}':'<rss><channel/></rss>'}),
    providerOverrides:{fetchQuote:async symbol=>{if(state.offline)throw Error('fixture unavailable');return quote(symbol);},fetchChart:async symbol=>({meta:{symbol,currency:'USD',dataGranularity:'1d'},timestamp:[state.clock/1000-86400],indicators:{quote:[{open:[217],high:[220],low:[216],close:[218],volume:[100]}]}})}});
  app.services.historyPrewarm.retain(['NVDA']);app.start();await once(app.httpServer,'listening');
  const server={app,state,url:'http://127.0.0.1:'+app.httpServer.address().port,async advance(value){state.clock=Date.parse(value);app.services.quote.cacheMap.clear();app.services.engine.poke('NVDA');await expect.poll(()=>app.services.engine.read(['NVDA'],{lease:false})[0]?.quoteAt).toBe(state.clock);app.services.samples.runDue();}};
  try{
    await expect.poll(()=>app.services.samples.diagnostics().initialized).toBe(true);
    await server.advance('2026-09-09T14:00:00Z');await server.advance('2026-09-10T14:00:00Z');
    await server.advance('2026-09-11T14:00:00Z');await server.advance('2026-09-11T14:00:20Z');await server.advance('2026-09-11T14:02:00Z');
    await use(server);
  }finally{await app.stop();await fs.rm(directory,{recursive:true,force:true});}
}});
async function open(page,server){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('qqq-watchlist','["NVDA"]');window.__PANEL_TEST_HOOK__=value=>window.__hooks=value;});
  await page.clock.install({time:new Date(server.state.clock)});await page.goto(server.url);
  await expect(page.locator('.price-card .cur')).not.toHaveText('—');return errors;
}
test('history remains default; server shows three sampled trading days with explicit gaps',async({page,sampleServer},info)=>{
  const errors=await open(page,sampleServer),card=page.locator('.price-card');
  await expect(card.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
  expect(sampleServer.app.services.samples.snapshot('NVDA').coveredDays).toBe(3);
  await card.locator('[data-chart-mode="samples"]').click();
  await expect(card.locator('.chart-state')).toContainText('服务器报价采样');
  await expect(card.locator('.ohlcbar')).toContainText('已覆盖 3/3');
  const plotted=await page.evaluate(()=>{const q=window.__hooks.cardCache.get('NVDA');return {count:q.plot.all.length,days:[...new Set(q.plot.all.map(p=>p.tradingDate))],gaps:q.plot.all.map((p,i,a)=>window.PANEL_CHART_ENGINE.sampleGap(a[i-1],p))};});
  expect(plotted.count).toBe(4);expect(plotted.days).toEqual(['2026-09-09','2026-09-10','2026-09-11']);expect(plotted.gaps).toEqual([true,true,true,true]);
  await page.screenshot({path:info.outputPath('three-trading-day-samples.png'),fullPage:true});
  await page.reload();await expect(page.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');expect(errors).toEqual([]);
});
test('closing all pages does not stop sampling; reopening reads the persisted server series',async({page,context,sampleServer})=>{
  await open(page,sampleServer);await page.close();await sampleServer.advance('2026-09-11T14:03:00Z');
  expect(sampleServer.app.services.samples.snapshot('NVDA').points.length).toBe(5);
  const next=await context.newPage();await open(next,sampleServer);await next.locator('[data-chart-mode="samples"]').click();
  await expect(next.locator('.chart-summary')).toContainText('5 个数据点');
});
test('empty history does not switch modes; failed sample fetch retains records and supports retry',async({page,sampleServer})=>{
  sampleServer.state.empty=true;await sampleServer.advance('2026-09-11T14:04:00Z');
  const errors=await open(page,sampleServer);await expect(page.locator('[data-chart-mode="history"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.ohlcbar')).toContainText('历史来源暂不可用');
  await page.locator('[data-chart-mode="samples"]').click();await expect(page.locator('.chart-summary')).toContainText('5 个数据点');
  const read=sampleServer.app.services.samples.snapshot;sampleServer.app.services.samples.snapshot=()=>{throw Error('fixture sample endpoint unavailable');};
  await page.locator('[data-chart-mode="history"]').click();await page.locator('[data-chart-mode="samples"]').click();
  await expect(page.locator('.chart-retry')).toBeVisible();await expect(page.locator('.ohlcbar')).toContainText('保留已有记录');
  sampleServer.app.services.samples.snapshot=read;await page.locator('.chart-retry').click();await expect(page.locator('.chart-retry')).toBeHidden();expect(errors).toEqual([]);
});
test('a selected hidden card resynchronizes after the shared stream reconnects',async({page,context,sampleServer})=>{
  const errors=await open(page,sampleServer);await page.locator('[data-chart-mode="samples"]').click();await expect(page.locator('.chart-summary')).toContainText('4 个数据点');
  await page.evaluate(()=>document.querySelector('.price-card').style.display='none');
  await context.setOffline(true);await sampleServer.advance('2026-09-11T14:03:00Z');await context.setOffline(false);
  await expect.poll(()=>page.evaluate(()=>window.__hooks.cardCache.get('NVDA').sampleStore.snapshot().points.length),{timeout:20000}).toBe(5);
  await page.evaluate(()=>document.querySelector('.price-card').style.display='');await expect(page.locator('.chart-summary')).toContainText('5 个数据点');expect(errors).toEqual([]);
});
