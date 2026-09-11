import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadApp} from './_harness.mjs';

const cases=[];
const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(error){cases.push(error);console.error('FAIL '+name+': '+error.message);}};
const now=Date.parse('2026-09-04T21:00:00Z');
const sample={symbol:'QQQ',price:717.54,currency:'USD',prevClose:717.67,regularPrice:718.96,change:-.13,changePct:-.02,priceSession:'POST',marketState:'CLOSED',quoteAt:now,regularQuoteAt:now-3600000,gmtoff:-14400,sourceCheckedAt:now-100000,pollAfterMs:70000,charts:{intraday:[]},ext:{post:{price:717.54,change:-1.42,changePct:-.2}}};
const env=await loadApp({watchlist:['QQQ'],initialMarket:[sample]});await env.drain();
const H=env.hooks(),q=H.cardCache.get('QQQ'),select=env.win.PANEL_STATE.selectFreshness;

await check('70s source and 70s client phases have a finite additive check budget',()=>{
  const current=select(sample,now,{readIntervalMs:70000});
  assert.equal(current.checkBudgetMs,145000);
  assert.equal(current.stale,false,'100s source age is within the two independent polling phases');
  assert.equal(select(sample,now+45000,{readIntervalMs:70000}).stale,false,'exact budget boundary remains healthy');
  assert.equal(select(sample,now+45001,{readIntervalMs:70000}).reason,'source-overdue','missed source/read cycles eventually become stale');
  assert.equal(H.quoteIsStale(sample,now),false,'header uses the same additive policy');
  H.updateQuoteMeta(q,now);assert.equal(q.staleWarn.hidden,true,'card also remains healthy between reads');
  H.updateQuoteMeta(q,now+45001);assert.equal(q.staleWarn.hidden,false);
});
await check('active fast budgets and authoritative failures retain their behavior',async()=>{
  const active={...sample,marketState:'REGULAR',quoteAt:now,sourceCheckedAt:now-30000,pollAfterMs:2000};
  assert.equal(select(active,now,{readIntervalMs:2000}).checkBudgetMs,30000);
  assert.equal(select(active,now,{readIntervalMs:2000}).stale,false);
  assert.equal(select(active,now+1,{readIntervalMs:2000}).reason,'source-overdue');
  assert.equal(select({...active,sourceCheckedAt:now,quoteAt:now-16000},now,{readIntervalMs:2000}).reason,'quote-overdue','source allowance does not excuse overdue active trades');
  for(const flag of [{stale:true},{staleInfo:{reason:'rate-limited'}},{recovery:true}])assert.equal(select({...sample,...flag},now,{readIntervalMs:70000}).stale,true);
  env.fetch.push('market',{status:500,body:[]});await H.refresh(false);H.setCardCurrency('QQQ','USD');assert.equal(q.fetchStatus,'error');assert.match(q.state.textContent,/拉取失败/);
});
await check('cadence inputs cannot grant an unbounded source lifetime',()=>{
  assert.equal(select({...sample,pollAfterMs:1e12},now,{readIntervalMs:1e12}).checkBudgetMs,3600000+120000+5000);
  assert.equal(select({...sample,pollAfterMs:0},now,{readIntervalMs:NaN}).checkBudgetMs,30000);
});
await check('the identical explicit regular-close base appears once',()=>{
  q.d=sample;H.render(q);
  assert.match(q.extRow.innerHTML,/较本交易日常规收盘 718.96/);
  assert.doesNotMatch(q.extRow.innerHTML,/class="regular-close"/);
  assert.equal(q.extRow.innerHTML.split('718.96').length-1,1);
  assert.match(q.extRow.innerHTML,/-1.42 \(-0.20%\)/);assert.equal(q.pct.textContent,'-0.02%');
  q.d={...sample,priceSession:'PRE',ext:{pre:sample.ext.post}};H.render(q);
  assert.match(q.extRow.innerHTML,/较常规收盘 718.96/);assert.doesNotMatch(q.extRow.innerHTML,/class="regular-close"/);
});
await check('unknown or different bases still retain the regular-close reference',()=>{
  for(const ext of [{post:{price:717.54,change:-3.46,changePct:-.48}},{post:{price:717.54,change:null}},null]){
    q.d={...sample,ext};H.render(q);assert.match(q.extRow.innerHTML,/class="regular-close">常规时段收盘 718.96/);
  }
  q.d={...sample,regularPrice:718.975};H.render(q);assert.match(q.extRow.innerHTML,/class="regular-close"/,'different displayed cents retain the reference');
});
await check('footer describes the selected monitoring mode and retains source/time notes',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/推送优先.*时间均为 UTC\+8.*Alpaca.*Finnhub.*Naver \/ Yahoo \/ Nasdaq \/ 腾讯 \/ 东方财富 \/ 新浪 \/ Google News/);
  assert.doesNotMatch(html,/每\s*2s\s*自动刷新/);
});
assert.equal(cases.length,0,cases.length+' v64 frontend regression group(s) failed');
