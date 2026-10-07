import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {quoteFreshnessPolicy} from '../../lib/quote-age.js';
import {assessQuoteFreshness} from '../../lib/quote-freshness.js';
import {compareQuoteSources} from '../../lib/quote-comparison.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {mergeTradingStatistics} from '../../lib/trading-statistics.js';
import {mergeAlpacaQuote} from '../../lib/realtime-quote-service.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {buildMarketDetail} from '../../lib/market-detail.js';
import {responseSchema} from '../../scripts/build-context-docs.mjs';
import Ajv2020 from '../support/schema-validator.mjs';

const time=Date.parse,now=time('2026-10-06T15:00:00Z');
const quote=extra=>({symbol:'NVDA',price:100,currency:'USD',instrumentType:'EQUITY',src:'finnhub-quote',priceBasis:'provider-quote',priceSession:'REGULAR',marketState:'REGULAR',quoteAt:now-1000,sourceCheckedAt:now,feedDelayMinutes:null,prevClose:99,previousCloseTradeDate:'2026-10-05',...extra});
const project=(q,at=now)=>buildMarketContext({query:{symbol:q.symbol,include:['quote']},requestId:'quality',generatedAt:at,quote:q});
const sandbox=vm.createContext({window:{},Date});
vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-state.js',import.meta.url),'utf8'),sandbox);
const uiFresh=sandbox.window.PANEL_STATE.selectFreshness;

test('closed quotes require latest verified regular close, preserving weekend and long exchange holiday',()=>{
 for(const [symbol,at,current,old,day] of [
  ['NVDA','2026-10-04T12:00Z','2026-10-02T20:00Z','2026-09-25T20:00Z','2026-10-02'],
  ['600519.SS','2026-10-07T08:00Z','2026-09-30T07:00Z','2026-09-29T07:00Z','2026-09-30'],
  ['NVDA','2026-11-27T23:00Z','2026-11-27T18:00Z','2026-11-25T21:00Z','2026-11-27'],
  ['9766.T','2026-09-21T07:00Z','2026-09-18T06:30Z','2026-09-17T06:30Z','2026-09-18']
 ]){
  const clock=time(at),q=quote({symbol,quoteAt:time(current),sourceCheckedAt:clock,marketState:'CLOSED'});
  const policy=quoteFreshnessPolicy(q,clock);
  assert.equal(policy.requiredTradeDate,day);assert.equal(policy.calendarVerified,true);
  assert.equal(assessQuoteFreshness(q,clock).eventReason,null);
  assert.equal(assessQuoteFreshness({...q,quoteAt:time(old)},clock).eventReason,'QUOTE_TOO_OLD');
  assert.equal(uiFresh({...q,quoteFreshnessPolicy:policy},clock).stale,false);
  assert.equal(uiFresh({...q,quoteAt:time(old),quoteFreshnessPolicy:policy},clock).reason,'quote-overdue');
  assert.equal(project({...q,quoteAt:time(old)},clock).sections.quote.status,'partial');
 }
});

test('closed unknown calendars cannot certify freshness and open sessions never reuse closed allowance',()=>{
 const at=time('2035-10-07T12:00Z'),q=quote({quoteAt:at,sourceCheckedAt:at,marketState:'CLOSED'});
 assert.equal(assessQuoteFreshness(q,at).eventReason,'QUOTE_CALENDAR_UNVERIFIED');
 assert.equal(uiFresh({...q,quoteFreshnessPolicy:quoteFreshnessPolicy(q,at)},at).reason,'quote-calendar-unverified');
 assert.equal(assessQuoteFreshness(quote({marketState:'CLOSED',quoteAt:now-360000}),now).eventReason,'QUOTE_TOO_OLD');
 const date=time('2026-10-04T12:00Z'),sunday=quote({marketState:'CLOSED',quoteAt:time('2026-10-02T20:00Z'),sourceCheckedAt:date});
 assert.equal(uiFresh({...sunday,quoteFreshnessPolicy:quoteFreshnessPolicy(sunday,date-1000),nextMarketTransitionAt:date},date).reason,'quote-calendar-refresh-needed');
});

test('delayed close and midday break use finite source-event tolerance',()=>{
 const clock=time('2026-10-06T04:00Z'),q=quote({symbol:'2330.TW',quoteAt:clock-10*60000,sourceCheckedAt:clock,feedDelayMinutes:15});
 assert.equal(assessQuoteFreshness(q,clock).eventReason,null);
 const lunch=time('2026-09-30T04:00Z'),cn=quote({symbol:'600519.SS',quoteAt:time('2026-09-30T03:29Z'),sourceCheckedAt:lunch});
 assert.equal(assessQuoteFreshness(cn,lunch).eventReason,null);
 assert.equal(assessQuoteFreshness({...cn,quoteAt:time('2026-09-30T03:00Z')},lunch).eventReason,'QUOTE_TOO_OLD');
});

