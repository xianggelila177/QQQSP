import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {parseNaverEnergy,parseCnbcMacro,createPublicMacroSources} from '../../lib/providers/macro-public-quotes.js';
import {createMacroQuoteReader} from '../../lib/providers/macro-quotes.js';
const read=name=>JSON.parse(fs.readFileSync(new URL('../fixtures/macro-v89/'+name+'.json',import.meta.url),'utf8'));
const START=Date.parse('2026-09-15T01:20:00Z');
test('Naver preserves the oil contract, USD/barrel unit, explicit offset and ten-minute delay',()=>{
 const rows=parseNaverEnergy(read('naver-energy'),START);assert.equal(rows.size,2);
 const q=rows.get('CLcv1');assert.ok(q.price>0);assert.equal(q.feedDelayMinutes,10);assert.equal(q.delayed,true);assert.equal(q.currency,'USD');assert.equal(q.unit,'美元/桶');assert.equal(q.quoteAt,Date.parse(read('naver-energy').result.mainList[0].localTradedAt));assert.ok(q.contractSymbol.includes('26.10'));
 const broken=read('naver-energy');broken.result.mainList[0].unit='USD/TONNE';assert.equal(parseNaverEnergy(broken,START).has('CLcv1'),false);broken.result.mainList[1].localTradedAt='2099-01-01T00:00:00Z';assert.equal(parseNaverEnergy(broken,START).size,0);
});
test('CNBC uses yield rather than bond price; time-only values never become fabricated trade dates',()=>{
 const rows=parseCnbcMacro(read('cnbc'),START);assert.equal(rows.size,5);
 const raw=read('cnbc').ITVQuoteResult.ITVQuote,rate=rows.get('US10Y');assert.equal(rate.price,Number(raw.find(q=>q.symbol==='US10Y').last.replace('%','')));assert.equal(rate.unit,'%');assert.equal(rate.quoteAt,null);assert.equal(rate.declaredRealtime,true);
 assert.equal(rows.get('@CL.1').delayed,true);assert.equal(rows.get('@CL.1').feedDelayMinutes,null);assert.ok(rows.get('@CL.1').contractSymbol);
 const bad=read('cnbc');bad.ITVQuoteResult.ITVQuote[0].subType='Stock';assert.equal(parseCnbcMacro(bad,START).has('@CL.1'),false);
});
test('one shared request per provider supplies independent macro factors and refreshes after TTL',async()=>{
 let now=START;const calls=[];const pub=createPublicMacroSources({now:()=>now,httpsGet:async(url,headers,{signal})=>{calls.push(url);assert.ok(signal);return {status:200,body:JSON.stringify(read(url.includes('cnbc')?'cnbc':'naver-energy'))};}});
 try{await Promise.all([pub.routes['CL00Y.FUT'][0][1](),pub.routes['BZ=F'][0][1]()]);assert.equal(calls.length,1);await Promise.all([pub.routes['^TNX'][0][1](),pub.routes['DX-Y.NYB'][0][1]()]);assert.equal(calls.length,2);now+=30001;await pub.routes['BZ=F'][0][1]();assert.equal(calls.length,3);}finally{pub.close();}
});
test('blocked legacy sources can refresh from public fallback without relabelling delayed oil as live',async()=>{
 let now=START,price=102;const pub=createPublicMacroSources({now:()=>now,httpsGet:async(url)=>{const x=read(url.includes('cnbc')?'cnbc':'naver-energy');if(!url.includes('cnbc')){x.result.mainList[0].closePrice=String(price);x.result.mainList[0].localTradedAt=new Date(now-600000).toISOString();}return {status:200,body:JSON.stringify(x)};}});
 const fail=async()=>{throw Error('blocked');};const reader=createMacroQuoteReader({now:()=>now,publicSources:pub,futures:{getQuote:fail},fetchChart:fail,httpsGet:fail});
 try{const a=await reader.readQuote('CL00Y.FUT');assert.equal(a.price,102);assert.equal(a.feedDelayMinutes,10);now+=30001;price=103;assert.equal((await reader.readQuote('CL00Y.FUT')).price,103);assert.equal((await reader.readQuote('^TNX')).daily,undefined);}finally{reader.close();}
});
test('public adapters reject malformed identities, dates, prices and response shapes',()=>{
 assert.equal(parseNaverEnergy({},START).size,0);assert.equal(parseCnbcMacro({},START).size,0);
 const n=read('naver-energy');n.result.mainList[0].localTradedAt='2026-02-30T09:00:00+09:00';n.result.mainList[1].closePrice=true;assert.equal(parseNaverEnergy(n,START).size,0);
 const c=read('cnbc');for(const row of c.ITVQuoteResult.ITVQuote){if(row.symbol==='US10Y')row.last='97.18';else row.currencyCode='EUR';}assert.equal(parseCnbcMacro(c,START).size,0);
 const k=read('cnbc');k.ITVQuoteResult.ITVQuote=k.ITVQuoteResult.ITVQuote.filter(r=>r.symbol==='.DXY');Object.assign(k.ITVQuoteResult.ITVQuote[0],{realTime:undefined,last:100,last_timedate:new Date(START).toISOString(),curmktstatus:'MKT_CLOSED'});const q=parseCnbcMacro(k,START).get('.DXY');assert.equal(q.quoteAt,START);assert.equal(q.declaredRealtime,null);assert.equal(q.marketState,'CLOSED');
 k.ITVQuoteResult.ITVQuote[0].last=NaN;assert.equal(parseCnbcMacro(k,START).size,0);
});
test('rate limits are shared across factor readers and survive close/reopen',async()=>{
 let now=START,calls=0,healthy=false;const pub=createPublicMacroSources({now:()=>now,httpsGet:async()=>{calls++;return healthy?{status:200,body:JSON.stringify(read('cnbc'))}:{status:429,headers:{'retry-after':'300'},body:''};}});
 await assert.rejects(pub.routes['^TNX'][0][1](),e=>e.retryAt===START+300000);now+=61000;await assert.rejects(pub.routes['DX-Y.NYB'][0][1]());assert.equal(calls,1);pub.close();pub.reopen();await assert.rejects(pub.routes['^TNX'][0][1]());assert.equal(calls,1);now=START+300001;healthy=true;assert.ok((await pub.routes['^TNX'][0][1]()).price>0);pub.close();
});
test('HTTP 200 empty data and a missing individual factor do not count as successful quotes',async()=>{
 const empty=createPublicMacroSources({httpsGet:async()=>({status:200,body:'{}'})});await assert.rejects(empty.routes['BZ=F'][0][1](),{code:'MACRO_PUBLIC_EMPTY'});await assert.rejects(empty.routes['^TNX'][0][1](),{code:'MACRO_PUBLIC_EMPTY'});empty.close();
 const raw=read('cnbc');raw.ITVQuoteResult.ITVQuote=raw.ITVQuoteResult.ITVQuote.filter(r=>r.symbol==='@CL.1');const partial=createPublicMacroSources({httpsGet:async()=>({status:200,body:JSON.stringify(raw)})});await assert.rejects(partial.routes['^TNX'][0][1](),{code:'MACRO_PUBLIC_EMPTY'});partial.close();
});
test('closing a reader interrupts its wait and an old producer cannot publish into a reopened reader',async()=>{
 let release,calls=0;const reader=createMacroQuoteReader({now:()=>START,candidateTimeoutMs:60000,httpsGet:async()=>{throw Error('unexpected');},futures:{getQuote:async symbol=>{calls++;if(calls===1)await new Promise(r=>release=r);return {symbol,price:calls===1?90:101,sourceCheckedAt:START};}},fetchChart:async()=>{throw Error('unexpected');}});
 const job=reader.readQuote('NQ00Y.FUT');await new Promise(r=>setImmediate(r));reader.close();await assert.rejects(job,{code:'STOPPED'});reader.reopen();assert.equal((await reader.readQuote('NQ00Y.FUT')).price,101);release();await new Promise(r=>setImmediate(r));reader.close();
});
test('a recently cached old primary does not outrank a successfully refreshed delayed backup',async()=>{
 let now=START,fail=false;const reader=createMacroQuoteReader({now:()=>now,httpsGet:async()=>{throw Error('offline');},fetchChart:async()=>{throw Error('offline');},futures:{getQuote:async symbol=>{if(fail)throw Error('offline');return {symbol,price:100,sourceCheckedAt:now,src:'primary'};}},publicSources:{routes:{'CL00Y.FUT':[['test:backup',async()=>({symbol:'alternate',price:101,quoteAt:now-600000,sourceCheckedAt:now,feedDelayMinutes:10,delayed:true})]]}}});
 assert.equal((await reader.readQuote('CL00Y.FUT')).price,100);now+=30001;fail=true;assert.equal((await reader.readQuote('CL00Y.FUT')).price,101);reader.close();
});
