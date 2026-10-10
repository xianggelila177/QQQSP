import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {publishQuote} from '../../lib/quote-contract.js';

const NOW=Date.parse('2026-09-30T20:01:00Z');
const OPEN=Date.parse('2026-09-30T13:30:00Z');
function fixture(){
 const bars=Array.from({length:390},(_,i)=>({t:OPEN/1000+i*60,o:100,h:102,l:99,c:101,v:100}));
 return publishQuote({symbol:'NVDA',currency:'USD',instrumentType:'EQUITY',src:'fixture',price:110,
  quoteAt:NOW-60000,sourceCheckedAt:NOW,
  regularChart:{symbol:'NVDA',currency:'USD',status:'ready',source:'fixture',sourceCheckedAt:NOW,
   targetDate:'2026-09-30',tradeDate:'2026-09-30',adjustmentBasis:'raw',pointKind:'bar-start',intervalSeconds:60,
   regularSessions:[{open_at_ms:OPEN,close_at_ms:OPEN+390*60000}],bars,
   previousCloseReference:{value:100,tradeDate:'2026-09-29',status:'source-dated',source:'fixture'}}});
}
function older(seed,chart=seed.regularChart,extra={}){
 return {...seed,price:100,quoteAt:seed.quoteAt-60000,
  regularChart:{...chart,regularSessions:chart.regularSessions?.map(s=>({...s})),
   previousCloseReference:chart.previousCloseReference&&{...chart.previousCloseReference}},...extra};
}
async function engineHarness(t,seed=fixture()){
 let candidate=seed,clock=NOW;
 const engine=createQuoteEngine({readQuote:async()=>candidate,now:()=>clock,tickMs:3600000});
 engine.start();engine.watch(['NVDA']);t.after(()=>engine.stop());
 await engine.refreshNow(['NVDA']);
 return {engine,seed,async refresh(value,at=clock){candidate=value;clock=at;return (await engine.refreshNow(['NVDA']))[0];}};
}
async function countDateFormats(fn,bars){
 const original=Intl.DateTimeFormat.prototype.formatToParts;let count=0;
 // Count candle-date work, excluding the constant current-clock evaluation
 // that publishes quote freshness/session transitions independently of bars.
 const dates=new Set(bars.map(bar=>bar.t*1000));
 Intl.DateTimeFormat.prototype.formatToParts=function(...args){if(dates.has(Number(args[0])))count++;return original.apply(this,args);};
 try{await fn();return count;}finally{Intl.DateTimeFormat.prototype.formatToParts=original;}
}

test('late QuoteEngine reads retain unchanged immutable history without repeating per-bar date conversion',async t=>{
 const {seed,refresh}=await engineHarness(t);
 const count=await countDateFormats(async()=>{
  for(let i=0;i<3;i++){
   const value=await refresh(older(seed),NOW+i*1000);
   assert.equal(value.price,seed.price);assert.equal(value.quoteAt,seed.quoteAt);
   assert.strictEqual(value.regularChart,seed.regularChart);
  }
 },seed.regularChart.bars);
 assert.equal(count,0,'already retained immutable chart should not reformat its 390 bar dates on every read');
});

test('late QuoteEngine reads still accept corrected bars and independently changed chart metadata',async t=>{
 const cases=[
  ['bar correction',chart=>({...chart,bars:Object.freeze(chart.bars.map((b,i)=>i===0?Object.freeze({...b,h:103}):b))}),value=>assert.equal(value.bars[0].h,103)],
  ['source check',chart=>({...chart,sourceCheckedAt:NOW+1000}),value=>assert.equal(value.sourceCheckedAt,NOW+1000)],
  ['previous close',chart=>({...chart,previousCloseReference:{...chart.previousCloseReference,value:98}}),value=>assert.equal(value.previousCloseReference.value,98)],
  ['source metadata',chart=>({...chart,source:'verified-alternate',status:'partial',missingReason:'SOURCE_PARTIAL'}),value=>assert.equal(value.source,'verified-alternate')],
 ];
 for(const [name,change,verify] of cases)await t.test(name,async t=>{
  const {seed,refresh}=await engineHarness(t),candidate=older(seed,change(seed.regularChart));
  const value=await refresh(candidate);
  assert.equal(value.price,seed.price);assert.equal(value.quoteAt,seed.quoteAt);
  assert.strictEqual(value.regularChart,candidate.regularChart);verify(value.regularChart);
 });
});

