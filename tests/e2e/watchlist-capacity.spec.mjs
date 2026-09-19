import {test as base,expect} from '@playwright/test';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
const symbols=Array.from({length:100},(_,i)=>'TST'+String(i+1).padStart(3,'0'));
const now=Date.parse('2026-09-18T14:00:00Z');
const bars=Array.from({length:390},(_,i)=>({t:now/1000-(389-i)*60,o:100,h:102,l:99,c:101,v:1000}));
const test=base.extend({capacityServer:async({},use)=>{
 const app=createApplication({now:()=>now,env:{PORT:0,LOG_FILE:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',FUNDAMENTALS_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:''},telemetry:createTelemetry(),
 upstream:async url=>{if(url.includes('news.google.com'))return {status:200,body:'<rss><channel/></rss>'};throw Error('Unexpected fixture upstream');},
 providerOverrides:{fetchQuote:async symbol=>({symbol,displayName:symbol,price:101,quoteAt:now,sourceCheckedAt:now,src:'fixture',currency:'USD',instrumentType:'EQUITY',priceSession:'REGULAR',marketState:'REGULAR',calendarCoverage:{known:true},charts:{intraday:bars,daily30:bars}}),
 fetchChart:async symbol=>({source:'fixture',meta:{symbol,currency:'USD',instrumentType:'EQUITY',exchangeTimezoneName:'America/New_York',dataGranularity:'1d'},timestamp:[Date.parse('2026-09-17T13:30:00Z')/1000],indicators:{quote:[{open:[100],high:[102],low:[99],close:[101],volume:[1000]}]}})}});
 app.start();await once(app.httpServer,'listening');try{await use({app,url:'http://127.0.0.1:'+app.httpServer.address().port});}finally{await app.stop();}
}});
test('100 saved cards receive native SSE, survive reload and enforce an explicit 101st limit',async({page,capacityServer},info)=>{
 const errors=[],failures=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)failures.push([r.status(),r.url()]);});
 await page.addInitScript(list=>{if(!localStorage.getItem('capacity-seeded')){localStorage.setItem('qqq-watchlist',JSON.stringify(list));localStorage.setItem('capacity-seeded','1');}window.__PANEL_TEST_HOOK__=h=>window.__hooks=h;},symbols);
 await page.goto(capacityServer.url);await expect(page.locator('.price-card')).toHaveCount(100);
 await expect.poll(()=>page.evaluate(()=>[...window.__hooks.cardCache.values()].filter(q=>q.d?.price===101).length),{timeout:20000}).toBe(100);
 const last=page.locator('.price-card[data-sym="TST100"]');await last.scrollIntoViewIfNeeded();await expect(last.locator('.cur')).toHaveText('101.00');
 await page.locator('#marketDirectory summary').click();await page.locator('.directory-featured button[data-symbol="^FTSE"]').click();
 await expect(page.locator('#marketDirectoryStatus')).toContainText('100');await expect(page.locator('.price-card')).toHaveCount(100);
 await page.reload();await expect(page.locator('.price-card')).toHaveCount(100);await last.scrollIntoViewIfNeeded();await expect(last.locator('.cur')).toHaveText('101.00');
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('qqq-watchlist')))).toEqual(symbols);
 // A normal removal/addition saves all 100 entries to the real server endpoint.
 await page.locator('.price-card[data-sym="TST001"] .cardclose').click();
 await page.locator('#marketDirectory summary').click();await page.locator('.directory-featured button[data-symbol="^FTSE"]').click();
 await expect(page.locator('.price-card')).toHaveCount(100);
 await expect.poll(()=>capacityServer.app.services.historyPrewarm.status().persistentWatchlist.length).toBe(100);
 await expect.poll(()=>capacityServer.app.services.samples.diagnostics().watchlist.length).toBe(100);
 await page.locator('.price-card[data-sym="^FTSE"]').scrollIntoViewIfNeeded();
 await expect(page.locator('.price-card[data-sym="^FTSE"] .cur')).not.toHaveText('—');
 await info.attach('capacity-server',{body:JSON.stringify({saved:capacityServer.app.services.historyPrewarm.status().persistentWatchlist.length,background:capacityServer.app.services.samples.diagnostics().watchlist.length,sse:capacityServer.app.services.http.sse?.diagnostics?.()},null,2),contentType:'application/json'});
 await page.screenshot({path:info.outputPath('100th-card.png')});expect(errors).toEqual([]);expect(failures).toEqual([]);
});
