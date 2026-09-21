process.env.PANEL_TEST_AUTOSTART='0';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {createBatchProvider} from '../lib/providers/batch-snapshot.js';
const {parseTencentBatch,parseNaverQuote}=createBatchProvider();
import { createSnapshotService } from '../lib/snapshot-service.js';
import { marketCalendarInfo, marketStateFor } from '../mkt.mjs';

const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const cnFields = Array(90).fill('');
Object.assign(cnFields, {1:'上证指数',2:'000001',3:'3876.53',4:'3813.58',5:'3817.67',6:'439996278',30:'20260904161432',31:'62.95',32:'1.65',33:'3895.86',34:'3792.48',35:'',48:'-1.00',49:'0.00'});
test('01 Tencent CN uses its own schema, never interprets US 52-week offsets', () => {
  const q = parseTencentBatch('v_sh000001="'+cnFields.join('~')+'";', ['000001.SS'])[0];
  assert.equal(q.price,3876.53); assert.equal(q.dayHigh,3895.86);
  assert.equal(q.week52High,null); assert.equal(q.week52Low,null);
});
test('05 unknown market never claims a verified US calendar or session', () => {
  assert.equal(marketCalendarInfo('UNKNOWN.XX', Date.parse('2026-09-04T14:00:00Z')).known,false);
  assert.equal(marketStateFor('UNKNOWN.XX',0,Date.parse('2026-09-04T14:00:00Z')),'UNKNOWN');
});
test('28 Naver AMEX and upstream ETF types have canonical identity', () => {
  const row={symbolCode:'XLK',stockName:'Technology Select Sector SPDR Fund',stockType:'ETF',stockExchangeType:{code:'AMX',nameEng:'American Stock Exchange',nationType:'USA'},closePrice:'100',compareToPreviousClosePrice:'1',localTradedAt:'2026-09-04T16:00:00-04:00',currencyType:{code:'USD'}};
  const q=parseNaverQuote(row,'XLK',70000); assert.equal(q.market,'美股'); assert.equal(q.instrumentType,'ETF');
});
test('03 valid slow range has provenance while price/time/session stay fast', async () => {
  const service=createSnapshotService({fetchBatch:async syms=>({quotes:syms.map(symbol=>({symbol,price:200,quoteAt:2000,priceSession:'POST',week52High:null,week52Low:null}))}),enrich:async symbol=>({symbol,price:100,quoteAt:1000,src:'yahoo',fetchedAt:1234,week52High:250,week52Low:80})});
  try {service.start();service.getCachedQuote('QQQ');await new Promise(r=>setTimeout(r,130));const q=service.getCachedQuote('QQQ');assert.equal(q.price,200);assert.equal(q.quoteAt,2000);assert.equal(q.priceSession,'POST');assert.equal(q.week52High,250);assert.equal(q.slowFields.week52Range.source,'yahoo');} finally {service.stop();}
});
test('04 unsupported batch markets only use supported enrichment', async () => {
  let calls=0;const service=createSnapshotService({fetchBatch:async()=>{calls++;return {quotes:[]};},enrich:async symbol=>({symbol,price:10,quoteAt:Date.now(),src:'yahoo'})});
  try {service.start();service.getCachedQuote('VOD.L');await new Promise(r=>setTimeout(r,130));assert.equal(calls,0);assert.equal(service.getCachedQuote('VOD.L').stale,undefined);} finally {service.stop();}
});
test('17 fair enrichment reaches eighty active symbols before repeating first ones', async () => {
  const original={setInterval,clearInterval,setTimeout,clearTimeout};let time=1,callback;const seen=new Set();
  globalThis.setInterval=fn=>(callback=fn,1);globalThis.clearInterval=()=>{};globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
  const s=createSnapshotService({now:()=>time,fetchBatch:async syms=>({quotes:syms.map(symbol=>({symbol,price:1,quoteAt:time}))}),enrich:async symbol=>{seen.add(symbol);return {symbol,price:1,quoteAt:time};}});
  try{s.start();for(let i=0;i<80;i++)s.getCachedQuote('SYM'+i);for(let n=0;n<40;n++){time+=2000;for(let i=0;i<80;i++)s.getCachedQuote('SYM'+i);callback();await flush();}assert.equal(seen.size,80);}finally{s.stop();Object.assign(globalThis,original);}
});
test('domain services can be independently constructed', async () => {
  const server=await import('../server.js'); assert.equal(typeof server.createApplication,'function');
});
test('06 upstream error pages and invalid JSON cannot become fresh empty news',async()=>{
  const {createYahooNews}=await import('../lib/yahoo-news.js');
  const {createEastmoneyProvider}=await import('../lib/providers/em.js');
  const {createNewsService}=await import('../lib/news.js');
  for(const response of [{status:503,body:'<html>unavailable</html>'},{status:429,body:'{}'},{status:200,body:'not-json'},{status:200,body:'{}'}]){
    const yahoo=createYahooNews({getCrumb:async()=>({cookie:'fixture'}),yGated:fn=>fn(null,100),httpsGet:async()=>response});
    await assert.rejects(yahoo('AAPL'));
    await assert.rejects(createEastmoneyProvider({httpsGet:async()=>response}).eastmoneyNews('600519.SS'));
  }
  const svc=createNewsService({yahooNews:async()=>{throw new Error('offline');},httpsGet:async()=>({status:503,body:'<html>error</html>'})});
  const result=await svc.requestNews('AAPL');assert.equal(result.stale,true);assert.equal(result.updatedAt,null);assert.ok(result.error);
});
test('06,16 foreground cache hits renew activity; background refreshes expire without clients',async()=>{
  const {createNewsService}=await import('../lib/news.js');let time=1000000,calls=0;
  const svc=createNewsService({now:()=>time,newsLoader:async()=>{calls++;return [{t:time,title:'news',src:'Reuters',link:'https://example.test/news'}];}});
  await svc.requestNews('AAPL');time+=500000;await svc.requestNews('AAPL');assert.equal(svc.activeSyms.get('AAPL'),time);
  time+=50000;await svc.requestNews('AAPL');assert.equal(calls,2);assert.equal(svc.activeSyms.get('AAPL'),time);
  time+=600000;assert.equal(calls,2,'未请求时不轮转');svc.stopNews();assert.equal(svc.activeSyms.size,0);
});
test('08 OHLC cache is keyed by the requested trading day',async()=>{
  const {createYahooService}=await import('../lib/yahoo.js');
  const svc=createYahooService({env:{Y_MIN_GAP:'1'},getCrumb:async()=>({crumb:'x',cookie:'x'}),clearCrumb(){},yahoo429Hit(){},clear429Streak(){},httpsGet:async()=>({status:200,body:JSON.stringify({chart:{result:[{timestamp:[Date.parse('2026-09-03T13:30:00Z')/1000,Date.parse('2026-09-04T13:30:00Z')/1000],indicators:{quote:[{open:[98,100],high:[100,103],low:[97,99],close:[99,102]}]}}]}})})});
  const first=await svc.getDayOhlc('QQQ','2026-8-4'),next=await svc.getDayOhlc('QQQ','2026-8-5');
  assert.equal(first.open,100);assert.equal(first.prevClose,99);assert.equal(next.open,null);assert.equal(next.prevClose,102);
});
test('12 macro retains last good items and timestamps when all sources fail',async()=>{
  const {createMacroService}=await import('../lib/macro.js');let time=2000000,fail=false;
  const svc=createMacroService({now:()=>time,googleNewsTopic:async tp=>{if(fail)throw new Error('offline');return [{t:time,topic:tp.name,src:'Reuters',title:'Treasury yields '+tp.id,link:'https://example.test/'+tp.id}];},yahooNews:async()=>{if(fail)throw new Error('offline');return [];},httpsGet:async()=>fail?{status:503,body:'error'}:{status:200,body:JSON.stringify({result:{data:{feed:{list:[]}}}})}});
  const first=await svc.getMacro();assert.equal(first.stale,false);assert.ok(first.items.length);
  time+=301000;fail=true;const second=await svc.getMacro({waitForRefresh:true});assert.deepEqual(second.items,first.items);assert.equal(second.updatedAt,first.updatedAt);assert.equal(second.stale,true);assert.ok(second.error);assert.ok(second.retryAt>time);
  const cold=createMacroService({now:()=>time,googleNewsTopic:async()=>{throw new Error('offline');},yahooNews:async()=>{throw new Error('offline');},httpsGet:async()=>({status:429,body:'limited'})});
  const unavailable=await cold.getMacro();assert.equal(unavailable.updatedAt,null);assert.equal(unavailable.stale,true);
});
test('12 routine macro background refresh is distinct from source failure',async()=>{
  const {createMacroService}=await import('../lib/macro.js');let time=1000000;
  const svc=createMacroService({now:()=>time,googleNewsTopic:async()=>[],yahooNews:async()=>[],httpsGet:async()=>({status:200,body:'{"result":{"data":{"feed":{"list":[]}}}}'})});
  await svc.getMacro();time+=120000;const result=await svc.getMacro();assert.equal(result.stale,false);assert.equal(result.refreshing,true);assert.equal(result.error,undefined);
});
test('26 two applications isolate collaborators, caches, queues, auth and telemetry',async()=>{
  const {createApplication}=await import('../server.js');
  const make=price=>createApplication({env:{Y_MIN_GAP:'1'},upstream:async()=>({status:200,body:'{"news":[]}',headers:{}}),providerOverrides:{fetchQuote:async symbol=>({symbol,price,quoteAt:1000})}});
  const a=make(10),b=make(20);
  const [qa,qb]=await Promise.all([a.services.quoteCache.getCachedQuote('QQQ'),b.services.quoteCache.getCachedQuote('QQQ')]);assert.equal(qa.price,10);assert.equal(qb.price,20);
  assert.notEqual(a.services.quote.cacheMap,b.services.quote.cacheMap);assert.notEqual(a.services.news.activeSyms,b.services.news.activeSyms);assert.notEqual(a.services.batch,b.services.batch);
  a.services.auth.seed('a');assert.equal(b.services.auth.state().crumbFailUntil,0);
  a.telemetry.countUpstream('fixture',1,false,false);assert.equal(b.telemetry.stats.upstream.total,0);
  a.services.news.activateNews('AAPL');assert.equal(b.services.news.activeSyms.size,0);await a.stop();await b.stop();
});
test('29 all-market calendar gate detects the year boundary and unknown exchanges',async()=>{
  const {calendarCoverageStatus}=await import('../mkt.mjs');
  assert.equal(calendarCoverageStatus(Date.parse('2026-09-05T00:00:00Z'),90).ok,true);
  const boundary=calendarCoverageStatus(Date.parse('2026-10-05T00:00:00Z'),90);assert.equal(boundary.ok,false);assert.equal(boundary.missing.length,20);assert.equal(boundary.missing.every(x=>x.year===2027),true);
});
test('slow enrichment rejects wrong identities and preserves previous valid fields on partial failure',async()=>{
  const originals={setInterval,clearInterval,setTimeout,clearTimeout};let tick,time=1000000,phase=0;
  globalThis.setInterval=fn=>(tick=fn,1);globalThis.clearInterval=()=>{};globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
  const svc=createSnapshotService({now:()=>time,fetchBatch:async()=>({quotes:[{symbol:'QQQ',price:200,quoteAt:time}]}),enrich:async()=>phase===0?{symbol:'QQQ',price:100,quoteAt:1,src:'yahoo',fetchedAt:time,week52High:250,week52Low:80,charts:{daily30:[{t:1,c:100}],intraday:[]}}:phase===1?{symbol:'SPY',price:1,quoteAt:time,week52High:999,week52Low:1,charts:{daily30:[{t:1,c:999}]}}:{symbol:'QQQ',price:100,quoteAt:time,src:'yahoo',fetchedAt:time,week52High:-1,week52Low:0,charts:{daily30:[],intraday:[]}}});
  try{
    svc.start();svc.getCachedQuote('QQQ');tick();await flush();const old=svc.getCachedQuote('QQQ');assert.equal(old.week52High,250);assert.ok(Object.isFrozen(old.charts.daily30));
    phase=1;time+=61000;svc.getCachedQuote('QQQ');tick();await flush();assert.equal(svc.getCachedQuote('QQQ').charts.daily30[0].c,100);
    phase=2;time+=61000;svc.getCachedQuote('QQQ');tick();await flush();const q=svc.getCachedQuote('QQQ');assert.equal(q.week52High,250);assert.equal(q.charts.daily30.length,1);assert.equal(q.slowFields.week52Range.stale,true);assert.equal(q.slowFields.week52Range.updatedAt,old.slowFields.week52Range.updatedAt);
  }finally{svc.stop();Object.assign(globalThis,originals);}
});
test('28 authoritative enrichment can correct an inferred equity to ETF',async()=>{
  const service=createSnapshotService({fetchBatch:async()=>({quotes:[{symbol:'VTI',price:100,quoteAt:1000,instrumentType:'EQUITY',instrumentTypeSource:'inferred'}]}),enrich:async()=>({symbol:'VTI',price:99,quoteAt:900,instrumentType:'ETF',instrumentTypeSource:'provider',src:'yahoo'})});
  try{service.start();service.getCachedQuote('VTI');await new Promise(r=>setTimeout(r,130));const q=service.getCachedQuote('VTI');assert.equal(q.price,100);assert.equal(q.instrumentType,'ETF');assert.equal(q.instrumentTypeSource,'provider');}finally{service.stop();}
});
test('history metadata survives failed refresh without inventing a successful timestamp',async()=>{
  const {createYahooService}=await import('../lib/yahoo.js');let time=1000000,fail=false;
  const service=createYahooService({now:()=>time,env:{Y_MIN_GAP:'1'},getCrumb:async()=>({cookie:'c',crumb:'c'}),clearCrumb(){},yahoo429Hit(){},clear429Streak(){},httpsGet:async()=>{if(fail)throw new Error('offline');return {status:200,body:'{"chart":{"result":[{"timestamp":[1],"indicators":{"quote":[{"open":[1],"high":[2],"low":[1],"close":[2]}]}}]}}'};}});
  const first=await service.getYahooDaily('QQQ');assert.equal(service.yahooDailyMetadata('QQQ').updatedAt,time);
  time+=301000;fail=true;assert.deepEqual(await service.getYahooDaily('QQQ'),first);assert.deepEqual(service.yahooDailyMetadata('QQQ'),{source:'yahoo',updatedAt:1000000,stale:true});
});
