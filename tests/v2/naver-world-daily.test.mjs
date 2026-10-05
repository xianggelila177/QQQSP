import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNaverWorldDailyHistory,parseNaverWorldDaily} from '../../lib/providers/naver-world-daily.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {localDateAt,addDays} from '../../lib/history-contract.js';

const live=JSON.parse(readFileSync(new URL('../fixtures/naver-world-daily-2020.json',import.meta.url),'utf8'));
const at=Date.parse('2026-10-05T02:00:00Z');
const identity=symbol=>({code:symbol+'.O',exchange:'NSQ',instrumentType:symbol==='QQQ'?'ETF':'EQUITY',provenance:'naver-search'});
const query=(from,through)=>'?interval=1d&period1='+Date.parse(from+'T00:00:00Z')/1000+'&period2='+Date.parse(addDays(through,1)+'T00:00:00Z')/1000;
// Synthetic edge rows are explicit; the 2020 fixture above is a real response.
const row=date=>({localDate:date.replaceAll('-',''),openPrice:100,highPrice:110,lowPrice:90,closePrice:105,accumulatedTradingVolume:1001});
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function harness({basic,reply,clock=()=>at,...options}={}){
  const calls=[];let invalidations=0;
  const provider=createNaverWorldDailyHistory({now:clock,resolveCode:async symbol=>identity(symbol),invalidateIdentity:()=>invalidations++,
    httpsGet:async(url,headers,request)=>{calls.push({url,headers,request});const code=new URL(url).pathname.split('/').at(-2),symbol=code.split('.')[0];
      if(url.endsWith('/basic'))return {status:200,body:JSON.stringify(basic||live.items.find(v=>v.symbol===symbol).basic)};
      return reply?reply(url,request):{status:200,body:JSON.stringify(live.items.find(v=>v.symbol===symbol).rows)};},...options});
  return {provider,calls,invalidations:()=>invalidations};
}

test('real Naver 2020 daily fixtures retain 253 local-date OHLC rows for NVDA and QQQ with explicit unverified metadata',async()=>{
  for(const sample of live.items){
    const h=harness();try{
      const result=await h.provider(sample.symbol,query('2020-01-01','2020-12-31'),{priority:'history'});
      assert.equal(result.source,'naver-world-daily');assert.equal(result.timestamp.length,253);
      assert.equal(localDateAt(result.timestamp[0]*1000,'America/New_York'),'2020-01-02');
      assert.equal(localDateAt(result.timestamp.at(-1)*1000,'America/New_York'),'2020-12-31');
      assert.equal(result.indicators.quote[0].close[0],sample.rows[0].closePrice);
      assert.ok(result.indicators.quote[0].volume.every(v=>v===null));assert.equal(result.sourceVolumes[0].value,sample.rows[0].accumulatedTradingVolume);
      assert.equal(result.meta.instrumentType,sample.symbol==='QQQ'?'ETF':'EQUITY');assert.equal(result.meta.currency,'USD');assert.equal(result.meta.exchangeTimezoneName,'America/New_York');
      assert.equal(result.adjustment,'source-default-unverified');assert.equal(result.coverage.status,'unknown');assert.equal(result.coverage.originProven,false);
      assert.equal(result.hasMore,false);assert.equal(result.retrievalLimited,false);assert.ok(h.calls.every(v=>v.request.priority==='history'));
    }finally{h.provider.close();}
  }
});

test('ten-year pages respect the requested through and before cursor, and cache distinct ranges without refreshing source time',async()=>{
  let clock=at;const h=harness({clock:()=>clock,reply:async url=>{const p=new URL(url).searchParams;return {status:200,body:JSON.stringify([row(p.get('startDateTime').slice(0,8).replace(/(\d{4})(\d\d)(\d\d)/,'$1-$2-$3'))])};}});
  try{
    const q=query('1986-01-01','2026-10-01'),first=await h.provider('NVDA',q),firstAt=first.sourceCheckedAt;
    assert.equal(first.retrievalLimited,true);assert.equal(first.hasMore,true);assert.equal(first.coverage.windowThrough,'2026-10-01');
    assert.equal(first.coverage.windowFrom,addDays('2026-10-01',-3659));
    const older=await h.provider('NVDA',q,{pageBefore:first.retrievedFrom});assert.ok(older.coverage.windowThrough<first.coverage.windowFrom);
    assert.notEqual(first.timestamp[0],older.timestamp[0]);clock+=1000;
    assert.equal((await h.provider('NVDA',q)).sourceCheckedAt,firstAt);assert.equal(h.calls.length,3,'one identity, two ranges, repeat cached');
  }finally{h.provider.close();}
});

test('identity disagreement rejects bare arrays before chart retrieval and invalidates the resolved listing',async()=>{
  const h=harness({basic:{...live.items[0].basic,currencyType:{code:'EUR'}}});
  try{await assert.rejects(h.provider('NVDA',query('2020-01-01','2020-12-31')),{code:'HISTORY_IDENTITY_CONFLICT'});assert.equal(h.calls.length,1);assert.equal(h.invalidations(),1);}
  finally{h.provider.close();}
  const unverified=harness({resolveCode:async()=>({code:'NVDA.O'})});
  try{await assert.rejects(unverified.provider('NVDA',query('2020-01-01','2020-12-31')),{code:'HISTORY_IDENTITY_UNRESOLVED'});assert.equal(unverified.calls.length,0);assert.equal(unverified.provider.supports('^NDX'),false);}
  finally{unverified.provider.close();}
});

