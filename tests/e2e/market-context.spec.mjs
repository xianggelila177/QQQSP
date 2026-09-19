import {test,expect} from '@playwright/test';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
const key='test'.repeat(10);
test('LLM query and public API docs coexist with live page updates without exposing credentials or saving a symbol',async({page},info)=>{
 const clock=Date.parse('2026-09-18T14:00:00Z');let price=100,historyStarted=false;
 const bars=[{t:clock/1000-60,c:100,v:null}];
 const app=createApplication({now:()=>clock,env:{PORT:0,LOG_FILE:'',LLM_API_KEY:key,CACHE_MS:1,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',FUNDAMENTALS_ENABLED:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:''},telemetry:createTelemetry(),upstream:async()=>{throw Error('unstubbed IO');},providerOverrides:{fetchQuote:async symbol=>({symbol,price,quoteAt:clock+price-100,sourceCheckedAt:clock,src:'fixture',currency:'USD',instrumentType:'EQUITY',marketState:'REGULAR',charts:{intraday:bars,daily30:[]}}),fetchChart:async(_symbol,_query,{signal})=>{historyStarted=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
 app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 try{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('qqq-watchlist','["QQQ"]');});
  await page.goto(origin);const card=page.locator('.price-card[data-sym="QQQ"]');await expect(card.locator('.cur')).toHaveText('100.00');
  const waiting=fetch(origin+'/api/v1/market-context',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({symbol:'NVDA',include:['quote','daily'],max_wait_ms:1500})}).then(async r=>({status:r.status,body:await r.json()}));
  await expect.poll(()=>historyStarted).toBe(true);price=101;app.services.quote.cacheMap.clear();app.services.engine.poke('QQQ');await expect(card.locator('.cur')).toHaveText('101.00');
  const result=await waiting;expect(result.status).toBe(200);expect(result.body.status).toBe('partial');expect(result.body.sections.quote.data.price).toBeGreaterThan(0);
  expect(app.services.historyPrewarm.status().persistentWatchlist).toEqual([]);expect(app.services.samples.diagnostics().watchlist).toEqual([]);expect(app.services.engine.diagnostics().active).toEqual(['QQQ']);
  const spec=await fetch(origin+'/api/v1/openapi.json').then(r=>r.json());expect(spec.paths['/api/v1/market-context'].post.operationId).toBe('queryMarketContext');
  expect(await fetch(origin+'/llms.txt').then(r=>r.text())).not.toContain(key);expect(await fetch(origin+'/panel.bundle.js').then(r=>r.text())).not.toContain(key);expect(errors).toEqual([]);
  await info.attach('llm-and-page',{body:JSON.stringify({httpStatus:result.status,contextStatus:result.body.status,visiblePrice:await card.locator('.cur').innerText(),watchlistUnchanged:true}),contentType:'application/json'});
 }finally{
  await page.close();
  // Chromium may preconnect an unused TCP socket. It belongs to this fixture,
  // and must not hold server.close() open until the HTTP header timeout.
  app.httpServer.closeAllConnections();await app.stop();
 }
});
