import assert from 'node:assert/strict';
import { createQuoteService } from '../lib/quote.js';
import { extSessions } from '../lib/sessions.js';
import { createRecoveryStore } from '../lib/recovery-store.js';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const now=Date.parse('2026-09-08T12:00:00Z'),time=now/1000;
let symbol='VOD.L',currency='GBp',declaredDelay;
const fxMap={USD:7,GBP:.8,ZAR:18};
const service=createQuoteService({now:()=>now,extSessions,fxMetadata:()=>({fxStale:false,fxAsOf:now}),providers:{
 fetchChart:async()=>({meta:{symbol,currency,regularMarketPrice:1000,regularMarketVolume:123,regularMarketTime:time,instrumentType:symbol.startsWith('^')?'INDEX':'EQUITY',exchangeDataDelayedBy:declaredDelay},timestamp:[time],indicators:{quote:[{open:[990],high:[1010],low:[980],close:[1000],volume:[123]}]}}),
 getDayOhlc:async()=>({open:990,high:1010,low:980,prevClose:900}),getFxRates:async()=>fxMap,getNasdaqDaily:async()=>[],getYahooDaily:async()=>[{t:time,o:990,h:1010,l:980,c:1000,v:123}],
}});
const quote=await service.fetchQuote(symbol);assert.equal(quote.currency,'GBp');assert.equal(quote.price,1000);assert.equal(quote.change,100);assert.equal(quote.volume,quote.marketState==='UNKNOWN'?null:123);assert.equal(quote.charts.intraday[0].v,123);assert.equal(quote.charts.intraday[0].c,1000);assert.equal(quote.currency2cny,.08750000000000001);assert.equal(quote.feedDelayMinutes,20);assert.equal(quote.feedDelaySource,'yahoo-documentation');
declaredDelay=5;assert.equal((await service.fetchQuote(symbol)).feedDelayMinutes,5);declaredDelay=undefined;
symbol='^FTSE';currency='GBP';const index=await service.fetchQuote(symbol);assert.equal(index.instrumentType,'INDEX');assert.equal(index.currency2cny,null);assert.equal(index.feedDelayMinutes,15);
symbol='^GDAXI';assert.equal((await service.fetchQuote(symbol)).feedDelayMinutes,null,'unlisted index delay stays unknown');
symbol='NIFTYBEES.NS';currency='INR';assert.equal((await service.fetchQuote(symbol)).instrumentTypeSource,'catalog');
await assert.rejects(service.fetchQuote('RELIANCE.NS'),/identity/i);
const dir=mkdtempSync(path.join(tmpdir(),'global-quote-'));try{
 const filePath=path.join(dir,'quotes.json'),store=createRecoveryStore({filePath,now:()=>now});store.load();assert.equal(store.remember({...quote,symbol:'M&M.NS',instrumentTypeSource:'catalog',calendarCoverage:{known:false,pending:true,note:'time pending'}}),true);await store.flush();const restored=createRecoveryStore({filePath,now:()=>now});restored.load();const old=restored.get('M&M.NS');assert.equal(old.currency,'GBp');assert.equal(old.price,1000);assert.equal(old.feedDelaySource,'yahoo-documentation');assert.equal(old.calendarCoverage.pending,true);assert.equal(old.instrumentTypeSource,'catalog');
}finally{rmSync(dir,{recursive:true,force:true});service.close();}
console.log('PASS quote raw units, catalogue types, delay evidence, identity and recovery');
