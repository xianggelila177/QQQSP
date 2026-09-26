import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNasdaqTrades,createNasdaqPublicTrades} from '../../lib/providers/nasdaq-public-trades.js';
import {createChartDetailService} from '../../lib/chart-detail-service.js';

const now=Date.parse('2026-09-26T02:00:00Z');
const row=(time='19:59:59',price='$122.95',shareVolume='32')=>({time,price,shareVolume});
const payload=(rows=[row(),row()],label='Sep 25, 2026 08:00 PM ET',session='post')=>({status:{rCode:200},data:{
 lastUpdateInfo:['Data last updated '+label+'.','This page will resume updating on Sep 28, 2026 04:00 PM ET.'],
 tradeDetailTable:{headers:{time:(session==='post'?'After Hours':'Pre-Market')+' Time (ET)',price:'Price',shareVolume:'Share Volume'},rows}}});
const options={symbol:'INTC',session:'post',tradeDate:'2026-09-25',now};

test('public snapshot keeps duplicate-looking prints, explicit date, seconds and incomplete coverage',()=>{
 const d=parseNasdaqTrades(payload(),options);
 assert.equal(d.events.length,2);assert.equal(d.events[0].at,Date.parse('2026-09-25T23:59:59Z'));
 assert.equal(d.events[0].eventId,null);assert.equal(d.events[0].size,32);assert.equal(d.coverage.complete,false);
 assert.equal(d.delayMinutes,null);assert.equal(d.status,'partial');
 const ordered=parseNasdaqTrades(payload([row('19:59:59','$122.9478'),row('19:59:59','$122.95')]),options);
 assert.equal(ordered.events.at(-1).price,122.9478,'latest-first UI preserves source order within a second');
 const winter=parseNasdaqTrades(payload([row()],'Jan 5, 2026 08:00 PM ET'),{...options,tradeDate:'2026-01-05'});
 assert.equal(winter.events[0].at,Date.parse('2026-01-06T00:59:59Z'));
});

test('reject missing source dates, wrong dates, future time, invalid shares and crossed session boundaries',()=>{
 const noDate=payload();noDate.data.lastUpdateInfo=['This page will resume updating on Sep 28, 2026 04:00 PM ET.'];
 assert.equal(parseNasdaqTrades(noDate,options).reason,'SOURCE_DATE_MISSING');
 assert.equal(parseNasdaqTrades(payload(),{...options,tradeDate:'2026-09-24'}).reason,'SOURCE_DATE_MISMATCH');
 assert.equal(parseNasdaqTrades(payload(),{...options,now:now-86400000}).reason,'SOURCE_TIME_INVALID');
 const d=parseNasdaqTrades(payload([row('16:00:00'),row('15:59:59'),row('20:00:00'),row('19:59:59','$1','1.5'),row()]),options);
 assert.equal(d.events.length,1);assert.equal(d.rejectedRows,4);
 const pre=parseNasdaqTrades(payload([row('09:30:00'),row('09:29:59')],'Sep 25, 2026 09:30 AM ET','pre'),{...options,session:'pre'});
 assert.equal(pre.events.length,1);assert.equal(pre.events[0].at,Date.parse('2026-09-25T13:29:59Z'));
});

test('polling replaces bounded windows, shares requests and respects cancellation and per-symbol cooldown',async()=>{
 let clock=now,calls=0,release;
 const provider=createNasdaqPublicTrades({now:()=>clock,httpsGet:async url=>{
  calls++;if(url.includes('/LITE/'))return {status:429,headers:{'retry-after':'600'}};
  await new Promise(r=>{release=r;});return {status:200,body:JSON.stringify(payload())};
 }});
 const a=new AbortController(),params={session:'post',tradeDate:options.tradeDate};
 const first=provider.read('INTC',{...params,signal:a.signal});
 const second=provider.read('INTC',params);await new Promise(r=>setImmediate(r));a.abort();
 await assert.rejects(first);release();assert.equal((await second).events.length,2);assert.equal(calls,1);
 assert.equal((await provider.read('INTC',params)).events.length,2);assert.equal(calls,1);
 const limited=await provider.read('LITE',params);assert.equal(limited.retryAt,now+600000);
 await provider.read('LITE',params);assert.equal(calls,2);
 clock+=300001;const next=provider.read('INTC',params);await new Promise(r=>setImmediate(r));release();
 assert.equal((await next).events.length,2);assert.equal(calls,3);
 assert.equal((await provider.read('^SOX',params)).reason,'PUBLIC_TRADES_UNSUPPORTED');
 provider.close();
});

test('public tape works with no stream credentials and never adds overlapping stream trades',async()=>{
 const calls=[],quote={symbol:'INTC',currency:'USD',priceSession:'POST',quoteTradeDate:'2026-09-25',
  regularChart:{tradeDate:'2026-09-25',bars:[{c:123}]}};
 const publicTape={read:async(symbol,args)=>{calls.push(args);return parseNasdaqTrades(payload(),{...options,session:args.session});}};
 const service=createChartDetailService({readQuote:()=>quote,publicTape,now:()=>now,
  tape:{snapshot:()=>({status:'partial',events:[{price:99}],coverage:{scope:'received-stream-fragment'}})}});
 const auto=await service.read('INTC');assert.equal(auto.tape.session,'post');assert.equal(auto.tape.events.length,2);
 assert.equal(auto.chart.bars[0].c,123);assert.equal(calls[0].tradeDate,'2026-09-25');
 assert.equal(auto.capabilities.tape,'public-trade-window');
 const standalone=createChartDetailService({readQuote:()=>quote,publicTape,now:()=>now});
 assert.equal((await standalone.read('INTC')).tape.events.length,2);
 const overlap=createChartDetailService({readQuote:()=>({...quote,priceSession:'REGULAR'}),now:()=>now,
  publicTape:{read:async()=>({...parseNasdaqTrades(payload(),options),session:'regular'})},
  tape:{snapshot:()=>({events:[{price:122.95,size:32}],coverage:{scope:'received-stream-fragment'}})}});
 assert.equal((await overlap.read('INTC')).tape.events.length,2);
 const unavailable=createChartDetailService({readQuote:()=>quote,publicTape:{read:async()=>({events:[],reason:'PUBLIC_TRADES_EMPTY'})},
  tape:{snapshot:()=>({status:'partial',events:[{price:99}],coverage:{scope:'received-stream-fragment'}})},now:()=>now});
 assert.equal((await unavailable.read('INTC',{tapeSession:'regular'})).tape.events.length,1);
});

test('closing one five-day reader does not cancel another reader or its public tape',async()=>{
 let release,upstreamSignal;
 const service=createChartDetailService({readQuote:()=>({symbol:'INTC',currency:'USD'}),now:()=>now,
  publicTape:{read:async()=>parseNasdaqTrades(payload(),options)},
  fetchChart:async(symbol,query,{signal})=>{
   upstreamSignal=signal;await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason));});
   return {meta:{symbol,currency:'USD',dataGranularity:'5m'},timestamp:[],indicators:{quote:[{}]}};
  }});
 const controller=new AbortController();
 const first=service.read('INTC',{range:'5d',signal:controller.signal});
 const second=service.read('INTC',{range:'5d'});await new Promise(r=>setImmediate(r));
 controller.abort();await assert.rejects(first);assert.equal(upstreamSignal.aborted,false);release();
 assert.equal((await second).tape.events.length,2);
});
