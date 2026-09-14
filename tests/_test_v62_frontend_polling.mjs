import assert from 'node:assert/strict';
import {loadApp} from './_harness.mjs';
const quote=(symbol,marketState='CLOSED')=>({symbol,price:100,currency:'USD',marketState,quoteAt:Date.now(),sourceCheckedAt:Date.now(),pollAfterMs:marketState==='CLOSED'?70000:2000,charts:{intraday:[]}});
async function scenario({hidden=false,mode=null,quotes=[quote('QQQ')],expected}){
  const env=await loadApp({watchlist:quotes.map(q=>q.symbol),initialMarket:quotes,hidden,refreshMode:mode,fakeWorker:true});await env.drain();const h=env.hooks();
  assert.equal(h.refreshModeRef(),mode||'economy');
  const initial=env.countFetch('/api/market');for(let i=0;i<65;i++)env.fetch.push('market',{body:quotes});
  for(let i=0;i<120;i++){h.onBeat();await env.drain();}
  assert.equal(env.countFetch('/api/market')-initial,expected);
  return env;
}
await scenario({expected:1});
const economy=await scenario({hidden:true,expected:1});
await scenario({quotes:[quote('QQQ','REGULAR')],expected:60});
await scenario({quotes:[quote('QQQ'),quote('SPY','REGULAR')],expected:60});
await scenario({hidden:true,quotes:[quote('QQQ','REGULAR')],expected:8});
const continuous=await scenario({mode:'continuous',hidden:true,expected:60});
assert.equal(continuous.sandbox.localStorage.getItem('qqq-refresh-mode'),'continuous');
continuous.doc.hidden=false;continuous.fireDoc('visibilitychange');await continuous.drain();assert.equal(continuous.hooks().refreshModeRef(),'continuous','visibility does not overwrite desired mode');
const before=economy.countFetch('/api/market');economy.doc.hidden=false;economy.fireDoc('visibilitychange');await economy.drain();assert.equal(economy.countFetch('/api/market'),before+1,'foreground immediately catches up');
assert.equal(economy.hooks().watchdogTick(economy.hooks().lastRefreshRef()+31000),'ok','watchdog respects planned closed cadence');
const retry=await loadApp({watchlist:['QQQ'],initialMarket:[quote('QQQ','REGULAR')]});await retry.drain();retry.fetch.push('market',{status:429,headers:{'Retry-After':'60'}});await retry.hooks().refresh(false);const requestCount=retry.countFetch('/api/market');
for(let i=0;i<20;i++){retry.hooks().onBeat();await retry.drain();}assert.equal(retry.countFetch('/api/market'),requestCount,'cadence continues to honor HTTP retry budget');
console.log('PASS v62 120-beat default/economy/continuous polling across open, mixed and closed sessions; foreground, preference and retry budget');
