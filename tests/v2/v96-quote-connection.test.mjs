import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {buildMarketContext} from '../../lib/market-context-format.js';
const now=Date.parse('2026-09-21T14:00Z');
const quote={symbol:'NVDA',price:150,currency:'USD',priceBasis:'reported-trade',src:'finnhub',realtimeSource:'finnhub',realtimeStatus:'streaming',realtimeConnectionHealthy:true,connectionCheckedAt:now,tradeReceivedAt:now-120000,quoteAt:now-120000,sourceCheckedAt:now-120000,marketState:'REGULAR',feedDelayMinutes:null};
const project=q=>buildMarketContext({query:{symbol:'NVDA',include:['quote']},requestId:'connection',generatedAt:now,quote:q}).sections.quote;
const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-state.js',import.meta.url),'utf8'),context);
test('API keeps quiet trade and source timestamps separate from a healthy stream heartbeat',()=>{
 const q=project(quote);assert.equal(q.status,'ready');assert.equal(q.data.quote_at_ms,now-120000);assert.equal(q.data.source_checked_at_ms,now-120000);
 assert.equal(q.data.connection_checked_at_ms,now);assert.equal(q.data.trade_received_at_ms,now-120000);assert.equal(q.data.stream_connection_healthy,true);assert.equal(q.delay_minutes,null);
});
test('stream heartbeat cannot hide stale website data, old trades or a dead stream',()=>{
 assert.equal(project({...quote,src:'naver-us'}).missing_reason,'SOURCE_CHECK_OVERDUE');
 assert.equal(project({...quote,quoteAt:now-600000}).missing_reason,'QUOTE_TOO_OLD');
 assert.equal(project({...quote,connectionCheckedAt:now-100000}).missing_reason,'SOURCE_CHECK_OVERDUE');
});
test('browser shows quiet healthy stream trades without a false network failure and still detects stale fallback',()=>{
 const fresh=context.window.PANEL_STATE.selectFreshness;
 assert.equal(fresh(quote,now).stale,false);
 assert.equal(fresh({...quote,src:'naver-us'},now).stale,true);
 assert.equal(fresh({...quote,connectionCheckedAt:now-100000},now).stale,true);
 assert.equal(fresh({...quote,quoteAt:now-600000},now).stale,true);
});
