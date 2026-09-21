import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {parseContextQuery,createMarketContextService} from '../../lib/market-context-service.js';
import {FINANCIAL_FIELDS,selectFinancialRecord} from '../../lib/financial-candidates.js';
import {normalizeOrderBook,mergeOrderBook} from '../../lib/order-book.js';
import {parseDetailQuery,buildMarketDetail} from '../../lib/market-detail.js';
const sentinel='PRIVATE_SENTINEL_DO_NOT_EXPORT';
const now=Date.parse('2026-09-18T14:00:00Z');
const quote={symbol:'NVDA',price:100,currency:'USD',quoteAt:now-1000,sourceCheckedAt:now,src:'fixture',instrumentType:'EQUITY',priceSession:'REGULAR',marketState:'REGULAR'};
function context(q=quote,include=['quote','fundamentals']) {return buildMarketContext({query:parseContextQuery({symbol:q.symbol,include}),requestId:'test',generatedAt:now,quote:q});}
test('v93 every financial field exists even on a cold cache',()=>{
 const c=context(); assert.deepEqual(Object.keys(c.sections.fundamentals.data.fields),FINANCIAL_FIELDS);
 assert.equal(c.sections.fundamentals.coverage.applicable_fields,FINANCIAL_FIELDS.length);
 for(const field of Object.values(c.sections.fundamentals.data.fields)){assert.equal(field.value,null);assert.ok(field.missing_reason);}
});
test('v93 denominator and input provenance survive projection without arbitrary upstream properties',()=>{
 const c=context({...quote,fundamentals:{fields:{peTTM:{value:20,status:'available',unit:'ratio',source:'f',asOf:now,fetchedAt:now,denominator:5,shareSource:'shares',shareAsOf:now-10000,calculated:true,formula:'regular-price / trailing-EPS',inputs:[{name:'denominator',value:5,source:'eps',asOf:now-5000,period:'2026-TTM',secret:sentinel}],attempts:[{source:'f',state:'ready',lastSuccessAt:now}],secret:sentinel}}}});
 const f=c.sections.fundamentals.data.fields.peTTM;
 assert.equal(f.denominator,5); assert.ok(f.share_source_id); assert.equal(f.share_as_of_ms,now-10000);assert.equal(f.inputs[0].value,5);
 assert.equal(f.inputs[0].financial_period,'2026-TTM');assert.equal(f.attempts[0].state,'ready');assert.ok(!JSON.stringify(c).includes('PRIVATE_SENTINEL_DO_NOT_EXPORT'));
});
test('v93 ETF company valuation fields are explicit not applicable',()=>{
 const c=context({...quote,symbol:'SOXX',instrumentType:'ETF'});assert.equal(c.sections.fundamentals.data.fields.peTTM.status,'not-applicable');assert.equal(c.sections.fundamentals.data.fields.trailingEps.status,'not-applicable');
});
test('v93 incompatible 52-week observations cannot be paired',()=>{
 const pick=(low)=>selectFinancialRecord('NVDA',[{id:'f',data:{symbol:'NVDA',fetchedAt:now,fields:{week52High:{value:120,currency:'USD',unit:'price',basis:'range',asOf:now,fetchedAt:now},week52Low:{value:50,currency:'USD',unit:'price',basis:'range',asOf:now,fetchedAt:now,...low}}}}],[{id:'f'}],{now,maxAgeMs:100000});
 for(const mismatch of [{currency:'KRW'},{asOf:now-1000},{basis:'adjusted-range'}])assert.equal(pick(mismatch)?.fields.week52High,undefined);
 assert.equal(pick({}).fields.week52High.value,120);
});
test('v93 order book is independent from last trade and preserves round lots',()=>{
 const b=normalizeOrderBook({symbol:'NVDA',currency:'USD',source:'alpaca-iex',asOf:now,checkedAt:now,coverage:'single-exchange',sizeUnit:'round_lots',bid:{price:100,size:2},ask:{price:101,size:1}},quote,now);
 assert.equal(b.bid.size,2);assert.equal(b.sizeUnit,'round_lots');assert.equal(b.spread,1);assert.equal(b.depth,1);assert.equal(b.status,'ready');
 const merged=mergeOrderBook(quote,{...quote,quoteAt:now-5000,orderBook:b},now);assert.equal(merged.price,100);assert.equal(merged.quoteAt,quote.quoteAt);assert.equal(merged.orderBook.asOf,now);
});
test('v93 rejects crossed, wrong-identity, future and invalid-sized books',()=>{
 const base={symbol:'NVDA',currency:'USD',source:'p',asOf:now,checkedAt:now,sizeUnit:'shares',coverage:'provider-top-of-book',bid:{price:100,size:1},ask:{price:101,size:2}};
 assert.equal(normalizeOrderBook({...base,ask:{price:99,size:2}},quote,now).status,'partial');
 for(const change of [{symbol:'AMD'},{currency:'KRW'},{asOf:now+60000}])assert.equal(normalizeOrderBook({...base,...change},quote,now).status,'unavailable');
 assert.equal(normalizeOrderBook({...base,bid:{price:100,size:true}},quote,now).bid.size,null);
});
test('v93 snapshot profile avoids history and analysis supports explicit compact output',()=>{
 const q=parseDetailQuery({symbol:' nvda '});assert.deepEqual(q.include,['quote','fundamentals']);assert.equal(q.profile,'snapshot');
 assert.ok(parseDetailQuery({symbol:'NVDA',profile:'analysis'}).include.includes('daily'));
 for(const bad of [{symbol:'NVDA',profile:'everything'},{symbol:'NVDA',format:'raw'},{symbol:'NVDA',secret:true}])assert.throws(()=>parseDetailQuery(bad));
 const d=buildMarketDetail(context(),q);assert.equal(d.schema_version,2);assert.ok(d.sections.order_book);assert.ok(d.sections.fundamentals.data.fields.peTTM.label);assert.ok(d.quality.missing_fields.length);
});
test('v93 history continuation is passed to the existing history reader',async()=>{
 let options;const service=createMarketContextService({now:()=>now,history:{get:async(_s,_p,o)=>{options=o;return {symbol:'NVDA',bars:[]};}}});
 try {await service.query({symbol:'NVDA',include:['daily'],daily_before:'2026-09-01',daily_series_id:'series-1'});assert.equal(options.before,'2026-09-01');assert.equal(options.seriesId,'series-1');}finally{service.close();}
});
test('v93 stalled fundamentals do not relabel a successfully completed quote as timed out',async()=>{
 const q={...quote,fundamentals:{loading:true,fields:{}},charts:{intraday:[{t:(now-60000)/1000,c:99,v:1}]},slowFields:{intraday:{source:'f',updatedAt:now}}};
 const engine={read:()=>[q],watch:()=>()=>{},poke(){},subscribe:()=>()=>{}};
 const service=createMarketContextService({now:()=>now,engine});
 try{const c=await service.query({symbol:'NVDA',include:['quote','fundamentals','intraday'],max_wait_ms:30});assert.equal(c.sections.quote.status,'ready');assert.equal(c.sections.intraday.status,'ready');assert.equal(c.sections.fundamentals.missing_reason,'CONTEXT_TIMEOUT');}finally{service.close();}
});
