import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const window={};
vm.runInNewContext(readFileSync(new URL('../../public/modules/panel-trade-direction.js',import.meta.url),'utf8'),{window});
const context={symbol:'NVDA',source:'nasdaq-public-trades',session:'regular',tradeDate:'2026-10-01'};
const trade=(at,price,extra={})=>({at,price,reportState:'reported',...extra});
const describe=(events,extra={})=>Array.from(window.PANEL_TRADE_DIRECTION.describe(events,{...context,...extra}));

test('describes chronological price changes without calling them buys or sells and preserves input order',()=>{
  const events=[trade(5000,102),trade(1000,100),trade(3000,102),trade(2000,104)],before=JSON.stringify(events);
  const result=describe(events);
  assert.deepEqual(result.map(x=>x.label),['平价','未知','跌价','涨价']);
  assert.equal(result[0].basis,'adjacent-price');assert.equal(result[0].inferred,true);
  assert.equal(JSON.stringify(events),before);
});

test('only explicitly verified aggressor sides get buy and sell labels',()=>{
  const result=describe([trade(1000,100,{side:'buy'}),trade(2000,101,{aggressorSide:'sell'}),
    trade(3000,102,{aggressorSide:'sell',aggressorSideVerified:true}),
    trade(4000,99,{aggressorSide:'buy',aggressorSideVerified:true})]);
  assert.deepEqual(result.map(x=>x.label),['未知','涨价','主动卖出','主动买入']);
  assert.equal(result[2].inferred,false);assert.equal(result[2].basis,'source-reported-aggressor');
});

test('equal timestamps have no inferred direction or usable next-print baseline',()=>{
  const result=describe([trade(1000,100),trade(2000,101),trade(2000,102),trade(3000,103),trade(4000,104)]);
  assert.deepEqual(result.map(x=>x.direction),['unknown','unknown','unknown','unknown','up']);
  assert.equal(result[1].reason,'SAME_TIMESTAMP_ORDER_UNKNOWN');
  const verified=describe([trade(1000,100,{aggressorSide:'buy',aggressorSideVerified:true}),trade(1000,101)]);
  assert.equal(verified[0].direction,'buy');assert.equal(verified[1].direction,'unknown');
});

test('different symbol, source, session, or date never supplies the prior trade',()=>{
  for(const extra of [{symbol:'AMD'},{source:'finnhub'},{session:'post'},{tradeDate:'2026-09-30'}]){
    const result=describe([trade(1000,100),trade(2000,101,extra)]);
    assert.deepEqual(result.map(x=>x.direction),['unknown','unknown']);
  }
  assert.equal(describe([trade(1000,100),trade(2000,101)],{tradeDate:null})[1].reason,'IDENTITY_UNVERIFIED');
});

test('cancelled and corrected trades do not influence inferred prices or get aggressor labels',()=>{
  const result=describe([trade(1000,100),trade(2000,200,{reportState:'cancelled',aggressorSide:'buy',aggressorSideVerified:true}),
    trade(3000,300,{reportState:'corrected'}),trade(4000,101)]);
  assert.deepEqual(result.map(x=>x.direction),['unknown','unknown','unknown','up']);
  assert.equal(result[1].reason,'INVALIDATED_TRADE');
});

test('invalid prices and timestamps are excluded and no identity means no price inference',()=>{
  const result=describe([trade(1000,100),trade(2000,NaN),trade(-1,300),trade(4000,101)]);
  assert.deepEqual(result.map(x=>x.direction),['unknown','unknown','unknown','up']);
  assert.equal(result[1].reason,'INVALID_TRADE');
  assert.deepEqual(Array.from(window.PANEL_TRADE_DIRECTION.describe(null)),[]);
});
