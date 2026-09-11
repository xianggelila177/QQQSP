import assert from 'node:assert/strict';
import {mergeAlpacaQuote,createRealtimeQuoteService} from '../lib/realtime-quote-service.js';
let at=Date.parse('2026-09-09T15:00:00Z');
const bar=(t,c)=>({t,o:c,h:c+1,l:c-1,c,v:100});
const data={source:'alpaca-iex',coverage:'single-exchange',state:'streaming',snapshotCheckedAt:at,
 trade:{symbol:'QQQ',price:110,quoteAt:at,receivedAt:at,exchange:'V',sourceTimestamp:new Date(at).toISOString(),conditions:['@']},
 snapshot:{dailyBar:bar('2026-09-09T04:00:00Z',109),prevDailyBar:bar('2026-09-08T04:00:00Z',100)}};
const base={symbol:'QQQ',price:108,quoteAt:at-1000,src:'yahoo',currency:'USD',instrumentType:'ETF',prevClose:999,change:123,ext:{post:{price:777}},stale:true,staleInfo:{reason:'old'},charts:{intraday:[{t:(at-60000)/1000,c:108,v:5}]}};
const merged=mergeAlpacaQuote(base,data,at);assert.equal(merged.price,110);assert.equal(merged.prevClose,100);assert.equal(merged.change,10);assert.equal(merged.changePct,10);assert.equal(merged.ext,null);assert.equal(merged.staleInfo,undefined);assert.equal(merged.priceBasis,'reported-trade');assert.equal(merged.historySource,'yahoo');
assert.equal(mergeAlpacaQuote({...base,quoteAt:at+1},data,at).price,108,'no cross-source time regression');
const nextDay={...data,trade:{...data.trade,quoteAt:at+86400000}};
const rolled=mergeAlpacaQuote(base,nextDay,at+86400000);assert.equal(rolled.prevClose,null);assert.equal(rolled.change,null);assert.equal(rolled.open,null,'old daily statistics must not become current-day statistics');
let calls=0;let current=null;
const provider={supports:s=>s==='QQQ',touch:()=>true,read:()=>current,start(){},stop(){},diagnostics:()=>({})};
const service=createRealtimeQuoteService({provider,now:()=>at,fallback:async()=>{calls++;return base;}});
service.start();await Promise.all([service.getCachedQuote('QQQ'),service.getCachedQuote('QQQ')]);assert.equal(calls,1);
current=data;const q=await service.getCachedQuote('QQQ');assert.equal(q.src,'alpaca-iex');assert.equal(calls,1);
for(let i=0;i<100;i++)await service.getCachedQuote('QQQ');assert.equal(calls,1,'browser reads do not fan out to slow upstream');
service.stop();await assert.rejects(service.getCachedQuote('QQQ'),e=>e.code==='STOPPED');
console.log('v72 source isolation, daily rollover, cache read fanout and realtime lifecycle passed');
