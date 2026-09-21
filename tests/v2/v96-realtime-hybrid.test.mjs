import test from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeQuoteService,mergeAlpacaQuote} from '../../lib/realtime-quote-service.js';
import {streamAvailability} from '../../lib/stream-policy.js';
import {quoteStatus} from '../../lib/http-diagnostics.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';

const start=Date.parse('2026-09-09T15:00:00Z');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const stream=(symbol,at,extra={})=>({source:'finnhub',coverage:'account coverage unverified',delayMinutes:null,state:'streaming',connectionCheckedAt:at,
  trade:{symbol,price:100,quoteAt:at,receivedAt:at,sourceTimestamp:new Date(at).toISOString()},...extra});
const website=(symbol,at,extra={})=>({symbol,currency:'USD',price:101,quoteAt:at,sourceCheckedAt:at,fetchedAt:at,src:'sina-batch',priceBasis:'website-last-trade',...extra});
const provider=read=>({supports:()=>true,touch:()=>true,read,start(){},stop(){},diagnostics:()=>({})});

test('free streaming does not freeze the shared website cache for five or sixty seconds',async()=>{
 let at=start,calls=0,updates=0;
 const service=createRealtimeQuoteService({provider:provider(s=>stream(s,start,{connectionCheckedAt:at})),now:()=>at,onUpdate:()=>updates++,
  fallback:async symbol=>{calls++;return website(symbol,at,{price:101+calls});}});
 try{
  await service.getCachedQuote('QQQ');await settle();
  for(let i=1;i<=3;i++){
   at=start+i*1000;await service.getCachedQuote('QQQ');await settle();
   const q=await service.getCachedQuote('QQQ');
   assert.equal(calls,i+1,'one shared cache refresh each second');
   assert.equal(q.src,'sina-batch');assert.equal(q.quoteAt,at);assert.equal(q.price,102+i);
   assert.equal(q.realtimeSource,'finnhub');assert.equal(q.connectionCheckedAt,at);assert.equal(q.realtimeConnectionHealthy,true);
   assert.equal(q.tradeReceivedAt,undefined,'receipt time belongs only to the selected stream price');
  }
  assert.equal(updates,4,'fresh fallback completions notify the engine');
 }finally{service.stop();}
});

test('website reads are singleflight, bounded and fair across more than four active symbols',async()=>{
 let at=start,active=0,maxActive=0;const calls=new Map(),symbols=['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH'];
 const service=createRealtimeQuoteService({provider:provider(s=>stream(s,start)),now:()=>at,maxInflight:4,
  fallback:async symbol=>{calls.set(symbol,(calls.get(symbol)||0)+1);maxActive=Math.max(maxActive,++active);await settle();active--;return website(symbol,at);}});
 try{
  await Promise.all(symbols.map(s=>service.getCachedQuote(s)));await settle();await settle();await settle();
  assert.equal(calls.size,8,'a FIFO drains cache reads beyond the first four slots');assert.ok(maxActive<=4);
  await Promise.all(Array.from({length:20},()=>service.getCachedQuote('AAA')));assert.equal(calls.get('AAA'),1);
  at+=1000;await Promise.all(symbols.map(s=>service.getCachedQuote(s)));await settle();await settle();await settle();
  assert.deepEqual([...calls.values()],Array(8).fill(2));assert.ok(maxActive<=4);
 }finally{service.stop();}
});

test('a slow fallback does not block an existing stream tick and cannot fan out',async()=>{
 let calls=0;const job=deferred();const service=createRealtimeQuoteService({provider:provider(s=>stream(s,start)),now:()=>start,
  fallback:()=>{calls++;return job.promise;}});
 try{
  const q=await service.getCachedQuote('QQQ');assert.equal(q.src,'finnhub');
  await Promise.all(Array.from({length:10},()=>service.getCachedQuote('QQQ')));assert.equal(calls,1);
  job.resolve(website('QQQ',start));await settle();
 }finally{job.resolve(null);service.stop();}
});

test('first stream trade reaches the engine while the initial website lookup remains pending',async()=>{
 const websiteJob=deferred();let data=null,engine,completed=false;
 const service=createRealtimeQuoteService({provider:provider(()=>data),now:()=>start,onUpdate:s=>engine?.poke(s),
  fallback:async()=>{await websiteJob.promise;completed=true;return website('QQQ',start);}});
 engine=createQuoteEngine({readQuote:s=>service.getCachedQuote(s),now:()=>start});
 service.start();engine.start();const release=engine.watch(['QQQ']);
 try{
  await settle();await settle();
  assert.equal(completed,false);data=stream('QQQ',start);engine.poke('QQQ');await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(completed,false,'website lookup is still unresolved');
  assert.equal(engine.read(['QQQ'],{lease:false})[0].price,100,'the first stream trade must not queue behind that lookup');
 }finally{release();engine.stop();service.stop();websiteJob.resolve();await settle();}
});

