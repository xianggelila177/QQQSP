import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {buildMarketDetail} from '../../lib/market-detail.js';
import {createMarketContextHttp} from '../../lib/market-context-http.js';
import {createMarketAuxRoutes} from '../../lib/api-market-routes.js';
import {createApiKeys} from '../../lib/api-keys.js';
import {createContextLimiter} from '../../lib/api-rate-limit.js';
import {createMarketContextService} from '../../lib/market-context-service.js';
import {semanticEtag} from '../../lib/api-representation.js';
const at=Date.parse('2026-09-21T12:00:00Z'),week=7*86400000;
const key='fixture_v95_readonly_'.repeat(3);
const query={symbol:'AAOI',include:['news','macro'],daily_bar_count:1,sample_trading_days:1};
const article=(t,title='Applied Optoelectronics announces results')=>({t,title,src:'Business Wire',link:'https://www.businesswire.com/news/home/20260921001/en/'});
const context=items=>buildMarketContext({query,requestId:'test',generatedAt:at,news:{items,updatedAt:at},macro:{news:{items,updatedAt:at}}});
test('v95 API independently removes old, future, untraceable news from stock and macro projections',()=>{
 const input=[article(at-week),article(at-week-1,'August article'),article(at+1,'Future article'),article(null,'Unknown date'),{...article(at),link:'javascript:alert(1)'}];
 const out=context(input);
 assert.equal(out.sections.news.data.items.length,1);
 assert.equal(out.sections.macro.data.news.length,1);
 assert.equal(out.sections.news.data.items[0].published_at_ms,at-week);
 assert.equal(out.sections.news.coverage.quality.rejected_items,4);
 assert.equal(out.sections.news.coverage.quality.window_ms,week);
 const detail=buildMarketDetail(out,{profile:'analysis',format:'objects'});
 assert.deepEqual(detail.sections.news,out.sections.news);
 assert.equal(input.length,5);
});
test('v95 empty recent-news window is explicit and never silently reuses cached old articles',()=>{
 const out=context([article(at-week-1)]);
 assert.deepEqual(out.sections.news.data.items,[]);
 assert.equal(out.sections.news.missing_reason,'NO_RECENT_NEWS');
 assert.equal(out.sections.news.as_of_ms,null);
 assert.equal(out.sections.news.source_checked_at_ms,at);
});
test('v95 projected news carries publisher metadata and never describes feed metadata as fact checking',()=>{
 const out=context([article(at-1000)]),item=out.sections.news.data.items[0];
 assert.equal(item.provenance.publisher,'Business Wire');
 assert.equal(item.provenance.timestamp_basis,'publisher_reported');
 assert.match(item.provenance.verification,/not_independent/);
});
test('v95 invalid event time cannot produce a ready quote just because the fetch was recent',()=>{
 for(const quoteAt of [null,at+60000]){
  const out=buildMarketContext({query:{...query,include:['quote']},requestId:'test',generatedAt:at,quote:{symbol:'AAOI',price:100,currency:'USD',src:'fixture',quoteAt,sourceCheckedAt:at}});
  assert.equal(out.sections.quote.status,'partial');
  assert.equal(out.sections.quote.missing_reason,quoteAt===null?'UNKNOWN_QUOTE_TIME':'QUOTE_TIME_INVALID');
  assert.equal(out.sections.quote.coverage.sequence_scope,'not_provided');
 }
});
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));return 'http://127.0.0.1:'+s.address().port;}
test('v95 CORS Vary preserves Authorization on authenticated context and auxiliary cache paths',async t=>{
 const handler=createMarketContextHttp({apiKey:key,allowGet:true,service:{query:async()=>context([])}});
 const base=await server(t,(req,res)=>handler(req,res,{Vary:'Origin','Access-Control-Allow-Origin':'https://panel.example'}));
 const first=await fetch(base+'?symbol=AAOI&include=news',{headers:{Authorization:'Bearer '+key}});
 assert.match(first.headers.get('vary'),/Authorization/i);await first.text();
 const aux=createMarketAuxRoutes({keys:createApiKeys({apiKey:key}),limiter:createContextLimiter(),advanced:{capabilities:()=>({})}});t.after(()=>aux.close());
 const other=await server(t,(req,res)=>aux.handle(req,res,new URL(req.url,'http://local'),{vary:'Origin'}));
 const second=await fetch(other+'/api/v1/capabilities',{headers:{Authorization:'Bearer '+key}});
 assert.match(second.headers.get('vary'),/Authorization/i);await second.text();
});
test('v95 cold news API refreshes within budget without creating active subscriptions; zero wait is cache-only',async t=>{
 let starts=0;const news={peek:()=>({items:[],updatedAt:null}),requestNews:async(symbol,options)=>{starts++;assert.equal(symbol,'AAOI');assert.equal(options.activate,false);assert.ok(options.signal);return {items:[article(at)],updatedAt:at};}};
 const service=createMarketContextService({news,now:()=>at});t.after(()=>service.close());
 const cold=await service.query({symbol:'AAOI',include:['news'],max_wait_ms:100});
 assert.equal(cold.sections.news.data.items.length,1);assert.equal(starts,1);
 await service.query({symbol:'AAOI',include:['news'],max_wait_ms:0});assert.equal(starts,1);
});
test('v95 stalled news respects the shared query deadline and cancels its waiter',async t=>{
 let cancelled=false;const news={peek:()=>({items:[],updatedAt:null}),requestNews:(_s,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}))};
 const service=createMarketContextService({news,now:()=>at});t.after(()=>service.close());
 const start=performance.now(),out=await service.query({symbol:'AAOI',include:['news'],max_wait_ms:30});
 assert.ok(cancelled);assert.ok(performance.now()-start<500);assert.equal(out.sections.news.missing_reason,'CONTEXT_TIMEOUT');
});
test('v95 news conditional cache changes on actual expiry, not a fresh evaluation of the same window',()=>{
 const items=[article(at-week+1000)],first=context(items);
 const build=generatedAt=>buildMarketContext({query,requestId:'test',generatedAt,news:{items,updatedAt:at},macro:{news:{items,updatedAt:at}}});
 assert.equal(semanticEtag(first),semanticEtag(build(at+500)));
 assert.notEqual(semanticEtag(first),semanticEtag(build(at+1001)));
});
test('v95 repeatedly fetched old trades are partial in open sessions, while holiday closes and declared delays remain valid',()=>{
 const build=(generatedAt,quoteAt,marketState)=>buildMarketContext({query:{...query,symbol:'9766.T',include:['quote']},requestId:'jp',generatedAt,quote:{symbol:'9766.T',price:18670,currency:'JPY',src:'naver-jp',feedDelayMinutes:15,pollAfterMs:70000,quoteAt,sourceCheckedAt:generatedAt,marketState}}).sections.quote;
 const friday=Date.parse('2026-09-18T06:30Z'),holiday=Date.parse('2026-09-21T07:00Z'),open=Date.parse('2026-09-24T01:00Z');
 assert.equal(build(holiday,friday,'HOLIDAY').status,'ready');
 assert.equal(build(open,friday,'REGULAR').missing_reason,'QUOTE_TOO_OLD');
 assert.equal(build(open,open-15*60000,'REGULAR').status,'ready');
 assert.equal(build(open,open-16*60000,'REGULAR').status,'partial');
 assert.equal(build(open,friday,'CLOSED').missing_reason,'QUOTE_TOO_OLD','cached provider session cannot freeze the exchange calendar');
});
