import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {createMarketContextService} from '../../lib/market-context-service.js';

const now=Date.parse('2026-09-21T14:00:00Z');
const quote={symbol:'NVDA',price:224,currency:'USD',src:'finnhub',instrumentType:'EQUITY',priceBasis:'reported-trade',quoteAt:now-120000,
  sourceCheckedAt:now-120000,tradeReceivedAt:now-120000,connectionCheckedAt:now,realtimeSource:'finnhub',realtimeStatus:'streaming',realtimeConnectionHealthy:true,marketState:'REGULAR'};
const project=(q,at=now)=>buildMarketContext({query:{symbol:q.symbol,include:['quote']},requestId:'freshness',generatedAt:at,quote:q}).sections.quote;

test('context waiting accepts a healthy quiet stream without manufacturing a timeout',async()=>{
  let watches=0,listeners=0;
  const original=structuredClone(quote);
  const service=createMarketContextService({now:()=>now,engine:{read:()=>[quote],watch(){watches++;return ()=>watches--;},poke(){},subscribe(){listeners++;return ()=>listeners--;}}});
  try{
    const out=await service.query({symbol:'NVDA',include:['quote'],max_wait_ms:50});
    assert.equal(out.sections.quote.status,'ready');assert.equal(out.sections.quote.missing_reason,null);
    assert.equal(out.sections.quote.data.quote_at_ms,quote.quoteAt);assert.equal(out.sections.quote.data.source_checked_at_ms,quote.sourceCheckedAt);
    assert.deepEqual(quote,original);assert.equal(watches,0);assert.equal(listeners,0);
  }finally{service.close();}
});

test('API projects current exchange state while preserving the source price session and clocks',()=>{
  const cached={...quote,marketState:'CLOSED',priceSession:'PRE'};
  const out=project(cached);
  assert.equal(out.data.market_state,'REGULAR');assert.equal(out.data.session,'PRE');
  assert.equal(cached.marketState,'CLOSED');assert.equal(out.data.quote_at_ms,cached.quoteAt);
});

test('API keeps genuine old prices, missing source clocks and stale website checks partial',()=>{
  for(const [q,reason] of [
    [{...quote,quoteAt:now-600001},'QUOTE_TOO_OLD'],
    [{...quote,sourceCheckedAt:null,fetchedAt:now},'UNKNOWN_SOURCE_CHECK'],
    [{...quote,src:'naver-us',fetchedAt:now},'SOURCE_CHECK_OVERDUE'],
    [{...quote,sourceCheckedAt:now+1},'SOURCE_TIME_INVALID'],
  ]){const out=project(q);assert.equal(out.status,'partial');assert.equal(out.missing_reason,reason);}
  const weekend=Date.parse('2026-09-20T12:00:00Z');
  const out=project({...quote,quoteAt:weekend-15*86400000,sourceCheckedAt:weekend,connectionCheckedAt:weekend},weekend);
  assert.equal(out.missing_reason,'QUOTE_TOO_OLD');
});

test('invalid declared delays cannot give an old quote an unlimited lifetime',()=>{
  for(const feedDelayMinutes of [Infinity,NaN,-1,'15']){
    const out=project({...quote,quoteAt:now-600001,sourceCheckedAt:now,feedDelayMinutes});
    assert.equal(out.missing_reason,'QUOTE_TOO_OLD');assert.equal(out.delay_minutes,null);
  }
});
