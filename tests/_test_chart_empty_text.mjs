// Verify actual rendered empty states, without depending on function locations.
import assert from 'node:assert/strict';
import {loadApp} from './_harness.mjs';
const env=await loadApp({watchlist:['QQQ']});await env.drain();
for(const src of ['tx-us','tx-cn','yahoo',undefined]){
 env.fetch.push('market',{body:[{symbol:'QQQ',src,price:100,currency:'USD',instrumentType:'ETF',ts:Date.now(),marketState:'CLOSED',charts:{intraday:[],daily30:[]}}]});
 await env.hooks().refresh(false);
 const card=env.hooks().cardCache.get('QQQ');
 assert.equal(card.ohlc.textContent,src?.startsWith('tx-')?'分时暂不可用 · 请查看报价时间':'暂无数据');
 assert.doesNotMatch(card.ohlc.textContent,/价格仍实时/);
 card.tf='daily30';env.hooks().render(card);assert.equal(card.ohlc.textContent,'日K暂缺');
 card.tf='intraday';
}
console.log('PASS empty intraday/daily views do not assert unavailable realtime prices');