test('healthy heartbeat with no recent trade stays connected without inventing trade checks',()=>{
 const at=start+45000,data=stream('QQQ',start,{connectionCheckedAt:at});
 const state=streamAvailability('QQQ',data,at),q=mergeAlpacaQuote(null,data,at);
 assert.equal(state.connectionHealthy,true);assert.equal(state.noNewTrade,true);assert.equal(state.usable,true);assert.equal(state.needsBackup,true);
 assert.equal(q.quoteAt,start);assert.equal(q.sourceCheckedAt,start);assert.equal(q.tradeReceivedAt,start);
 assert.equal(q.connectionCheckedAt,at);assert.equal(q.realtimeConnectionHealthy,true);assert.equal(q.stale,false);
 assert.equal(quoteStatus(q,at).usable,true);
 assert.equal(quoteStatus({...q,src:'sina-batch'},at).usable,false,'a different price source cannot borrow this heartbeat');
 assert.equal(quoteStatus({...q,sourceCheckedAt:at+5000,fetchedAt:at+5000},at).usable,false);
 const old=stream('QQQ',start-600000,{connectionCheckedAt:at});assert.equal(streamAvailability('QQQ',old,at).connectionHealthy,true);
 assert.equal(streamAvailability('QQQ',old,at).usable,false,'old event remains old even while the socket is healthy');
 const subscribing=streamAvailability('QQQ',stream('QQQ',start,{state:'subscribing',connectionCheckedAt:at}),at);
 assert.equal(subscribing.connectionHealthy,true);assert.equal(subscribing.usable,false,'old trade awaits this connection subscription confirmation');
});

test('REST verification cannot disguise a silent WebSocket',()=>{
 const at=start+120000,data=stream('QQQ',at,{connectionCheckedAt:start,snapshotCheckedAt:at});
 const state=streamAvailability('QQQ',data,at);
 assert.equal(state.connectionHealthy,false);assert.equal(state.usable,false);assert.equal(state.reason,'stream-check-overdue');
});

test('single-exchange and unknown coverage always keep periodic website checks enabled',()=>{
 for(const coverage of ['single-exchange',null,undefined,'account coverage unverified']){
  const state=streamAvailability('QQQ',stream('QQQ',start,{coverage,delayMinutes:0}),start);
  assert.equal(state.usable,true);assert.equal(state.needsBackup,true);
 }
 assert.equal(streamAvailability('QQQ',stream('QQQ',start,{coverage:'us-sip',delayMinutes:0}),start).needsBackup,false);
});

test('switching to an unknown-coverage stream clears website delay and precision metadata',()=>{
 const base=website('QQQ',start-1000,{isDelayed:true,feedDelayMinutes:15,feedDelaySource:'naver-exchange-delay',quoteTimePrecision:'minute',providerUpdatedAt:start-999,
  quoteTimeBasis:'observed',observedAt:start,declaredRealtime:false,recovery:true,stale:true,staleInfo:{reason:'offline-cache'}});
 const q=mergeAlpacaQuote(base,stream('QQQ',start),start);
 assert.equal(q.src,'finnhub');assert.equal(q.feedDelayMinutes,null);assert.equal(q.isDelayed,null);assert.equal(q.feedDelaySource,null);
 assert.equal(q.quoteTimePrecision,'millisecond');assert.equal(q.quoteTimeBasis,'source_time');assert.equal(q.providerUpdatedAt,undefined);
 assert.equal(q.observedAt,undefined);assert.equal(q.declaredRealtime,undefined);assert.equal(q.recovery,undefined);assert.equal(q.staleInfo,undefined);
 assert.equal(q.feedCoverage,'account coverage unverified');
});

test('a newer retained quote stays explicitly retained while book updates keep their own clock',()=>{
 const base=website('QQQ',start,{recovery:true,stale:true,staleInfo:{reason:'offline-cache'}});
 const data=stream('QQQ',start-1000,{connectionCheckedAt:start,orderBook:{symbol:'QQQ',currency:'USD',source:'book-source',asOf:start+1,checkedAt:start+1,
  bid:{price:99,size:2},ask:{price:101,size:3},sizeUnit:'shares',coverage:'single-exchange'}});
 const q=mergeAlpacaQuote(base,data,start+1);
 assert.equal(q.quoteAt,start);assert.equal(q.src,'sina-batch');assert.equal(q.recovery,true);assert.equal(q.staleInfo.reason,'offline-cache');
 assert.equal(q.orderBook.asOf,start+1);assert.equal(q.orderBook.source,'book-source');assert.equal(q.sourceCheckedAt,start);
});