test('unchanged bar identity never bypasses changed identity, time, adjustment, coverage or session checks',async t=>{
 const cases=[
  ['outer symbol',(seed,chart)=>older(seed,chart,{symbol:'AAPL'})],
  ['outer currency',(seed,chart)=>older(seed,chart,{currency:'TWD'})],
  ['instrument type',(seed,chart)=>older(seed,chart,{instrumentType:'ETF'})],
  ['chart symbol',(seed,chart)=>older(seed,{...chart,symbol:'AAPL'})],
  ['chart currency',(seed,chart)=>older(seed,{...chart,currency:'TWD'})],
  ['adjustment basis',(seed,chart)=>older(seed,{...chart,adjustmentBasis:'split-adjusted'})],
  ['older source check',(seed,chart)=>older(seed,{...chart,sourceCheckedAt:NOW-1})],
  ['future source check',(seed,chart)=>older(seed,{...chart,sourceCheckedAt:NOW+5001})],
  ['coverage regression with same timestamps',(seed,chart)=>older(seed,{...chart,intervalSeconds:30})],
  ['shortened session',(seed,chart)=>older(seed,{...chart,regularSessions:[{open_at_ms:OPEN,close_at_ms:OPEN+60000}]})],
  ['different trading day',(seed,chart)=>older(seed,{...chart,targetDate:'2026-10-01',tradeDate:'2026-10-01'})],
  ['stale source',(seed,chart)=>older(seed,{...chart,stale:true})],
  ['failed source',(seed,chart)=>older(seed,{...chart,error:'unavailable'})],
  ['invalid OHLC',(seed,chart)=>older(seed,{...chart,bars:Object.freeze(chart.bars.map((b,i)=>i===0?Object.freeze({...b,h:1}):b))})],
  ['missing observations',(seed,chart)=>older(seed,{...chart,bars:Object.freeze(chart.bars.slice(1))})],
 ];
 for(const [name,change] of cases)await t.test(name,async t=>{
  const {seed,refresh}=await engineHarness(t),value=await refresh(change(seed,seed.regularChart));
  assert.equal(value.price,seed.price);assert.equal(value.quoteAt,seed.quoteAt);
  assert.strictEqual(value.regularChart,seed.regularChart);
 });
});

test('clock changes and a new trading session still evaluate current chart constraints',async t=>{
 const {seed,refresh}=await engineHarness(t);
 // The price is still in the past after a clock correction, but the unchanged
 // source-check timestamp is now in the future. Changed metadata must not enter.
 const future=older(seed,{...seed.regularChart,previousCloseReference:{...seed.regularChart.previousCloseReference,value:97}});
 assert.strictEqual((await refresh(future,NOW-6000)).regularChart,seed.regularChart);
 const shift=86400000,nextChart={...seed.regularChart,targetDate:'2026-10-01',tradeDate:'2026-10-01',sourceCheckedAt:NOW+shift,
  bars:Object.freeze(seed.regularChart.bars.map(b=>Object.freeze({...b,t:b.t+shift/1000}))),
  regularSessions:seed.regularChart.regularSessions.map(s=>({open_at_ms:s.open_at_ms+shift,close_at_ms:s.close_at_ms+shift}))};
 const candidate=older(seed,nextChart),value=await refresh(candidate,NOW+shift);
 assert.strictEqual(value.regularChart,candidate.regularChart);assert.equal(value.price,seed.price);
});

test('frozen arrays containing mutable candles still use normal validation',async t=>{
 const frozen=fixture(),seed={...frozen,regularChart:{...frozen.regularChart,bars:Object.freeze(frozen.regularChart.bars.map(b=>({...b})))}};
 const {refresh}=await engineHarness(t,seed);
 const count=await countDateFormats(()=>refresh(older(seed)),seed.regularChart.bars);
 assert.equal(count,390);
});