test('real fast-polling entrypoint marks a comparable extreme price disagreement partial without changing selected value',async()=>{
 const primary=quote(),backup=quote({src:'tx-batch',price:200,quoteAt:now,priceBasis:'website-last-trade'});
 const polling=createFastPolling({now:()=>now,httpsGet:async()=>({status:200,body:''}),finnhubQuotes:async()=>[primary],legacy:{tencent:async()=>[backup],fetchSnapshotBatch:async()=>({quotes:[]})}});
 const result=await polling.fetchSnapshotBatch(['NVDA'],{group:'us',force:true}),q=result.quotes[0];
 assert.equal(q.price,200);assert.equal(q.quoteComparison.status,'conflict');
 const out=project(q);assert.equal(out.sections.quote.status,'partial');assert.equal(out.sections.quote.missing_reason,'QUOTE_SOURCE_PRICE_CONFLICT');
 assert.ok(out.quality.warnings.includes('quote_source_price_conflict'));
 assert.equal(out.sources[out.sections.quote.data.source_comparison.comparisons[0].source_id].name,'finnhub-quote');
 assert.equal(uiFresh(q,now).reason,'quote-source-conflict');
 const check=new Ajv2020({allErrors:true}).compile(responseSchema);assert.equal(check(out),true,JSON.stringify(check.errors));
});

test('quote comparisons exclude incompatible currency, security, session, time, adjustment and proxy observations',()=>{
 const selected=quote({quoteAt:now}),other=quote({src:'sina-batch',price:200,priceBasis:'website-last-trade'});
 for(const patch of [{symbol:'TSM'},{currency:'TWD'},{priceSession:'PRE'},{quoteAt:now-60001},{adjustmentBasis:'split'},{priceBasis:'unknown'},{proxy:true},{quoteTimeBasis:'server_observation'},{quoteAt:now+1}]){
  assert.equal(compareQuoteSources(selected,[{...other,...patch}],{now}).status,'not_compared',JSON.stringify(patch));
 }
 const close=compareQuoteSources(selected,[{...other,price:102}],{now});assert.equal(close.status,'within_threshold');
 assert.match(close.method,/not_independent_verification/);
});

test('statistics supplement preserves its independent successful-check clock and source in quote API',()=>{
 const price=quote(),stats=quote({src:'sina-batch',quoteAt:now-60000,regularQuoteAt:now-60000,sourceCheckedAt:now-10000,ohlcSession:'REGULAR',open:98,dayHigh:102,dayLow:97,prevClose:99,volume:1000,volumeUnit:'shares'});
 const merged=mergeTradingStatistics(price,stats,{now});
 assert.equal(merged.statisticsCheckedAt,stats.sourceCheckedAt);
 const out=project(merged),section=out.sections.quote;
 assert.equal(out.sources[section.data.price_source_id].name,'finnhub-quote');
 assert.equal(out.sources[section.data.statistics_source_id].name,'sina-batch');
 assert.equal(section.data.statistics_source_checked_at_ms,stats.sourceCheckedAt);
 assert.equal(section.data.statistics_as_of_ms,stats.quoteAt);assert.equal(section.data.statistics_status,'ready');
 assert.deepEqual(section.source_ids.map(id=>out.sources[id].name),['finnhub-quote','sina-batch']);
 const retained=project({...merged,sourceCheckedAt:now+70000},now+70000).sections.quote;
 assert.equal(retained.data.statistics_status,'partial');assert.equal(retained.data.statistics_source_checked_at_ms,stats.sourceCheckedAt);
});

test('API discloses delay, price precision and feed scope without calling unknown coverage consolidated real time',()=>{
 const unknown=project(quote({feedCoverage:'account entitlement unverified',quoteTimePrecision:'minute'}));
 assert.equal(unknown.sections.quote.status,'ready');
 assert.equal(unknown.sections.quote.coverage.feed_scope,'account entitlement unverified');
 assert.equal(unknown.sections.quote.coverage.entitlement,'unverified');
 assert.equal(unknown.sections.quote.data.quote_time_precision,'minute');
 assert.ok(unknown.quality.warnings.includes('quote_delay_unverified'));
 assert.ok(unknown.quality.warnings.includes('quote_market_coverage_unverified'));
 const iex=project(quote({feedCoverage:'us-iex',feedDelayMinutes:0}));assert.ok(iex.quality.warnings.includes('quote_single_exchange_coverage'));
});