test('stopped and restarted service cannot publish a late fallback from its earlier lifecycle',async()=>{
 const first=deferred();let at=start,calls=0,updates=0;
 const service=createRealtimeQuoteService({provider:provider(s=>stream(s,start,{connectionCheckedAt:at})),now:()=>at,onUpdate:()=>updates++,maxInflight:1,
  fallback:symbol=>++calls===1?first.promise:Promise.resolve(website(symbol,at))});
 await service.getCachedQuote('QQQ');service.stop();service.start();at+=1000;
 await service.getCachedQuote('QQQ');first.resolve(website('QQQ',start,{price:999}));await settle();await settle();
 const q=await service.getCachedQuote('QQQ');assert.equal(q.quoteAt,at);assert.equal(q.price,101);assert.equal(updates,1);service.stop();
});

const dailyWebsite=(at,extra={})=>website('QQQ',at,{regularQuoteAt:at,priceSession:'REGULAR',ohlcSession:'REGULAR',
 open:98,dayHigh:103,dayLow:97,prevClose:95,volume:10000,volumeUnit:'shares',turnoverAmount:1000000,...extra});

test('a Finnhub trade retains verified same-day website statistics under their own source',()=>{
 const base=dailyWebsite(start-1000),q=mergeAlpacaQuote(base,stream('QQQ',start),start);
 assert.equal(q.price,100);assert.equal(q.src,'finnhub');assert.equal(q.prevClose,95);assert.equal(q.change,5);
 assert.equal(q.changePct,5/95*100);assert.equal(q.open,98);assert.equal(q.dayHigh,103);assert.equal(q.dayLow,97);assert.equal(q.volume,10000);
 assert.equal(q.statisticsSource,'sina-batch');assert.equal(q.statisticsAsOf,start-1000);
 assert.equal(q.tradingStats.source,'sina-batch');assert.equal(q.tradingStats.tradeDate,'2026-09-09');assert.equal(q.tradingStats.session,'REGULAR');
 assert.equal(q.previousCloseSource,'sina-batch');assert.equal(q.previousCloseAsOf,start-1000);
 assert.equal(q.sourceCheckedAt,start);assert.equal(q.slowFields.ohlc.source,'sina-batch');
});

test('Monday trades cannot inherit Friday previous-close or unverified website daily statistics',()=>{
 const friday=Date.parse('2026-09-18T19:59:00Z'),monday=Date.parse('2026-09-21T14:00:00Z');
 const old=dailyWebsite(friday,{tradingStats:{session:'REGULAR',source:'sina-batch',currency:'USD',asOf:friday,tradeDate:'2026-09-18',open:98,high:103,low:97,prevClose:95,volume:10000,volumeUnit:'shares'}});
 const q=mergeAlpacaQuote(old,stream('QQQ',monday),monday);
 for(const field of ['prevClose','change','changePct','open','dayHigh','dayLow','volume','turnoverAmount'])assert.equal(q[field],null,field);
 assert.equal(q.tradingStats,null);assert.equal(q.statisticsSource,null);assert.equal(q.previousCloseSource,null);
 for(const patch of [{currency:'JPY'},{ohlcSession:null},{regularQuoteAt:null,quoteAt:Date.parse('2026-09-21T12:00:00Z')},{recovery:true}]){
  const unknown=mergeAlpacaQuote(dailyWebsite(monday-1000,patch),stream('QQQ',monday),monday);
  assert.equal(unknown.prevClose,null);assert.equal(unknown.open,null);
 }
});

test('verified same-stream daily snapshot takes priority over supplemental website statistics',()=>{
 const base=dailyWebsite(start-1000,{tradingStats:{session:'REGULAR',source:'sina-batch',currency:'USD',asOf:start-1000,open:98,high:103,low:97,prevClose:95,volume:10000,volumeUnit:'shares'}});
 const data=stream('QQQ',start,{source:'alpaca-iex',coverage:'single-exchange',delayMinutes:0,snapshotCheckedAt:start,
  snapshot:{dailyBar:{t:'2026-09-09T04:00:00Z',o:99,h:104,l:96,c:100,v:3000},prevDailyBar:{t:'2026-09-08T04:00:00Z',o:90,h:99,l:88,c:94,v:2000}}});
 const q=mergeAlpacaQuote(base,data,start);
 assert.equal(q.prevClose,94);assert.equal(q.change,6);assert.equal(q.open,99);assert.equal(q.volume,3000);
 assert.equal(q.statisticsSource,'alpaca-iex');assert.equal(q.statisticsAsOf,start);assert.equal(q.previousCloseSource,'alpaca-iex');
 assert.equal(q.tradingStats,null,'previous website stats must not override this snapshot downstream');assert.equal(q.turnoverAmount,null);
});
