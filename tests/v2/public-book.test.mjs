import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNasdaqBook,createNasdaqPublicBook} from '../../lib/providers/nasdaq-public-book.js';

// Explicitly synthetic source-shaped fixtures; these are not live market data.
const payload=(extra={})=>({status:{rCode:200},data:{symbol:'NVDA',assetClass:'STOCKS',marketStatus:'Open',primaryData:{
  bidPrice:'$100.10',askPrice:'$100.20',bidSize:'100',askSize:'1,200',currency:null,
  lastTradeTimestamp:'Oct 1, 2026 3:59 PM ET',isRealTime:true,...extra}}});
const now=Date.parse('2026-10-02T03:00:00Z'),options={symbol:'NVDA',assetClass:'stocks',now};
const empty=()=>payload({bidPrice:'N/A',askPrice:'N/A',bidSize:'N/A',askSize:'N/A'});

test('source book fields remain partial without a book timestamp, size unit, delay or venue guarantee',()=>{
  const value=parseNasdaqBook(payload(),options);
  assert.equal(value.bid.price,100.1);assert.equal(value.ask.size,1200);assert.equal(value.spread,.1);
  assert.equal(value.status,'partial');assert.equal(value.reason,'BOOK_TIME_UNAVAILABLE');
  assert.equal(value.asOf,null);assert.equal(value.checkedAt,now);assert.equal(value.delayMinutes,null);
  assert.equal(value.timeBasis,'source-snapshot-time-unavailable');assert.equal(value.sizeUnit,null);
  assert.equal(value.quality.includes('BOOK_SIZE_UNIT_UNVERIFIED'),true);
});

test('closed-market N/A, wrong identities, invalid prices and crossed books are explicit',()=>{
  assert.equal(parseNasdaqBook(empty(),options).reason,'PUBLIC_BOOK_EMPTY');
  assert.equal(parseNasdaqBook(payload(),{...options,symbol:'AMD'}).reason,'BOOK_IDENTITY_MISMATCH');
  assert.equal(parseNasdaqBook(payload(),{...options,assetClass:'etf'}).reason,'BOOK_IDENTITY_MISMATCH');
  assert.equal(parseNasdaqBook(payload({currency:'CAD'}),options).reason,'BOOK_IDENTITY_MISMATCH');
  assert.equal(parseNasdaqBook(payload({bidPrice:'0',askPrice:'100x'}),options).reason,'PUBLIC_BOOK_EMPTY');
  const crossed=parseNasdaqBook(payload({bidPrice:'101'}),options);
  assert.equal(crossed.reason,'CROSSED_BOOK');assert.equal(crossed.spread,null);
});

test('book requests share work and one abort leaves the other reader alive',async()=>{
  let calls=0,release;const provider=createNasdaqPublicBook({now:()=>now,httpsGet:async()=>{
    calls++;await new Promise(resolve=>{release=resolve;});return {status:200,body:JSON.stringify(payload())};}});
  const controller=new AbortController(),params={instrumentType:'EQUITY'};
  const a=provider.read('NVDA',{...params,signal:controller.signal}),b=provider.read('NVDA',params);
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(a);release();
  assert.equal((await b).bid.price,100.1);assert.equal(calls,1);
  assert.equal((await provider.read('NVDA',params)).bid.price,100.1);assert.equal(calls,1);provider.close();
});

test('expired book is immediately retained during refresh; N/A does not fabricate a fresh snapshot',async()=>{
  let clock=now,calls=0;const provider=createNasdaqPublicBook({now:()=>clock,httpsGet:async()=>({
    status:200,body:JSON.stringify(++calls===1?payload():empty())})});
  const params={instrumentType:'EQUITY'};await provider.read('NVDA',params);clock+=31000;
  const retained=await provider.read('NVDA',params);assert.equal(retained.stale,true);assert.equal(retained.checkedAt,now);
  await new Promise(resolve=>setImmediate(resolve));
  const latest=await provider.read('NVDA',params);assert.equal(latest.refreshReason,'PUBLIC_BOOK_EMPTY');
  assert.equal(latest.bid.price,100.1);assert.equal(latest.checkedAt,now);assert.equal(latest.lastAttemptAt,clock);
  assert.equal(calls,2);provider.close();
});

test('rate limits are cached with Retry-After and do not poison another symbol',async()=>{
  let clock=now,calls=0;const provider=createNasdaqPublicBook({now:()=>clock,httpsGet:async url=>{
    calls++;if(url.includes('/NVDA/'))return {status:429,headers:{'retry-after':'600'}};
    const data=payload();data.data.symbol='AMD';return {status:200,body:JSON.stringify(data)};}});
  const params={instrumentType:'EQUITY'};
  const rate=await provider.read('NVDA',params);assert.equal(rate.reason,'SOURCE_COOLDOWN');
  assert.equal(rate.retryAt,now+600000);clock+=310000;await provider.read('NVDA',params);assert.equal(calls,1);
  assert.equal((await provider.read('AMD',params)).bid.price,100.1);assert.equal(calls,2);provider.close();
});

test('unsupported instruments do not fetch and stopped requests cannot populate the cache',async()=>{
  let calls=0,release;const provider=createNasdaqPublicBook({now:()=>now,httpsGet:async()=>{
    calls++;await new Promise(resolve=>{release=resolve;});return {status:200,body:JSON.stringify(payload())};}});
  assert.equal((await provider.read('2330.TW',{instrumentType:'EQUITY',currency:'TWD'})).reason,'PUBLIC_BOOK_UNSUPPORTED');
  assert.equal((await provider.read('^SOX',{instrumentType:'INDEX'})).reason,'PUBLIC_BOOK_UNSUPPORTED');assert.equal(calls,0);
  const pending=provider.read('NVDA',{instrumentType:'EQUITY'});await new Promise(resolve=>setImmediate(resolve));
  provider.close();release();await assert.rejects(pending);assert.equal(provider.diagnostics().entries,0);
});

test('identity resolution that crosses shutdown cannot start new network work, even after reopen',async()=>{
  let calls=0,release;const provider=createNasdaqPublicBook({now:()=>now,
    resolveInstrument:()=>new Promise(resolve=>{release=()=>resolve({type:'EQUITY'});}),
    httpsGet:async()=>{calls++;return {status:200,body:JSON.stringify(payload())};}});
  const pending=provider.read('NVDA');provider.close();provider.reopen();release();
  assert.equal((await pending).reason,'PUBLIC_BOOK_UNAVAILABLE');assert.equal(calls,0);
  assert.equal(provider.diagnostics().entries,0);provider.close();
});
