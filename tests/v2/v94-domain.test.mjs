import test from 'node:test';
import assert from 'node:assert/strict';
import {parseContextQuery,contextFromSearch,CONTEXT_SECTIONS} from '../../lib/context-query.js';
import {parseDetailQuery,buildMarketDetail} from '../../lib/market-detail.js';
import {marketStatus,tradingDayInfo,tradingCalendar,previousTradingDate,localInstant} from '../../lib/market-calendar-api.js';
import {aggregateContextSeries} from '../../lib/context-series.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {derivePaidDividends} from '../../lib/action-dividends.js';
import {semanticEtag,etagMatches,encodeCsv,lifecycleHeaders} from '../../lib/api-representation.js';
import {parseMoversQuery} from '../../lib/api-market-routes.js';
import {loadConfig} from '../../config.js';
const now=Date.parse('2026-09-21T16:00:00Z');
const q=extra=>parseContextQuery({symbol:'NVDA',...extra});
test('v94 default single query preserves v93 section order, counts, compact layout and missing values',()=>{
 const query=q({});assert.deepEqual(query.include,[...CONTEXT_SECTIONS]);assert.equal(query.daily_bar_count,252);assert.equal(query.format,'compact');assert.equal(query.adjustment,undefined);
 const out=buildMarketContext({query,requestId:'test',generatedAt:now});assert.equal(out.schema_version,1);assert.equal(out.sections.daily.columns.length,9);assert.equal(out.sections.intraday.columns.length,5);assert.equal(out.sections.samples.columns.length,9);assert.ok(!out.sections.corporate_actions);assert.equal(out.status,'unavailable');
});
for(const [name,input] of Object.entries({unknown:{bad:1},badAdjustment:{adjustment:'all'},missingDaily:{include:['quote'],adjustment:'raw'},fraction:{aggregate_minutes:1.5},badMinutes:{aggregate_minutes:2},sourceWithoutMinutes:{aggregate_source:'samples'},wrongSource:{aggregate_minutes:15,aggregate_source:'macro'},twoSelectors:{intraday_date:'2026-09-18',intraday_month:'2026-09'},badMonth:{intraday_month:'2026-13'},invalidDate:{intraday_date:'2026-02-30'},wrongIncluded:{include:['quote'],intraday_before:'2026-09-19'},csvMixed:{format:'csv'},actionRange:{include:['corporate_actions'],actions_start:'2026-09-19',actions_end:'2026-09-01'}}))test('v94 strict optional parameter validation: '+name,()=>assert.throws(()=>q(input),{code:'BAD_CONTEXT_QUERY'}));
test('v94 batch normalization is bounded, unique and quote/fundamentals only',()=>{
 const b=parseContextQuery({symbols:[' nvda ','spy']});assert.deepEqual(b.symbols,['NVDA','SPY']);assert.deepEqual(b.include,['quote','fundamentals']);
 for(const input of [{symbol:'NVDA',symbols:['NVDA']},{symbols:[]},{symbols:['NVDA','nvda']},{symbols:Array.from({length:11},(_,i)=>'A'+i)},{symbols:['NVDA'],include:['daily']},{symbols:['NVDA'],format:'csv'},{symbols:['NVDA'],adjustment:'raw'}])assert.throws(()=>parseContextQuery(input),{code:'BAD_CONTEXT_QUERY'});
});
test('v94 GET parameters reject duplicates and noninteger numbers',()=>{
 assert.deepEqual(contextFromSearch(new URLSearchParams('symbols=NVDA,SPY&include=quote&max_wait_ms=0')).symbols,['NVDA','SPY']);
 for(const text of ['symbol=NVDA&symbol=SPY','symbol=NVDA&max_wait_ms=1e3','symbol=NVDA&api_key=hidden'])assert.throws(()=>contextFromSearch(new URLSearchParams(text)),{code:'BAD_CONTEXT_QUERY'});
});
test('v94 v2 snapshot remains narrow; analysis explicitly opts into new parameters',()=>{
 assert.throws(()=>parseDetailQuery({symbol:'NVDA',adjustment:'raw'}));
 const p=parseDetailQuery({symbol:'NVDA',profile:'analysis',include:['daily','corporate_actions'],adjustment:'split'});assert.equal(p.adjustment,'split');
 const c=buildMarketContext({query:p,requestId:'test',generatedAt:now});const out=buildMarketDetail(c,p);assert.ok(!out.sections.order_book);assert.ok(Array.isArray(out.sections.corporate_actions.records));
});
test('v94 calendar skips Labor Day instead of inventing a Monday opening',()=>{
 const d=marketStatus({exchange:'US'},{now:Date.parse('2026-09-05T18:00:00Z')});assert.equal(d.market_state,'closed');assert.equal(new Date(d.next_open_at_ms).toISOString(),'2026-09-08T13:30:00.000Z');assert.equal(previousTradingDate('SPY','2026-09-08'),'2026-09-04');
});
test('v94 ordinary weekend, DST and half-day regular sessions use exchange calendar',()=>{
 assert.equal(new Date(marketStatus({exchange:'us'},{now:Date.parse('2026-09-19T18:00Z')}).next_open_at_ms).toISOString(),'2026-09-21T13:30:00.000Z');
 assert.equal(new Date(marketStatus({exchange:'us'},{now:Date.parse('2026-11-07T18:00Z')}).next_open_at_ms).toISOString(),'2026-11-09T14:30:00.000Z');
 const d=tradingDayInfo('SPY','2026-11-27');assert.equal(d.half_day,true);assert.equal(new Date(d.regular_sessions[0].close_at_ms).toISOString(),'2026-11-27T18:00:00.000Z');
});
test('v94 unknown calendar years remain unknown and range is bounded',()=>{
 const c=tradingCalendar({exchange:'us',start:'2037-01-01',end:'2037-01-03'});assert.equal(c.status,'partial');assert.ok(c.days.every(d=>d.is_open===null));
 for(const x of [{exchange:'invented',start:'2026-01-01',end:'2026-01-02'},{start:'2026-02-30',end:'2026-03-01'},{start:'2026-01-01',end:'2028-01-01'}])assert.throws(()=>tradingCalendar(x));
});
function prices(points,{source='s1',currency='USD'}={}){const start=localInstant('NVDA','2026-09-18',570);return {status:'ready',missing_reason:null,source_ids:[source],columns:['time_ms','trade_date','price','volume','session','source_id','currency'],column_units:['unix_milliseconds','exchange_date',currency,'shares','session','source_reference','currency'],column_descriptions:[],rows:points.map(([minute,price,extra])=>[start+minute*60000,'2026-09-18',price,50,'REGULAR',source,currency,...[]].map((v,i)=>extra&&Object.hasOwn(extra,i)?extra[i]:v)),coverage:{},adjustment:'unknown'};}
test('v94 observed-price OHLC preserves null empty buckets and never treats cumulative quantities as volume',()=>{
 const input=prices([[0,100],[1,105],[14,99],[30,110]]),r=aggregateContextSeries(input,15,{symbol:'NVDA',zone:'America/New_York',sampled:true});
 assert.equal(r.rows.length,3);assert.deepEqual(r.rows[0].slice(2,6),[100,105,99,99]);assert.deepEqual(r.rows[1].slice(2,7),[null,null,null,null,null]);assert.ok(r.rows.every(row=>row[6]===null));assert.equal(r.coverage.empty_buckets,1);assert.match(r.coverage.price_kind,/not_trade/);assert.equal(r.status,'partial');
});
test('v94 a source/currency change inside a bucket invalidates OHLC rather than mixing it',()=>{
 const input=prices([[0,100],[1,110,{5:'s2'}]]);const r=aggregateContextSeries(input,15,{symbol:'NVDA',zone:'America/New_York',sampled:true});assert.equal(r.missing_reason,'MIXED_SOURCE_BUCKET');assert.equal(r.rows[0][2],null);
});
test('v94 verified source OHLC aggregation sums only complete bar volume',()=>{
 const t=localInstant('NVDA','2026-09-18',570),base={status:'ready',source_ids:['s1'],missing_reason:null,adjustment:'raw',columns:['time_ms','trade_date','open','high','low','close','volume','session'],column_units:['unix_milliseconds','exchange_date','USD','USD','USD','USD','shares','session'],column_descriptions:[],coverage:{volume_kind:'bar_volume'},rows:[[t,'2026-09-18',100,110,90,105,10,'REGULAR'],[t+60000,'2026-09-18',105,115,100,111,20,'REGULAR']]};
 const r=aggregateContextSeries(base,5,{symbol:'NVDA',zone:'America/New_York'});assert.deepEqual(r.rows[0].slice(2,7),[100,115,90,111,30]);base.rows[1][6]=null;assert.equal(aggregateContextSeries(base,5,{symbol:'NVDA',zone:'America/New_York'}).rows[0][6],null);
});
test('v94 session boundaries never merge PRE and REGULAR hourly observations',()=>{
 const input=prices([[0,100],[1,101]]);input.rows[0][0]-=60000;input.rows[0][4]='PRE';const r=aggregateContextSeries(input,60,{symbol:'NVDA',zone:'America/New_York',sampled:true});assert.equal(r.rows.length,2);assert.notEqual(r.rows[0][0],r.rows[1][0]);assert.notEqual(r.rows[0][7],r.rows[1][7]);
});
test('v94 paid-dividend calculation requires currency, payment-date coverage and share-basis evidence',()=>{
 const quote={symbol:'NVDA',currency:'USD',priceSession:'REGULAR',regularPrice:100,fundamentals:{fields:{}}};
 const actions={source:'verified-fixture',start:'2025-09-01',end:'2026-09-21',paidWindowVerified:true,splitWindowVerified:true,sourceCheckedAt:now,events:[{type:'dividend',ex_date:'2026-01-01',payment_date:'2026-01-10',amount:2,currency:'USD',amount_basis:'nominal_at_ex_date',source:'fixture'},{type:'split',ex_date:'2026-06-01',ratio:2}]};
 const r=derivePaidDividends(quote,actions,now);assert.equal(r.fundamentals.fields.dividendTTM.value,1);assert.equal(r.fundamentals.fields.dividendYieldTTM.value,1);assert.equal(r.fundamentals.fields.dividendTTM.calculated,true);assert.deepEqual(quote.fundamentals.fields,{});
 for(const bad of [{...actions,paidWindowVerified:false},{...actions,splitWindowVerified:false},{...actions,events:[{...actions.events[0],payment_date:null}]},{...actions,events:[{...actions.events[0],currency:null}]},{...actions,events:[{...actions.events[0],amount_basis:'unverified'}]}])assert.equal(derivePaidDividends(quote,bad,now),quote);
});
test('v94 weak semantic ETag ignores envelope IDs but changes when coverage or source time changes',()=>{
 const a={request_id:'a',generated_at_ms:1,sections:{a:{value:null,source_checked_at_ms:1}}},b={...a,request_id:'b',generated_at_ms:2};assert.equal(semanticEtag(a),semanticEtag(b));b.sections={a:{value:null,source_checked_at_ms:2}};assert.notEqual(semanticEtag(a),semanticEtag(b));assert.ok(etagMatches('*',semanticEtag(a)));assert.ok(etagMatches(semanticEtag(a).replace('W/',''),semanticEtag(a)));
});
test('v94 CSV is escaped, CRLF-terminated, null-preserving, and has complete metadata',()=>{
 const c={schema_version:1,request_id:'test',generated_at_ms:now,status:'partial',instrument:{symbol:'NVDA'},sources:{s1:{name:'fixture'}},quality:{warnings:[]},sections:{daily:{columns:['a','b','c','d'],column_units:[null,null,null,null],column_descriptions:['','','',''],rows:[[null,-2,'=SUM(A1)','say "x",\ny']],coverage:{partial:true}}}};
 const r=encodeCsv(c);assert.match(r.body,/\r\n$/);assert.match(r.body,/,-2,"'=SUM\(A1\)"/);assert.match(r.body,/say ""x"",\ny/);const meta=JSON.parse(Buffer.from(r.headers['X-QQQSP-Metadata'],'base64url'));assert.deepEqual(meta.sources,c.sources);assert.deepEqual(meta.metadata.coverage,{partial:true});assert.ok(!meta.metadata.rows);
});
test('v94 lifecycle headers are opt-in and use distinct RFC 9745/8594 date encodings',()=>{
 assert.deepEqual(lifecycleHeaders({}),{});const h=lifecycleHeaders({deprecation:'2026-12-01T00:00:00Z',sunset:'2027-06-01T00:00:00Z'});assert.match(h.Deprecation,/^@\d+$/);assert.match(h.Sunset,/GMT$/);
 assert.throws(()=>loadConfig({API_V1_DEPRECATION_AT:'2027-01-01T00:00:00Z',API_V1_SUNSET_AT:'2026-01-01T00:00:00Z'}));
 assert.equal(loadConfig({}).API_V1_DEPRECATION_AT,'');
});
test('v94 mover limits and universe parameters cannot be silently broadened',()=>{
 assert.deepEqual(parseMoversQuery({}),{market:'us',range:'1d',top:10});for(const q of [{top:0},{top:51},{market:'cn'},{range:'1w'},{unknown:1}])assert.throws(()=>parseMoversQuery(q));
});
test('v94 lifecycle configuration rejects impossible dates and reversed deadlines',()=>{
 for(const values of [{API_V1_DEPRECATION_AT:'2026-02-30T00:00:00Z'},{API_V1_DEPRECATION_AT:'2026-13-01T00:00:00Z'},{API_V1_SUNSET_AT:'2026-12-01T00:00:00Z'},{API_V1_DEPRECATION_AT:'2026-12-01T00:00:00Z',API_V1_SUNSET_AT:'2026-11-01T00:00:00Z'}])assert.throws(()=>loadConfig(values),TypeError);
});
