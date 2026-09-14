import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {createRealtimeQuoteService} from '../../lib/realtime-quote-service.js';
import {createNewsService} from '../../lib/news.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('remove watchlist evicts all snapshot state, not only membership',async()=>{
 let calls=0;const s=createSnapshotService({now:()=>1789041600000,fetchBatch:async symbols=>({quotes:symbols.map(symbol=>({symbol,price:100,quoteAt:1789041600000,currency:'USD',marketState:'REGULAR'}))}),enrich:async symbol=>{calls++;return {symbol,price:100,quoteAt:1789041600000,currency:'USD'};}});
 s.start();s.getCachedQuote('QQQ');await wait(180);assert.equal(s.diagnostics().snapshots,1);s.retain([]);assert.equal(s.diagnostics().snapshots,0);assert.equal(s.diagnostics().active,0);s.stop();assert.ok(calls);
});
test('stream enrichment retries a pending snapshot in one second rather than one minute',async()=>{
 let now=10000,n=0;const provider={supports:()=>true,touch:()=>true,read:()=>({state:'connecting'}),start(){},stop(){},diagnostics:()=>({})};
 const service=createRealtimeQuoteService({provider,now:()=>now,fallback:async symbol=>++n===1?{symbol,pending:true}:{symbol,price:100,quoteAt:now,currency:'USD'}});
 assert.equal((await service.getCachedQuote('QQQ')).pending,true);now+=1001;assert.equal((await service.getCachedQuote('QQQ')).price,100);assert.equal(n,2);service.stop();
});
test('news has no autonomous poller and changing watchlist cannot exhaust client slots',async()=>{
 let calls=0;const news=createNewsService({newsLoader:async()=>{calls++;return []},maxActive:2});news.startNews();
 await news.requestNews('A');await news.requestNews('B');await news.requestNews('C');assert.equal(calls,3);assert.equal(news.activeSyms.size,2);news.stopNews();news.startNews();await news.requestNews('D');assert.equal(calls,4);news.stopNews();
});
