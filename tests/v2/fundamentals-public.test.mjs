import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPublicFundamentalsProvider,normalizeNaverKoreanFundamentals,normalizeNaverCompanyShares} from '../../lib/providers/public-fundamentals.js';
const fixture=name=>fs.readFileSync(new URL('../fixtures/fundamentals-live/'+name,import.meta.url),'utf8');
const detail=()=>JSON.parse(fixture('naver-kr-detail.json')),company=()=>fixture('naver-kr-company.html');
test('Korean PBR and issued share count are read from explicit provider fields',()=>{
  const r=normalizeNaverKoreanFundamentals('000660.KS',detail()),s=normalizeNaverCompanyShares('000660.KS',company());
  assert.equal(r.fields.priceToBook.value,4.58);assert.equal(r.financialPeriod,'2026-06');
  assert.equal(s.fields.sharesOutstanding.value,730492365);assert.equal(s.fields.sharesOutstanding.asOf,null);
  assert.equal(s.fields.floatShares,undefined,'do not turn a rounded free-float percent into a share count');
});
test('provider identity and malformed/missing values fail closed',()=>{
  assert.throws(()=>normalizeNaverKoreanFundamentals('005930.KS',detail()),{code:'FUNDAMENTALS_IDENTITY'});
  assert.throws(()=>normalizeNaverCompanyShares('005930.KS',company()),{code:'FUNDAMENTALS_IDENTITY'});
  assert.throws(()=>normalizeNaverCompanyShares('000660.KS',company().replace('730,492,365주','N/A주')),{code:'FUNDAMENTALS_EMPTY'});
  const d=detail();d.totalInfos.find(r=>r.code==='pbr').value='N/A';
  assert.throws(()=>normalizeNaverKoreanFundamentals('000660.KS',d),{code:'FUNDAMENTALS_EMPTY'});
  d.totalInfos.find(r=>r.code==='pbr').value='4.58garbage';
  assert.throws(()=>normalizeNaverKoreanFundamentals('000660.KS',d),{code:'FUNDAMENTALS_EMPTY'});
});
test('Korean public requests merge independent sources and preserve useful partial results',async()=>{
  let fail=false,calls=[];
  const provider=createPublicFundamentalsProvider({httpsGet:async(url,headers,{signal})=>{
    calls.push(url);assert.ok(signal);return url.includes('wisereport')?{status:fail?503:200,body:company(),headers:{'retry-after':'120'}}:{status:200,body:JSON.stringify(detail())};
  }});
  let r=await provider('000660.KS');assert.equal(r.fields.priceToBook.value,4.58);assert.equal(r.fields.sharesOutstanding.value,730492365);assert.equal(calls.length,2);
  fail=true;r=await provider('000660.KS');assert.equal(r.fields.priceToBook.value,4.58);assert.equal(r.fields.sharesOutstanding,undefined);assert.equal(r.refreshAfterMs,60000);
});
test('Tencent public adapter uses the exact validated symbol and supports cancellation',async()=>{
  let calls=0;const provider=createPublicFundamentalsProvider({fetchTencent:async(s,{signal})=>{calls++;assert.ok(signal);return [{symbol:s[0],financials:{symbol:s[0],fields:{priceToBook:{value:5.36}}}}];}});
  assert.equal((await provider('AAOI')).fields.priceToBook.value,5.36);
  assert.equal(await provider('../etc/passwd'),null);assert.equal(await provider('BTC-USD'),null);
  const controller=new AbortController();controller.abort();await assert.rejects(provider('AAOI',{signal:controller.signal}));assert.equal(calls,1);
});
