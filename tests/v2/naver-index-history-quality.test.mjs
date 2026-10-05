import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNaverIndexProvider} from '../../lib/providers/naver-index.js';

const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/naver-ixic-invalid-ohlc-2012.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-05T02:07:50Z');
const basic={stockEndType:'index',reutersCode:'.IXIC',stockExchangeType:{code:'NSQ',zoneId:'EST5EDT',nationCode:'USA'},indexType:{symbolCode:'IXIC',currencyType:null}};
function source(rows,identity=basic){
  const calls=[],provider=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{
    calls.push(url);return {status:200,body:JSON.stringify(url.endsWith('/basic')?identity:rows)};
  }});
  return {provider,calls};
}
const query='?interval=1d&period1='+Date.parse('2004-12-30T00:00:00Z')/1000;

test('real index provider isolates a recorded invalid old OHLC date and retains valid earlier history unchanged',async()=>{
  const {provider,calls}=source(fixture.rows);
  try{
    const result=await provider.fetchChart('^IXIC',query),q=result.indicators.quote[0];
    assert.equal(result.timestamp.length,5);
    assert.deepEqual(result.timestamp.map(t=>new Date(t*1000).toISOString().slice(0,10)),['2010-07-09','2012-10-19','2012-10-23','2018-01-02','2026-10-02']);
    const good=fixture.rows.filter(row=>row.localDate!=='20121022');
    for(const [field,key] of [['open','openPrice'],['high','highPrice'],['low','lowPrice'],['close','closePrice']])
      assert.deepEqual(q[field],good.map(row=>row[key]),'valid source OHLC is never repaired or fabricated');
    assert.deepEqual(result.historyQuality,{status:'partial',missingTradingDates:['2012-10-22'],rejectedRows:1,reason:'source-invalid-ohlc'});
    assert.ok(q.volume.every(v=>v===null),'unverified index volume is not promoted to shares');
    assert.equal(result.sourceCheckedAt,now);
    assert.equal(calls.length,2);assert.match(calls[1],/startDateTime=200412290000/);
    const cached=await provider.fetchChart('^IXIC',query);
    assert.deepEqual(cached.historyQuality,result.historyQuality);assert.equal(calls.length,2,'cached rows retain the rejection disclosure');
  }finally{provider.close();}
});

test('index quarantine does not make an all-invalid response or bad identity/time acceptable',async()=>{
  const invalid=fixture.rows.find(row=>row.localDate==='20121022');
  for(const [rows,identity,pattern] of [
    [[invalid],basic,/empty history|invalid history OHLC/],
    [[{...invalid,localDate:'20120230'}],basic,/invalid time/],
    [fixture.rows,{...basic,reutersCode:'.NDX'},/identity mismatch/]
  ]){
    const {provider}=source(rows,identity);
    try{await assert.rejects(provider.fetchChart('^IXIC',query),pattern);}finally{provider.close();}
  }
});
