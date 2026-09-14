import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createFinancialSources} from '../../lib/providers/financial-sources.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {summary} from './fundamentals-fixture.mjs';
const now=Date.parse('2026-09-14T08:00:00Z'),read=(name,root='fundamentals-v88')=>fs.readFileSync(new URL('../fixtures/'+root+'/'+name,import.meta.url),'utf8');
const json=name=>JSON.parse(read(name+'.json'));
function setup({code='NVDA.O',token='test-token'}={}){
 const calls=[],parser=createBatchProvider({now:()=>now}),raw=fs.readFileSync(new URL('../fixtures/fundamentals-v88/tencent.raw',import.meta.url)).toString('latin1');
 const batch={resolveNaverCode:async()=>code,tencent:async syms=>parser.parseTencentBatch(raw,syms)};
 const httpsGet=async(url,headers,options)=>{
  assert.ok(options.signal);calls.push({url,headers});let body;
  if(url.includes('wisereport'))body=read('naver-kr-company.html','fundamentals-live');
  else if(url.includes('/integration'))body=read('naver-kr-detail.json','fundamentals-live');
  else if(url.includes('/basic'))body=JSON.stringify(json('basic-NVDA'));
  else if(url.includes('/finance/'))body=read((url.endsWith('/summary')?'statements':url.endsWith('/quarter')?'quarter':'annual')+'-NVDA.json');
  else if(url.includes('/financials?')){const data=json(url.endsWith('=1')?'annual-AMD-nasdaq':'amd-financials');data.data.symbol='NVDA';body=JSON.stringify(data);}
  else if(url.includes('/dividends?'))body=read('dividends-NVDA.json');
  else if(url.includes('finnhub'))body=JSON.stringify({symbol:'NVDA',metric:{peTTM:28,peAnnual:40,pbQuarterly:23,psTTM:15}});
  else body=read('nasdaq-NVDA.json');
  return {status:200,body};
 };
 const sources=createFinancialSources({batch,httpsGet,fetchYahooSummary:async symbol=>summary(symbol),finnhubToken:token,now:()=>now});
 return {sources,calls,batch,httpsGet};
}
test('production source descriptors fetch their own fields, scopes and TTLs',async()=>{
 const {sources,calls}=setup(),signal=new AbortController().signal,quote={symbol:'NVDA',instrumentType:'EQUITY',currency:'USD'};
 for(const s of sources){const kr=s.id==='naver-company',symbol=kr?'000660.KS':'NVDA';const r=await s.load(symbol,{signal,quote:{...quote,symbol}});assert.equal(r.symbol,symbol);assert.ok(Object.keys(r.fields).length,s.id);}
 assert.equal(calls.filter(c=>c.url.includes('/basic')).length,1,'statement source reuses a validated basic response');
 assert.ok(calls.find(c=>c.url.includes('finnhub')).headers['X-Finnhub-Token']);assert.ok(calls.every(c=>!c.url.includes('test-token')));
 for(const s of sources){if(s.match){s.match({symbol:'QQQ',currency:'USD',instrumentType:'ETF'});s.match({symbol:'000660.KS',currency:'KRW',instrumentType:'EQUITY'});s.match({symbol:'BTC-USD',currency:'USD',instrumentType:'CRYPTOCURRENCY'});}}
 const kr=await sources.find(s=>s.id==='naver-basic').load('000660.KS',{signal,quote:{symbol:'000660.KS',currency:'KRW',instrumentType:'EQUITY'}});assert.equal(kr.fields.priceToBook.value,4.58);assert.ok(kr.fields.week52High.value>0);
 assert.equal(setup({token:''}).sources.some(s=>s.id==='finnhub-metric'),false);
});
test('HTTP rate-limit, unsupported identifier, identity mismatch and cancellation stay distinct',async()=>{
 for(const [status,code] of [[429,'RATE_LIMITED'],[404,'FUNDAMENTALS_UNSUPPORTED'],[503,'FUNDAMENTALS_SOURCE']]){
  const sources=createFinancialSources({batch:{resolveNaverCode:async()=> 'NVDA.O'},now:()=>now,httpsGet:async()=>({status,headers:{'retry-after':'120'}})});
  await assert.rejects(sources[1].load('NVDA',{signal:new AbortController().signal}),e=>e.code===code&&e.retryAt>=now+120000);
 }
 const missing=setup({code:null});await assert.rejects(missing.sources[1].load('NVDA',{}),{code:'FUNDAMENTALS_UNSUPPORTED'});
 const bad=createFinancialSources({batch:{resolveNaverCode:async()=> 'NVDA.O'},httpsGet:async()=>({status:200,body:JSON.stringify({symbolCode:'OTHER',reutersCode:'NVDA.O'})})});await assert.rejects(bad[1].load('NVDA',{}),{code:'FUNDAMENTALS_IDENTITY'});
 const abort=new AbortController();abort.abort();await assert.rejects(bad[1].load('NVDA',{signal:abort.signal}));
 const empty=createFinancialSources({batch:{tencent:async()=>[]}});await assert.rejects(empty[0].load('NVDA',{}),{code:'FUNDAMENTALS_EMPTY'});
});
test('a missing quarterly table does not suppress the independently returned annual PER',async()=>{
 const {batch,httpsGet}=setup();const sources=createFinancialSources({batch,now:()=>now,httpsGet:async(url,...rest)=>url.endsWith('/quarter')?{status:503,headers:{}}:httpsGet(url,...rest)});
 const r=await sources.find(s=>s.id==='naver-statements').load('NVDA',{signal:new AbortController().signal});assert.equal(r.fields.peLYR.value,43.19);assert.equal(r.fields.revenueTTM,undefined);assert.equal(r.fields.trailingEps,undefined);
});
