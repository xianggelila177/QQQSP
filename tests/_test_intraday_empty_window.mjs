import assert from 'node:assert/strict';
import {createQuoteService} from '../lib/quote.js';
import {extSessions} from '../lib/sessions.js';
const now=Date.parse('2026-09-08T05:16:00Z'),sec=iso=>Date.parse(iso)/1000;
const previous=sec('2026-09-07T15:25:00Z'),prior=sec('2026-09-04T15:25:00Z');
const chart=(symbol,times,closes,meta={})=>({meta:{symbol,currency:'EUR',regularMarketPrice:210,regularMarketTime:previous+60,instrumentType:'EQUITY',...meta},timestamp:times,indicators:{quote:[{open:closes,high:closes,low:closes,close:closes,volume:closes.map(()=>10)}]}});
async function run({symbol='SAP.DE',first=chart(symbol,[],[]),history=chart(symbol,[prior,previous,previous+300,now/1000+60],[100,200,null,999],{regularMarketPrice:100}),error,clock=now}={}){
 const calls=[];
 const service=createQuoteService({now:()=>clock,extSessions,providers:{fetchChart:async(s,query)=>{calls.push(query);if(calls.length===1)return first;if(error)throw error;return history;},getDayOhlc:async()=>({prevClose:199}),getFxRates:async()=>({USD:7,EUR:.9}),getNasdaqDaily:async()=>[],getYahooDaily:async()=>[{t:prior,c:199}]}});
 try{return {quote:await service.fetchQuote(symbol),calls};}finally{service.close();}
}
const fallback=await run();
assert.deepEqual(fallback.quote.charts.intraday,[{t:previous,c:200,v:10}],'only latest valid nonfuture local day from real intraday bars');
assert.equal(fallback.calls.length,2);assert.match(fallback.calls[1],/range=5d/);
assert.equal(fallback.quote.price,210,'newer 1d meta price preserved');
assert.equal(fallback.quote.quoteAt,(previous+60)*1000);
assert.equal(fallback.quote.slowFields.intraday.stale,false);
assert.equal(fallback.quote.charts.intraday[0].t,previous,'source observation time never advances to check time');
const normal=await run({first:chart('SAP.DE',[previous],[205])});assert.equal(normal.calls.length,1);assert.equal(normal.quote.charts.intraday[0].c,205);
for(const options of [{error:new Error('429')},{history:chart('SAP.DE',[],[])},{history:chart('OTHER.DE',[previous],[999])}]){
 const result=await run(options);assert.equal(result.calls.length,2);assert.equal(result.quote.charts.intraday.length,0);assert.equal(result.quote.slowFields.intraday.stale,true);
}
for(const options of [{error:new Error('unavailable')},{history:chart('SAP.DE',[],[])}]){
 const invalid=await run({...options,first:chart('SAP.DE',[now/1000+60,previous,previous-300],[999,0,NaN])});
 assert.equal(invalid.quote.charts.intraday.length,0,'invalid original points cannot survive failed recovery');
 assert.equal(invalid.quote.slowFields.intraday.stale,true);
 assert.equal(invalid.quote.price,210,'invalid future price must not overwrite source metadata');
}
// London DST changes within a 5-day window. A static +01 offset would wrongly
// group Oct26 23:30 with Oct27, while IANA places it on the preceding local day.
const londonNow=Date.parse('2026-10-27T08:00:00Z'),late=sec('2026-10-26T23:30:00Z'),next=sec('2026-10-27T00:10:00Z');
const dst=await run({symbol:'VOD.L',clock:londonNow,first:chart('VOD.L',[],[],{gmtoffset:3600}),history:chart('VOD.L',[late,next],[123,124],{gmtoffset:3600})});
assert.deepEqual(dst.quote.charts.intraday.map(p=>p.t),[next]);
console.log('PASS bounded empty-window intraday recovery, local date/DST, metadata and source failure');
