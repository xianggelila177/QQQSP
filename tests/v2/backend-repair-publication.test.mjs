import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {chartRevision} from '../../lib/chart-revision.js';
import {createMarketContextHttp} from '../../lib/market-context-http.js';
import {semanticEtag} from '../../lib/api-representation.js';
import {historyData,fixtureAt,quote} from './backend-repair-fixtures.mjs';

test('R5 the real enricher publishes immutable regular bars and reuses their digest',async t=>{
 let price=100,source='yahoo';
 const enrich=createChartEnricher({now:()=>fixtureAt,fetchChart:async s=>historyData(s,{start:'2026-09-30',price,source})});
 const first=await enrich('NVDA',quote());
 assert.ok(first.regularChart.bars.length);
 const createHash=crypto.createHash;let hashes=0;
 t.mock.method(crypto,'createHash',(...args)=>{hashes++;return createHash(...args);});
 const revision=chartRevision(first.regularChart.bars);chartRevision(first.regularChart.bars);chartRevision(first.regularChart.bars);
 assert.equal(hashes,1,'published bars must allow digest reuse');
 assert.ok(Object.isFrozen(first.regularChart.bars));assert.ok(first.regularChart.bars.every(Object.isFrozen));
 const unchanged=await enrich('NVDA',quote());assert.equal(unchanged.regularChart.bars,first.regularChart.bars);
 price=110;source='fixture';enrich.invalidate('NVDA');const changed=await enrich('NVDA',quote());
 assert.notEqual(chartRevision(changed.regularChart.bars),revision);assert.equal(first.regularChart.bars[0].c,101);
 assert.equal(changed.regularChart.bars[0].c,111);assert.equal(changed.regularChart.source,'fixture');
});

test('R5 owned copies preserve upstream writes and projection time/day boundaries',async()=>{
 let at=Date.parse('2026-09-30T01:30:00Z');
 const source=[{t:at/1000,c:100,o:100,h:101,l:99,v:1000},{t:at/1000+60,c:101,o:100,h:102,l:99,v:2000}];
 const enrich=createChartEnricher({now:()=>at,includeDaily:false,tx:{txMinuteBarsCn:async()=>source}});
 const base={symbol:'600000.SS',price:100,currency:'CNY',instrumentType:'EQUITY',quoteAt:at,charts:{}};
 const first=await enrich(base.symbol,base);assert.equal(first.regularChart.bars.length,1);
 source[0].c=105;assert.equal(first.regularChart.bars[0].c,100);assert.equal(Object.isFrozen(source[0]),false);
 at+=55000;const next=await enrich(base.symbol,base);assert.equal(next.regularChart.bars.length,2);
 assert.notEqual(chartRevision(first.regularChart.bars),chartRevision(next.regularChart.bars));
 at=Date.parse('2026-10-09T01:35:00Z');enrich.invalidate(base.symbol);source.splice(0,source.length,{...source[0],t:at/1000,c:106,h:107});
 const tomorrow=await enrich(base.symbol,base);assert.equal(tomorrow.regularChart.tradeDate,'2026-10-09');
 assert.notEqual(chartRevision(tomorrow.regularChart.bars),chartRevision(next.regularChart.bars));
 assert.equal(next.regularChart.bars[0].c,100);
});

test('R9 unconditional POST avoids ETag traversal; conditional POST GET HEAD retain semantics',async t=>{
 let reads=0;
 const result={schema_version:1,status:'complete',get value(){reads++;return 42;}};
 const handler=createMarketContextHttp({apiKey:'test'.repeat(10),allowGet:true,service:{query:async()=>result},limiter:{consume:()=>({ok:true})}});
 const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const url='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+'test'.repeat(10),'Content-Type':'application/json'};
 const post=extra=>fetch(url,{method:'POST',headers:{...headers,...extra},body:'{"symbol":"NVDA","include":["quote"]}'});
 const response=await post();assert.equal(response.status,200);assert.equal(reads,1,'only JSON serialization may traverse the payload');
 const tag=semanticEtag(result);
 for(const header of [tag,'*'])assert.equal((await post({'If-None-Match':header})).status,412);
 assert.equal((await post({'If-None-Match':'"other"'})).status,200);
 for(const method of ['GET','HEAD']){
  const response=await fetch(url+'?symbol=NVDA&include=quote',{method,headers});assert.equal(response.status,200);assert.equal(response.headers.get('etag'),tag);
  if(method==='HEAD')assert.equal(await response.text(),'');
  assert.equal((await fetch(url+'?symbol=NVDA&include=quote',{method,headers:{...headers,'If-None-Match':tag}})).status,304);
 }
 assert.equal((await fetch(url+'?symbol=NVDA',{headers:{'If-None-Match':'*'}})).status,401);
 result.status='unavailable';assert.equal((await post({'If-None-Match':'*'})).status,503);
});
