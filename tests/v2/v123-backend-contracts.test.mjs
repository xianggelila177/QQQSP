import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHistoryService} from '../../lib/history-service.js';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {quoteFreshnessPolicy} from '../../lib/quote-age.js';
import {assessQuoteFreshness} from '../../lib/quote-freshness.js';
import {historyData,deferred} from './backend-repair-fixtures.mjs';

const NOW=Date.parse('2026-10-10T00:00:00Z');
const ui=vm.createContext({window:{},Date});
vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-state.js',import.meta.url),'utf8'),ui);
const clientFreshness=ui.window.PANEL_STATE.selectFreshness;
const contextQuery=extra=>({symbol:'NVDA',include:['daily'],daily_bar_count:252,max_wait_ms:1000,...extra});
function historyFixture(t,{floor='2020-01-01',limited=false}={}){
 let clock=NOW,fail=false,block=null;const calls=[];
 const history=createHistoryService({now:()=>clock,fetchChart:async(symbol,query,{signal})=>{
  calls.push({symbol,query});
  if(block&&symbol==='QQQ'){
   block.started.resolve();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});
  }
  if(fail)throw Object.assign(new Error('source cooldown'),{code:'RATE_LIMITED',statusCode:429,retryAt:clock+60000});
  const params=new URLSearchParams(query),from=new Date(Number(params.get('period1'))*1000).toISOString().slice(0,10),through=new Date(Number(params.get('period2'))*1000).toISOString().slice(0,10);
  const earliest=limited?'2026-06-08':floor;
  const value=historyData(symbol,{start:from>earliest?from:earliest,end:through<'2026-10-09'?through:'2026-10-09'});
  value.meta.firstTradeDate=Date.parse(floor+'T16:00:00Z')/1000;
  Object.assign(value,{sourceCheckedAt:clock,sourceTimeBasis:'source-checked'});
  if(limited)Object.assign(value,{retrievalLimited:true,retrievedFrom:earliest,coverage:{stopReason:'provider-window'}});
  return value;
 }});
 const service=createMarketContextService({history,now:()=>clock,maxActive:1,maxQueued:0});
 t.after(()=>{service.close();history.close();});
 return {history,service,calls,fail:()=>{fail=true;},block:()=>{block={started:deferred()};return block.started.promise;},advance:ms=>{clock+=ms;}};
}

test('context fills a fresh near history window once, preserving zero-wait cache reads',async t=>{
 const f=historyFixture(t);await f.history.get('NVDA','daily',{count:79});
 const cached=await f.service.query(contextQuery({max_wait_ms:0}));
 assert.ok(cached.sections.daily.rows.length<252);assert.equal(cached.sections.daily.missing_reason,'INSUFFICIENT_HISTORY');assert.equal(f.calls.length,1);
 const full=await f.service.query(contextQuery());assert.equal(full.sections.daily.rows.length,252);assert.equal(f.calls.length,2);
 const again=await f.service.query(contextQuery());assert.deepEqual(again.sections.daily.rows,full.sections.daily.rows);assert.equal(f.calls.length,2);
});

test('context respects monthly near scope and an exclusive historical cursor',async t=>{
 const f=historyFixture(t);await f.history.get('NVDA','daily',{count:79});
 const near=await f.history.get('NVDA','monthly',{count:12,cacheOnly:true});assert.equal(near.extent.scope,'near');assert.equal(near.extent.satisfied,false);
 const monthly=await f.service.query(contextQuery({daily_granularity:'monthly',daily_bar_count:12}));
 assert.equal(monthly.sections.daily.rows.length,12);assert.equal(f.calls.length,2);
 const older=await f.service.query(contextQuery({daily_before:'2024-01-01',daily_bar_count:40}));
 assert.equal(older.sections.daily.rows.length,40);assert.ok(older.sections.daily.rows.every(row=>row[1]<'2024-01-01'));assert.equal(f.calls.length,3);
});

test('context does not repeatedly fetch a proven listing origin or a bounded provider window',async t=>{
 for(const options of [{floor:'2026-10-01'},{limited:true}]){
  const f=historyFixture(t,options);await f.history.get('NVDA','daily',{count:79});
  const before=f.calls.length,out=await f.service.query(contextQuery()),after=f.calls.length;
  assert.ok(out.sections.daily.rows.length<252);assert.equal(out.sections.daily.status,'partial');
  if(options.floor)assert.equal(after,before,'a proven origin is already satisfied');
  await f.service.query(contextQuery());assert.equal(f.calls.length,after,'retrieval limits must reuse the cached source window');
 }
});

test('context expansion keeps source cooldown and serves retained partial data',async t=>{
 const f=historyFixture(t);await f.history.get('NVDA','daily',{count:79});f.fail();
 const first=await f.service.query(contextQuery());assert.equal(f.calls.length,2);assert.ok(first.sections.daily.rows.length>0);assert.equal(first.sections.daily.status,'partial');
 const second=await f.service.query(contextQuery());assert.equal(f.calls.length,2);assert.deepEqual(second.sections.daily.rows,first.sections.daily.rows);
});

test('context expansion preserves partial caches when the source lane is full',async t=>{
 const f=historyFixture(t);await f.history.get('NVDA','daily',{count:79});const started=f.block(),abort=new AbortController();
 const held=f.service.query(contextQuery({symbol:'QQQ'}),{signal:abort.signal});const stopped=assert.rejects(held);await started;
 const out=await f.service.query(contextQuery());assert.equal(out.sections.daily.status,'partial');assert.ok(out.sections.daily.rows.length>0);assert.equal(f.calls.length,2);
 abort.abort();await stopped;
});

