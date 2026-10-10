import test from 'node:test';
import assert from 'node:assert/strict';
import {loadApp} from '../_harness.mjs';

test('a quote batch and a display tick each share one current watchlist policy',async()=>{
  const now=Date.now(),symbols=Array.from({length:100},(_,i)=>'T'+i);
  const quotes=symbols.map(symbol=>({symbol,currency:'USD',price:100,prevClose:99,change:1,changePct:1,
    marketState:'CLOSED',priceSession:'REGULAR',quoteAt:now,sourceCheckedAt:now,
    quoteFreshnessPolicy:{kind:'last_completed_regular_session',state:'CLOSED',calendarVerified:true,minEventAt:now-1000},
    charts:{intraday:[]}}));
  const env=await loadApp({watchlist:symbols,initialMarket:quotes,refreshMode:'economy'});await env.drain();
  const hooks=env.hooks(),state=env.win.PANEL_STATE;let policies=0;const freshness=[];
  env.win.PANEL_STATE={...state,pollingPolicy:(...args)=>{policies++;return state.pollingPolicy(...args);},
    selectFreshness:(data,at,options)=>{freshness.push({at,interval:options.readIntervalMs});return state.selectFreshness(data,at,options);}};

  hooks.tickClock();
  assert.equal(policies,1,'100 cards must not recalculate the watchlist policy for each metadata/header check');
  assert.equal(new Set(freshness.map(value=>value.at)).size,1,'cards and header use the same display clock');
  assert.ok(freshness.length>=100);assert.ok(freshness.every(value=>value.interval===60000));

  // The last incoming card opens its market. Earlier cards must already use the
  // new fast policy, rather than the old closed-market policy during rendering.
  const changed=quotes.map((quote,i)=>({...quote,sourceCheckedAt:now-45000,
    ...(i===quotes.length-1?{marketState:'REGULAR',quoteFreshnessPolicy:undefined}:{})}));
  policies=0;freshness.length=0;env.fetch.push('market',{body:changed});await hooks.refresh(false);
  assert.equal(policies,1);assert.equal(freshness.length,100);
  assert.ok(freshness.every(value=>value.interval===2000));
  assert.equal(hooks.cardCache.get(symbols[0]).staleWarn.hidden,false,'fast-policy source timeout is reflected on the first card');
  assert.equal(hooks.cardCache.get(symbols[0]).staleWarn.textContent,'来源检查超时');

  for(const card of hooks.cardCache.values())card.d.marketState='CLOSED';
  policies=0;freshness.length=0;hooks.tickClock();
  assert.equal(policies,1);assert.ok(freshness.every(value=>value.interval===60000),'next tick does not retain the prior open-market policy');
  hooks.cardCache.get(symbols[0]).d.nextMarketTransitionAt=Date.now()+5000;
  policies=0;freshness.length=0;hooks.tickClock();
  assert.equal(policies,1);assert.ok(freshness.every(value=>value.interval>=2000&&value.interval<10000),'upcoming calendar transitions are recalculated');
});
