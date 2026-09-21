import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdvancedMarketData,normalizeAlpacaActions} from '../../lib/providers/advanced-market-data.js';
import {parseContextQuery} from '../../lib/context-query.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {createMarketContextService} from '../../lib/market-context-service.js';
const now=Date.parse('2026-09-21T18:00:00Z'),opts={apiKey:'fixture-key',apiSecret:'fixture-secret',feed:'sip',now:()=>now};
const answer=data=>({status:200,headers:{},body:JSON.stringify(data)});
const daily=(date,c=100,v=10)=>({t:date+'T04:00:00Z',o:c-1,h:c+2,l:c-2,c,v});
const q=x=>parseContextQuery({symbol:'NVDA',include:['daily'],daily_bar_count:5,adjustment:'raw',...x});
test('v94 explicit adjustments use raw/split/split,dividend and never the broader all mode',async t=>{
 const urls=[];const p=createAdvancedMarketData({...opts,httpsGet:async(url,headers)=>{urls.push(new URL(url));assert.equal(headers['APCA-API-KEY-ID'],'fixture-key');return answer({symbol:'NVDA',bars:[daily('2026-09-18')],next_page_token:null});}});t.after(()=>p.close());
 for(const adjustment of ['raw','split','split_dividend']){const r=await p.daily(q({adjustment}));assert.equal(r.adjustmentBasis,adjustment);assert.equal(r.bars[0].adjustedClose,adjustment==='raw'?null:100);}
 assert.deepEqual(urls.map(u=>u.searchParams.get('adjustment')),['raw','split','split,dividend']);assert.ok(urls.every(u=>u.hostname==='data.alpaca.markets'&&!u.href.includes('fixture-secret')));
});
test('v94 corrected NVIDIA split oracle: 2024-06-10 is 10:1; prices are explicitly synthetic fixtures',async t=>{
 const at=Date.parse('2024-06-12T18:00Z'),source={corporate_actions:{forward_splits:[{symbol:'NVDA',new_rate:10,old_rate:1,ex_date:'2024-06-10',process_date:'2024-06-10'}]}};
 assert.equal(normalizeAlpacaActions('NVDA',source,{now:at}).events[0].ratio,10);
 const p=createAdvancedMarketData({...opts,now:()=>at,httpsGet:async url=>{const mode=new URL(url).searchParams.get('adjustment');return answer({symbol:'NVDA',bars:[daily('2024-06-07',mode==='raw'?1200:120),daily('2024-06-10',120)],next_page_token:null});}});t.after(()=>p.close());
 const raw=await p.daily(q({daily_bar_count:2})),split=await p.daily(q({daily_bar_count:2,adjustment:'split'}));assert.equal(raw.bars[0].c/split.bars[0].c,10);assert.equal(raw.bars[1].c,split.bars[1].c);
});
test('v94 official daily pagination is followed, chronological OHLC aggregation matches daily rows',async t=>{
 let calls=0;const data=['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18'].map((d,i)=>daily(d,100+i,i+1));
 const p=createAdvancedMarketData({...opts,httpsGet:async url=>{calls++;const next=new URL(url).searchParams.get('page_token');return answer({symbol:'NVDA',bars:next?data.slice(0,3):data.slice(3),next_page_token:next?null:'page2'});}});t.after(()=>p.close());
 const r=await p.daily(q({daily_granularity:'weekly',daily_bar_count:1}));assert.equal(calls,2);assert.equal(r.bars[0].o,99);assert.equal(r.bars[0].h,106);assert.equal(r.bars[0].l,98);assert.equal(r.bars[0].c,104);assert.equal(r.bars[0].v,15);assert.equal(r.bars[0].lastTradingDate,'2026-09-18');
 const out=buildMarketContext({query:q({daily_granularity:'weekly',daily_bar_count:1}),requestId:'test',generatedAt:now,daily:r});assert.equal(out.sections.daily.rows[0][1],'2026-09-18');assert.equal(out.sections.daily.rows[0][10],'2026-09-14');assert.equal(out.sections.daily.coverage.next_before,'2026-09-14');
});
test('v94 monthly aggregation retains last actual trading date and unknown volume',async t=>{
 const p=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'NVDA',bars:[daily('2026-08-28',100),daily('2026-08-31',103,null),daily('2026-09-18',104)],next_page_token:null})});t.after(()=>p.close());
 const r=await p.daily(q({daily_granularity:'monthly',daily_bar_count:2}));assert.equal(r.bars.length,2);assert.equal(r.bars[0].lastTradingDate,'2026-08-31');assert.equal(r.bars[0].c,103);assert.equal(r.bars[0].v,null);
});
test('v94 provider errors do not fall back into mislabeled adjusted history',async t=>{
 for(const [status,code] of [[403,'SOURCE_PERMISSION_DENIED'],[429,'SOURCE_RATE_LIMITED'],[401,'SOURCE_UNAUTHORIZED']]){const p=createAdvancedMarketData({...opts,httpsGet:async()=>({status,headers:{'retry-after':'7'},body:'{}'})});t.after(()=>p.close());await assert.rejects(p.daily(q({})),{code});}
 const p=createAdvancedMarketData({now:()=>now,fetchChart:async()=>{throw Error('must not fall back');}});t.after(()=>p.close());await assert.rejects(p.daily(q({adjustment:'split'})),{code:'ADJUSTMENT_SOURCE_NOT_CONFIGURED'});
});
test('v94 cursor identity and source pagination loops are rejected',async t=>{
 const p=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'NVDA',bars:[daily('2026-09-18')],next_page_token:null})});t.after(()=>p.close());await assert.rejects(p.daily(q({daily_series_id:'wrong'})),{code:'HISTORY_SERIES_CHANGED'});
 const p2=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'NVDA',bars:[],next_page_token:'repeat'})});t.after(()=>p2.close());await assert.rejects(p2.daily(q({})),{code:'SOURCE_CURSOR_INVALID'});
 const p3=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'SPY',bars:[],next_page_token:null})});t.after(()=>p3.close());await assert.rejects(p3.daily(q({})),{code:'SOURCE_IDENTITY_MISMATCH'});
});
test('v94 source cache is independent of include/max_wait and same-key requests coalesce',async t=>{
 let calls=0;const p=createAdvancedMarketData({...opts,httpsGet:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return answer({symbol:'NVDA',bars:[daily('2026-09-18')],next_page_token:null});}});t.after(()=>p.close());
 await Promise.all([p.daily(q({})),p.daily(q({include:['daily','quote']}))]);assert.equal(calls,1);const r=await p.daily(q({max_wait_ms:0}),{cacheOnly:true});assert.equal(r.symbol,'NVDA');assert.equal(calls,1);
});
test('v94 requested historical intraday day is not replaced by latest source data',async t=>{
 const seen=[];const p=createAdvancedMarketData({...opts,httpsGet:async url=>{seen.push(new URL(url));return answer({symbol:'NVDA',bars:[{t:'2026-09-18T13:30:00Z',o:100,h:101,l:99,c:100,v:50}],next_page_token:null});}});t.after(()=>p.close());
 const query=parseContextQuery({symbol:'NVDA',include:['intraday'],intraday_before:'2026-09-19'}),r=await p.intraday(query);assert.equal(r.start,'2026-09-18');assert.equal(seen[0].searchParams.get('start'),'2026-09-18T04:00:00.000Z');
 const out=buildMarketContext({query,requestId:'test',generatedAt:now,intraday:r});assert.equal(out.sections.intraday.columns.length,8);assert.equal(out.sections.intraday.rows[0][1],'2026-09-18');assert.equal(out.sections.intraday.rows[0][6],50);
});
test('v94 nontrading dates and public lookback limits have explicit reasons and no invented bars',async t=>{
 let calls=0;const p=createAdvancedMarketData({now:()=>now,fetchChart:async()=>{calls++;throw Error('not called');}});t.after(()=>p.close());
 const holiday=await p.intraday({symbol:'NVDA',intraday_date:'2026-09-19'});assert.equal(holiday.missing_reason,'NON_TRADING_DAY');assert.equal(calls,0);await assert.rejects(p.intraday({symbol:'NVDA',intraday_date:'2026-08-18'}),{code:'INTRADAY_OUTSIDE_PUBLIC_LOOKBACK'});assert.equal(calls,0);
});
test('v94 public historical intraday identity, volume unit, and index points stay explicit',async t=>{
 const p=createAdvancedMarketData({now:()=>now,fetchChart:async symbol=>({meta:{symbol,dataGranularity:'1m',currency:'USD'},timestamp:[Date.parse('2026-09-18T13:30Z')/1000],indicators:{quote:[{open:[100],high:[101],low:[99],close:[100],volume:[10]}]}})});t.after(()=>p.close());
 const query=parseContextQuery({symbol:'^NDX',include:['intraday'],intraday_date:'2026-09-18'}),r=await p.intraday(query),out=buildMarketContext({query,requestId:'test',generatedAt:now,intraday:r});assert.equal(out.instrument.price_unit,'points');assert.equal(out.sections.intraday.column_units[2],'points');assert.equal(out.sections.intraday.rows[0][6],null);
});
test('v94 company actions follow process-date pagination; missing currency is never USD',async t=>{
 let calls=0;const p=createAdvancedMarketData({...opts,httpsGet:async url=>{calls++;assert.equal(new URL(url).searchParams.get('start'),'2024-06-01');return answer({corporate_actions:{forward_splits:[{symbol:'NVDA',new_rate:10,old_rate:1,ex_date:'2024-06-10',process_date:'2024-06-10'}],cash_dividends:[{symbol:'NVDA',rate:0.01,ex_date:'2024-06-11',payable_date:'2024-06-28',process_date:'2024-06-11'}]},next_page_token:null});}});t.after(()=>p.close());
 const query=parseContextQuery({symbol:'NVDA',include:['corporate_actions'],actions_start:'2024-06-01',actions_end:'2024-07-01'}),r=await p.actions(query);assert.equal(calls,1);assert.equal(r.filterBasis,'process_date');assert.equal(r.paidWindowVerified,false);assert.equal(r.events[1].currency,null);const out=buildMarketContext({query,requestId:'test',generatedAt:now,corporate_actions:r});assert.equal(out.sections.corporate_actions.rows.length,2);assert.equal(out.sections.corporate_actions.rows[0][3],10);
});
test('v94 corporate-action identity mismatches and malformed events are counted, not coerced',()=>{
 const r=normalizeAlpacaActions('NVDA',{corporate_actions:{forward_splits:[{symbol:'OTHER',ex_date:'2024-06-10',new_rate:10,old_rate:1},{symbol:'NVDA',ex_date:'2024-06-10',new_rate:10,old_rate:0}],cash_dividends:[{symbol:'NVDA',ex_date:'2024-06-11',rate:'0.01'}]}});assert.equal(r.events.length,0);assert.equal(r.rejected,3);
});
test('v94 public action fallback preserves ex-date basis and unknown payable date',async t=>{
 const at=Date.parse('2024-06-10T13:30Z')/1000;const p=createAdvancedMarketData({now:()=>now,fetchChart:async symbol=>({meta:{symbol,currency:'USD'},timestamp:[at],events:{splits:{a:{date:at,numerator:10,denominator:1}},dividends:{b:{date:at,amount:0.01}}}})});t.after(()=>p.close());
 const r=await p.actions({symbol:'NVDA',actions_start:'2024-06-01',actions_end:'2024-07-01'});assert.equal(r.events[0].payment_date,null);assert.equal(r.filterBasis,'ex_date');assert.equal(r.paidWindowVerified,false);
});
test('v94 movers use provider SIP universe, keep gains/losses/volume and separate timestamps',async t=>{
 const p=createAdvancedMarketData({...opts,httpsGet:async url=>answer(url.includes('most-actives')?{last_updated:'2026-09-21T17:59Z',most_actives:[{symbol:'NVDA',volume:100,trade_count:3}]}:{last_updated:'2026-09-21T18:00Z',gainers:[{symbol:'GAIN',price:10,change:1,percent_change:11}],losers:[{symbol:'LOSS',price:9,change:-1,percent_change:-10}]})});t.after(()=>p.close());
 const r=await p.movers({market:'us',range:'1d',top:10});assert.match(r.coverage.scope,/not the local watchlist/);assert.equal(r.losers[0].change_percent,-10);assert.equal(r.active[0].volume,100);assert.notEqual(r.as_of_ms,r.active_as_of_ms);
});
test('v94 batch failures are isolated and temporary memberships are released',async t=>{
 const watched=new Set(),engine={watch([s]){if(s==='FAIL')throw Error('single source failure');watched.add(s);return()=>watched.delete(s);},poke(){},subscribe(){return()=>{};},read(symbols){return symbols.map(symbol=>({symbol,price:100,currency:'USD',instrumentType:'EQUITY',quoteAt:now,sourceCheckedAt:now,src:'fixture'}));}};
 const service=createMarketContextService({engine,now:()=>now});t.after(()=>service.close());const out=await service.query({symbols:['NVDA','FAIL','SPY'],include:['quote'],max_wait_ms:100});assert.equal(out.results.length,3);assert.equal(out.results[1].status,'unavailable');assert.equal(out.status,'partial');assert.equal(out.coverage.quota_cost,3);assert.equal(watched.size,0);
});
test('v94 historical lookup error cannot borrow current quote charts and says what failed',async t=>{
 const service=createMarketContextService({now:()=>now,advanced:{intraday:async()=>{throw Object.assign(Error('no'),{code:'INTRADAY_OUTSIDE_PUBLIC_LOOKBACK'});}}});t.after(()=>service.close());const out=await service.query({symbol:'NVDA',include:['intraday'],intraday_date:'2026-08-01',max_wait_ms:100});assert.equal(out.status,'unavailable');assert.equal(out.sections.intraday.missing_reason,'INTRADAY_OUTSIDE_PUBLIC_LOOKBACK');assert.deepEqual(out.sections.intraday.rows,[]);
});
test('v94 invalid upstream cursor and excessive page rows fail explicitly',async t=>{
 for(const token of [false,0,'']){const p=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'NVDA',bars:[],next_page_token:token})});t.after(()=>p.close());await assert.rejects(p.daily(q({})),{code:'SOURCE_CURSOR_INVALID'});}
 const p=createAdvancedMarketData({...opts,httpsGet:async()=>answer({symbol:'NVDA',bars:Array.from({length:2501},()=>daily('2026-09-18')),next_page_token:null})});t.after(()=>p.close());await assert.rejects(p.daily(q({})),{code:'SOURCE_BAD_RESPONSE'});
});
test('v94 repeated identical corporate events across pages do not conflict on retrieval clock',async t=>{
 let page=0,stamp=now;const p=createAdvancedMarketData({...opts,now:()=>stamp++,httpsGet:async()=>answer({corporate_actions:{forward_splits:[{id:'split-id',symbol:'NVDA',ex_date:'2024-06-10',new_rate:10,old_rate:1}]},next_page_token:page++===0?'second':null})});t.after(()=>p.close());const out=await p.actions({symbol:'NVDA',actions_start:'2024-06-01',actions_end:'2024-07-01'});assert.equal(out.events.length,1);
});
test('v94 movers never silently filter malformed or excessive source ranks',async t=>{
 const p=createAdvancedMarketData({...opts,httpsGet:async url=>answer(url.includes('most-actives')?{most_actives:[],last_updated:'2026-09-21T17:00Z'}:{gainers:[{symbol:'NVDA',price:'100',change:1,percent_change:1}],losers:[],last_updated:'2026-09-21T17:00Z'})});t.after(()=>p.close());await assert.rejects(p.movers({market:'us',range:'1d',top:10}),{code:'SOURCE_BAD_RESPONSE'});
});