function engineFixture(t,{clock,quote={}}){
 let at=clock,value={symbol:'NVDA',price:100,currency:'USD',instrumentType:'EQUITY',marketState:'REGULAR',priceSession:'REGULAR',
  src:'fixture',quoteAt:clock,sourceCheckedAt:clock,feedDelayMinutes:0,...quote};
 const events=[],flushers=[],timeout=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
  if(ms!==50)return timeout(callback,ms,...args);
  flushers.push(callback);return {unref(){}};
 });
 const engine=createQuoteEngine({now:()=>at,tickMs:600000,readQuote:async()=>({...value,quoteFreshnessPolicy:quoteFreshnessPolicy(value,at)})});
 engine.subscribe(()=>events.push(engine.read(['NVDA'],{lease:false})[0]));engine.start();engine.watch(['NVDA']);t.after(()=>engine.stop());
 return {events,async step(next=at,patch={}){at=next;value={...value,...patch};await engine.refreshNow(['NVDA']);for(const flush of flushers.splice(0))flush();return engine.read(['NVDA'],{lease:false})[0];}};
}

test('quote engine deduplicates closed evaluation clocks but keeps source checks and prices',async t=>{
 const f=engineFixture(t,{clock:NOW,quote:{quoteAt:Date.parse('2026-10-09T20:00:00Z'),marketState:'CLOSED'}});
 const first=await f.step();assert.equal(f.events.length,1);
 await f.step(NOW+1000);await f.step(NOW+2000);assert.equal(f.events.length,1);
 assert.equal(first.quoteFreshnessPolicy.evaluatedAt,NOW,'published evaluation metadata is retained, not stripped');
 await f.step(NOW+3000,{sourceCheckedAt:NOW+3000});assert.equal(f.events.length,2);
 await f.step(NOW+4000,{price:101});assert.equal(f.events.length,3);
 assert.equal(f.events.at(-1).quoteAt,first.quoteAt);
});

test('quote engine ignores rolling open cutoffs but publishes the actual event-age boundary',async t=>{
 const start=Date.parse('2026-10-06T15:00:00Z');
 const f=engineFixture(t,{clock:start,quote:{checkIntervalMs:3600000}}),first=await f.step();
 await f.step(start+1000);await f.step(start+300000);assert.equal(f.events.length,1);
 assert.equal(clientFreshness(first,start+300000).stale,false);
 const expired=await f.step(start+300001);assert.equal(f.events.length,2);
 assert.equal(assessQuoteFreshness(expired,start+300001).eventReason,'QUOTE_TOO_OLD');
 assert.equal(clientFreshness(expired,start+300001).reason,'quote-overdue');
 await f.step(start+301000);assert.equal(f.events.length,2);
});

test('quote engine publishes source-check and healthy-stream expiry without per-tick churn',async t=>{
 const start=Date.parse('2026-10-06T15:00:00Z');
 const f=engineFixture(t,{clock:start});await f.step();await f.step(start+60000);assert.equal(f.events.length,1);
 const overdue=await f.step(start+60001);assert.equal(f.events.length,2);assert.equal(assessQuoteFreshness(overdue,start+60001).checkReason,'SOURCE_CHECK_OVERDUE');
 const stream=await f.step(start+61000,{src:'finnhub',realtimeSource:'finnhub',priceBasis:'reported-trade',realtimeStatus:'streaming',realtimeConnectionHealthy:true,connectionCheckedAt:start+61000});
 assert.equal(assessQuoteFreshness(stream,start+61000).checkReason,null);assert.equal(f.events.length,3);
 await f.step(start+151000);assert.equal(f.events.length,3);
 const silent=await f.step(start+151001);assert.equal(f.events.length,4);assert.equal(assessQuoteFreshness(silent,start+151001).checkReason,'SOURCE_CHECK_OVERDUE');
});

test('quote engine publishes calendar session changes and delayed event-age boundaries',async t=>{
 const start=Date.parse('2026-10-06T13:29:59Z'),f=engineFixture(t,{clock:start,quote:{checkIntervalMs:3600000,feedDelayMinutes:15}});
 const before=await f.step();assert.equal(before.quoteFreshnessPolicy.state,'PRE');
 const opened=await f.step(start+1000);assert.equal(f.events.length,2);assert.equal(opened.quoteFreshnessPolicy.state,'REGULAR');
 await f.step(start+930000);assert.equal(f.events.length,2);
 const expired=await f.step(start+930001);assert.equal(f.events.length,3);assert.equal(clientFreshness(expired,start+930001).reason,'quote-overdue');
});

test('retaining the winning price does not retain its old session policy',async t=>{
 const start=Date.parse('2026-10-06T13:29:59Z'),f=engineFixture(t,{clock:start});
 const first=await f.step();assert.equal(first.quoteFreshnessPolicy.state,'PRE');
 const opened=await f.step(start+1000,{price:99,quoteAt:start-1000});
 assert.equal(opened.price,100);assert.equal(opened.quoteAt,start);assert.equal(opened.sourceCheckedAt,start);
 assert.equal(opened.quoteFreshnessPolicy.state,'REGULAR');assert.equal(opened.quoteFreshnessPolicy.evaluatedAt,start+1000);assert.equal(f.events.length,2);
});
