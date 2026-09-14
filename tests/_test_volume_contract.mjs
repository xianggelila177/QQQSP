import assert from 'node:assert/strict';
import {test} from 'node:test';
import {barsFrom} from '../lib/yahoo.js';
import {createQuoteService} from '../lib/quote.js';
import {extSessions} from '../lib/sessions.js';
import {publishQuote} from '../lib/quote-contract.js';
import {createTencentProvider} from '../lib/providers/tx.js';

const payload='<img src=x onerror=globalThis.fixtureExecuted=true>';
const at=Date.parse('2026-09-04T17:00:00-04:00')/1000;
const chart=volume=>({meta:{symbol:'QQQ',currency:'USD',gmtoffset:-14400,regularMarketPrice:100,regularMarketTime:at-3600,regularMarketVolume:payload},timestamp:[at,at+300],indicators:{quote:[{open:[100,101],high:[101,102],low:[99,100],close:[100,101],volume}]}});
test('Yahoo bars normalize malformed/unknown volume while preserving genuine zero',()=>{
  for(const value of [payload,'12<img>',null,undefined,'',-1,Infinity,NaN,true,{}])assert.equal(barsFrom(chart([value,0]))[0].v,null,String(value));
  assert.equal(barsFrom(chart([0,'123']))[0].v,0);assert.equal(barsFrom(chart([0,'123']))[1].v,123);
});
test('session aggregate is unknown when any component volume is malformed or missing',()=>{
  for(const value of [payload,null,undefined,-1,Infinity]){
    const result=extSessions([{t:at,o:100,h:101,l:99,c:100,v:10},{t:at+300,o:100,h:101,l:99,c:100,v:value}],{symbol:'QQQ',gmtoffset:-14400},99);
    assert.equal(result.post.volume,null,String(value));
  }
  assert.equal(extSessions([{t:at,c:100,v:'10'},{t:at+300,c:100,v:'20'}],{symbol:'QQQ',gmtoffset:-14400},99).post.volume,30);
  assert.equal(extSessions([{t:at,c:100,v:0}],{symbol:'QQQ',gmtoffset:-14400},99).post.volume,0);
});
test('Yahoo published quote and extended session reject provider markup through every volume route',async()=>{
  const service=createQuoteService({now:()=>Date.parse('2026-09-04T18:00:00-04:00'),extSessions,providers:{fetchChart:async()=>chart([10,payload]),getDayOhlc:async()=>({prevClose:99}),getFxRates:async()=>({}),getNasdaqDaily:async()=>[],getYahooDaily:async()=>[{t:at,c:101,v:payload}]}});
  const q=await service.fetchQuote('QQQ');assert.equal(q.volume,null);assert.equal(q.ext.post.volume,null);assert.equal(q.charts.intraday[1].v,null);assert.equal(q.charts.daily30[0].v,null);assert.doesNotMatch(JSON.stringify(q),/onerror|<img/);
});
test('publication boundary normalizes even pre-frozen provider charts without mutating originals',()=>{
  const bars=Object.freeze([Object.freeze({t:1,c:1,v:payload}),Object.freeze({t:2,c:1})]);
  const source={symbol:'QQQ',price:1,volume:payload,charts:{daily30:bars},ext:{post:{price:1,volume:payload},pre:{price:1,volume:'25'}}};
  const q=publishQuote(source);assert.equal(q.volume,null);assert.equal(q.ext.post.volume,null);assert.equal(q.ext.pre.volume,25);assert.equal(q.charts.daily30[0].v,null);assert.equal(q.charts.daily30[1].v,null);assert.equal(source.charts.daily30[0].v,payload);assert.ok(Object.isFrozen(q.charts.daily30));
  assert.equal(publishQuote(q).charts.daily30,q.charts.daily30,'already normalized charts preserve memoization identity');
});
test('Tencent missing cumulative volumes stay unavailable and never become invented zero',async()=>{
  const tx=createTencentProvider({httpsGet:async()=>({status:200,body:JSON.stringify({data:{sh000001:{data:{date:'20260904',data:['0930 10 100','0931 10 bad','0932 10 150','0933 10 160']}}}})})});
  assert.deepEqual((await tx.txMinuteBarsCn('000001.SS')).map(x=>x.v),[100,null,null,10]);
});
test('Naver volume rejects coercible arrays and objects while preserving numeric comma formatting',async()=>{
  const {createBatchProvider}=await import('../lib/providers/batch-snapshot.js');
  const provider=createBatchProvider();
  const row={symbolCode:'QQQ',stockName:'QQQ',stockExchangeType:{code:'NSQ',nameEng:'NASDAQ',nationType:'USA'},closePrice:'100',localTradedAt:'2026-09-04T16:00:00-04:00',currencyType:{code:'USD'}};
  for(const value of [[0],[123],[[0]],{},true,payload])assert.equal(provider.parseNaverQuote({...row,accumulatedTradingVolumeRaw:value},'QQQ',70000).volume,null);
  assert.equal(provider.parseNaverQuote({...row,accumulatedTradingVolumeRaw:'1,234'},'QQQ',70000).volume,1234);
});
