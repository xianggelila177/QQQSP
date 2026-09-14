// Failure logs belong to the service boundary that retains the source error.
import assert from 'node:assert/strict';
const log={debug(){},info(){},warn(){},error(){}};
import {createNewsService} from '../lib/news.js';
import {createMacroService} from '../lib/macro.js';
import {createQuoteService} from '../lib/quote.js';
import {createYahooService} from '../lib/yahoo.js';
import {createTencentProvider} from '../lib/providers/tx.js';
import {createNasdaqProvider} from '../lib/providers/nasdaq.js';
import {createSinaProvider} from '../lib/providers/sina.js';
const oldDebug=log.debug,events=[];
log.debug=(message,meta)=>events.push({message,meta});
const offline=async()=>{throw new Error('fixture offline');};
try {
  const yahoo=createYahooService({log,getCrumb:offline,getSinaDaily:offline});
  await yahoo.getDayOhlc('QQQ','2026-8-4');await yahoo.getYahooDaily('QQQ');
  const tx=createTencentProvider({log,httpsGet:offline});await tx.txDailyBarsCn('000001.SS');await tx.txMinuteBarsCn('000001.SS');
  await createNasdaqProvider({log,httpsGet:offline}).getNasdaqDaily('QQQ');
  await createSinaProvider({log,httpsGet:offline}).getSinaDaily('000001.SS');
  for(const name of ['day ohlc fail','yahoo daily fail','tx daily fail','tx minute fail','ndq get fail','sina daily fail'])assert.ok(events.some(x=>x.message.includes(name)),name);
  const news=createNewsService({log,newsLoader:offline});const response=await news.requestNews('QQQ');
  assert.equal(response.stale,true);assert.equal(response.error,'fixture offline');
  assert.ok(events.some(x=>x.message==='[news refresh fail]'&&x.meta.sym==='QQQ'));
  const macro=await createMacroService({log,googleNewsTopic:offline,yahooNews:offline,httpsGet:offline}).getMacro();
  assert.equal(macro.stale,true);assert.ok(events.some(x=>x.message==='[macro source fail]'&&x.meta.source==='sina:flash'));
  const quote=createQuoteService({log,extSessions:()=>({}),providers:{fetchChart:async()=>({meta:{symbol:'QQQ',regularMarketPrice:100},timestamp:[]}),getDayOhlc:async()=>({prevClose:99}),getFxRates:async()=>({}),getNasdaqDaily:async()=>[],getYahooDaily:async()=>[]}});
  await quote.fetchQuote('QQQ');
  for(const name of ['[quote in]','[quote out]'])assert.ok(events.some(x=>x.message===name&&x.meta.symbol==='QQQ'));
  console.log('PASS provider/service failures retain source context, freshness and useful logs');
}finally{log.debug=oldDebug;}