test('a newer stream trade cannot inherit prior website anomaly evidence or closed-market cutoff',()=>{
 const base=quote({priceBasis:'website-last-trade',quoteComparison:{status:'conflict'},quoteFreshnessPolicy:{kind:'bad-old-policy'}});
 const data={source:'alpaca',coverage:'us-iex',delayMinutes:0,state:'streaming',connectionHealthy:true,connectionCheckedAt:now,trade:{symbol:'NVDA',price:101,quoteAt:now,receivedAt:now}};
 const out=mergeAlpacaQuote(base,data,now);
 assert.equal(out.quoteComparison.selectedSource,'alpaca');assert.equal(out.quoteComparison.status,'within_threshold');
 assert.equal(out.quoteFreshnessPolicy.kind,'event_age');assert.equal(out.quoteFreshnessPolicy.evaluatedAt,now);
});

test('main cards disclose unknown coverage and delay, and show cross-source conflict without calling it a verified price',()=>{
 vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-card-view.js',import.meta.url),'utf8'),sandbox);
 sandbox.window.PANEL_FORMAT={esc:String,fmtVol:String,pct:String};
 const view=sandbox.window.PANEL_CARD_VIEW.createCardView({document:{},panelsEl:{},stripEl:{},chartController:{},formatterFor:()=>({}),cardCurOf:()=>'USD',nameOf:()=>'',humanizeAge:String});
 const field=()=>({hidden:true,textContent:'',title:'',dataset:{}});
 const card={d:quote({quoteAt:now-120000}),quoteMeta:field(),quoteAge:field(),quoteDetails:field(),sourceCheckAge:field(),staleWarn:field()};
 view.updateQuoteMeta(card,now);
 assert.match(card.quoteDetails.textContent,/覆盖未核验.*延迟未声明.*本来源暂无更新报价/);
 assert.equal(card.quoteDetails.hidden,false);assert.equal(card.staleWarn.hidden,true);
 card.d={...card.d,quoteComparison:{status:'conflict'}};view.updateQuoteMeta(card,now);
 assert.equal(card.staleWarn.textContent,'报价来源有分歧');assert.equal(card.staleWarn.hidden,false);
});

test('detail aggregates new comparison conflicts and renders financial freshness evidence',async()=>{
 const fields={peTTM:{value:20,status:'available',source:'primary',datePrecision:'day',businessDate:'2026-10-06',asOf:now,
  comparison:{status:'disagreement',candidates:[{source:'primary',value:20},{source:'backup',value:40}]},qualityWarnings:['source-disagreement'],contentFreshness:{status:'within-age-window'}},
  priceToBook:{value:3,status:'available',source:'primary',contentFreshness:{status:'unverified',reason:'valuation-effective-date-unknown'},qualityWarnings:['valuation-effective-date-unknown']}};
 const context=buildMarketContext({query:{symbol:'NVDA',include:['quote','fundamentals']},requestId:'detail-quality',generatedAt:now,quote:quote({fundamentals:{fields},quoteComparison:{status:'conflict'}})});
 const payload=buildMarketDetail(context,{profile:'snapshot',format:'objects'});
 assert.deepEqual(payload.quality.conflicting_fields,['fundamentals.peTTM','quote.price']);
 assert.ok(payload.quality.warnings.includes('financial_source_disagreement'));
 assert.ok(payload.quality.warnings.includes('financial_content_freshness_unverified'));
 const leaf=()=>({children:[],listeners:{},dataset:{},textContent:'',append(...children){this.children.push(...children);},appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){}});
 const doc={body:leaf(),createElement:leaf},button=leaf(),ui=vm.createContext({window:{},AbortController,setTimeout,clearTimeout,Date});
 vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-detail.js',import.meta.url),'utf8'),ui);
 const detail=ui.window.PANEL_DETAIL.createDetailView({document:doc,fetchImpl:async()=>({ok:true,json:async()=>payload})});
 detail.mount({symbol:'NVDA',el:{querySelector:()=>button}});button.listeners.click();await new Promise(resolve=>setImmediate(resolve));
 const texts=node=>[node.textContent,...node.children.flatMap(texts)].join('\n'),rendered=texts(doc.body);
 assert.match(rendered,/来源数值有分歧/);assert.match(rendered,/比对来源：backup；值 40/);
 assert.match(rendered,/资料时效未核验/);assert.match(rendered,/估值有效时点未提供/);
 assert.match(rendered,/来源业务日期：2026-10-06（按日发布/);detail.close();
});