test('real batch identity entry resolves static NVDA and QQQ exchange from verified basic before accepting daily arrays',async()=>{
  const batch=createBatchProvider({now:()=>at,httpsGet:async()=>{throw new Error('static listing code should not need search');}});
  try{
    for(const sample of live.items){
      const resolved=await batch.resolveNaverIdentity(sample.symbol);
      assert.equal(resolved.exchange,null,'the existing verified-static contract has no exchange');
      const h=harness({resolveCode:(...args)=>batch.resolveNaverIdentity(...args)});
      try{
        const data=await h.provider(sample.symbol,query('2020-01-01','2020-12-31'));
        assert.equal(data.timestamp.length,253);assert.equal(data.meta.exchangeName,'NASDAQ');
        assert.equal(data.meta.instrumentType,sample.symbol==='QQQ'?'ETF':'EQUITY');
        assert.equal(data.meta.identityProvenance,'verified-static+naver-basic');
        assert.equal((await h.provider(sample.symbol,query('2020-01-01','2020-12-31'))).sourceCheckedAt,data.sourceCheckedAt);
        assert.equal(h.calls.length,2,'verified basic and range caches are reused');
      }finally{h.provider.close();}
    }
    for(const exchange of [{code:'TSE',zoneId:'Asia/Tokyo',nationCode:'JPN'},{code:'NSQ',zoneId:'EST5EDT',nationCode:'CAN'}]){
      const h=harness({resolveCode:(...args)=>batch.resolveNaverIdentity(...args),basic:{...live.items[0].basic,stockExchangeType:exchange}});
      try{await assert.rejects(h.provider('NVDA',query('2020-01-01','2020-12-31')),{code:'HISTORY_IDENTITY_CONFLICT'});assert.equal(h.calls.length,1);}
      finally{h.provider.close();}
    }
    const mismatch=harness({resolveCode:async()=>({...identity('NVDA'),exchange:'NYS'})});
    try{await assert.rejects(mismatch.provider('NVDA',query('2020-01-01','2020-12-31')),{code:'HISTORY_IDENTITY_CONFLICT'});assert.equal(mismatch.calls.length,1);}
    finally{mismatch.provider.close();}
  }finally{batch.close();}
});

test('source dates, finite positive OHLC, conflicts, future rows and empty windows fail explicitly',()=>{
  const options={from:'2020-01-01',through:'2020-12-31',now:at};
  assert.throws(()=>parseNaverWorldDaily([row('2019-12-31')],options),{code:'HISTORY_RANGE_CONFLICT'});
  assert.throws(()=>parseNaverWorldDaily([{...row('2020-01-02'),highPrice:50}],options),{code:'HISTORY_BAD_RESPONSE'});
  assert.throws(()=>parseNaverWorldDaily([{...row('2020-01-02'),localDate:'20200230'}],options),{code:'HISTORY_BAD_RESPONSE'});
  assert.throws(()=>parseNaverWorldDaily([row('2020-01-02'),{...row('2020-01-02'),closePrice:101}],options),{code:'HISTORY_CONFLICT'});
  assert.throws(()=>parseNaverWorldDaily([row('2027-01-01')],{from:'2027-01-01',through:'2027-12-31',now:at}),{code:'HISTORY_RANGE_CONFLICT'});
  assert.throws(()=>parseNaverWorldDaily([],options),{code:'HISTORY_EMPTY'});
});

test('429 cooldown applies across requested windows instead of retrying under a different range key',async()=>{
  const h=harness({reply:async()=>({status:429,headers:{'retry-after':'120'},body:''})});
  try{
    await assert.rejects(h.provider('NVDA',query('2020-01-01','2020-12-31')),e=>e.code==='HISTORY_RATE_LIMITED'&&e.retryAt===at+120000);
    await assert.rejects(h.provider('NVDA',query('2010-01-01','2010-12-31')),{code:'HISTORY_RATE_LIMITED'});assert.equal(h.calls.length,2);
  }finally{h.provider.close();}
});

test('shared readers own cancellation and shutdown prevents delayed producers from caching',async()=>{
  let finish,producerSignal;const h=harness({reply:async(_url,request)=>{producerSignal=request.signal;return new Promise(resolve=>finish=resolve);}}),controller=new AbortController();
  const q=query('2020-01-01','2020-12-31');
  const first=h.provider('NVDA',q,{signal:controller.signal}),second=h.provider('NVDA',q);
  await settle();assert.equal(h.calls.length,2);controller.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(producerSignal.aborted,false);
  h.provider.close();await assert.rejects(second,{code:'STOPPED'});assert.equal(producerSignal.aborted,true);
  finish({status:200,body:JSON.stringify(live.items[0].rows)});await settle();assert.equal(h.provider.diagnostics().cachedRanges,0);
});
