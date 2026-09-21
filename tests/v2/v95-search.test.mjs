import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {catalogSearch} from '../../lib/catalog-search.js';
import {catalogInstrumentFor} from '../../lib/market-registry.js';
import {createSearchService} from '../../lib/search.js';
import {createHttp} from '../../lib/http.js';

test('Konami resolves from Chinese, English, Japanese, local code and venue code without upstream availability',()=>{
 for(const query of ['科乐美','科樂美','Konami','KONAMI GROUP','コナミ','ｺﾅﾐ','9766','9766.T','JPX:9766','TSE:9766']){
  const row=catalogSearch(query).find(row=>row.symbol==='9766.T');
  assert.ok(row,query);assert.equal(row.market,'日股');assert.equal(row.currency,'JPY');
  assert.equal(row.type,'EQUITY');assert.equal(row.identitySource,'JPX');
  assert.equal(row.listingAsOf,'2026-08-31');
 }
});
test('the same coverage applies beyond Konami and does not confuse cash listings or countries',()=>{
 for(const [query,symbol] of [['索尼','6758.T'],['Sony','6758.T'],['任天堂','7974.T'],['Nintendo','7974.T'],['丰田','7203.T'],['Toyota','7203.T'],['卡普空','9697.T'],['CAPCOM','9697.T'],['スクウェア','9684.T'],['台积电','2330.TW'],['腾讯','0700.HK']])assert.ok(catalogSearch(query).some(row=>row.symbol===symbol),query);
 assert.deepEqual(catalogSearch('9766.T').map(row=>row.symbol),['9766.T']);
 assert.equal(catalogInstrumentFor('9766.T').market,'jp');
});
test('official directory contains source-dated ordinary shares with unique valid identities, not guessed funds',()=>{
 const data=JSON.parse(readFileSync(new URL('../../data/jpx-equities.json',import.meta.url)));
 assert.equal(data.asOf,'2026-08-31');assert.equal(data.source,'JPX');assert.equal(data.rows.length,3705);
 assert.equal(new Set(data.rows.map(row=>row.code)).size,data.rows.length);
 assert.ok(data.sources.every(url=>url.startsWith('https://www.jpx.co.jp/')));
 for(const row of data.rows){assert.match(row.code,/^\d[0-9A-Z]{3}$/);assert.ok(row.name&&row.nameJa);assert.match(row.section,/Prime|Standard|Growth/);assert.equal(catalogInstrumentFor(row.code+'.T').type,'EQUITY');}
});

async function httpFixture(t,deps={}){
 const server=createHttp({yahooSearch:async()=>[],tencentSuggest:async()=>[],...deps},{env:{PORT:0},monitorCore:false});
 server.startListen();await once(server.httpServer,'listening');t.after(()=>server.stop());
 return async(query,more=false)=>fetch('http://127.0.0.1:'+server.httpServer.address().port+'/api/search?q='+encodeURIComponent(query)+(more?'&more=1':''));
}
test('exact Japanese listing is usable during remote outage and avoids needless remote calls',async t=>{
 let calls=0;const fail=()=>{calls++;throw new Error('offline');};const get=await httpFixture(t,{yahooSearch:fail,tencentSuggest:fail});
 for(const query of ['科乐美','9766.T']){const r=await get(query);assert.equal(r.status,200);assert.ok((await r.json()).some(x=>x.symbol==='9766.T'));assert.equal(r.headers.get('x-search-status'),'available');}
 assert.equal(calls,0);
});
test('remote failure is observable and distinct from a successful empty search',async t=>{
 const get=await httpFixture(t,{yahooSearch:async()=>{throw new Error('offline');},tencentSuggest:async()=>{throw new Error('offline');}});
 const r=await get('zzzx-nonexistent');assert.deepEqual(await r.json(),[]);assert.equal(r.headers.get('x-search-status'),'unavailable');
 const meta=JSON.parse(Buffer.from(r.headers.get('x-search-meta'),'base64url').toString());assert.equal(meta.sources.yahoo.status,'unavailable');assert.equal(meta.sources.tencent.status,'unavailable');
 assert.match(r.headers.get('access-control-expose-headers'),/X-Search-Status/);
 const empty=await httpFixture(t);const ok=await empty('zzzx-nonexistent');assert.equal(ok.headers.get('x-search-status'),'empty');
});
test('same local numeric code retains independently confirmed listing choices from other markets',async t=>{
 const get=await httpFixture(t,{yahooSearch:async()=>[{symbol:'9766.HK',name:'Other listing',type:'EQUITY'}]});
 const r=await get('9766');const rows=await r.json();assert.ok(rows.some(x=>x.symbol==='9766.HK'));assert.ok(rows.some(x=>x.symbol==='9766.T'));
});
test('unknown native company text is passed to search adapters rather than silently discarded',async t=>{
 let seen;const get=await httpFixture(t,{yahooSearch:async query=>{seen=query;return [{symbol:'VOW3.DE',name:'Foreign company',type:'EQUITY'}];}});
 const response=await get('未知本地公司名');assert.equal(seen,'未知本地公司名');assert.ok((await response.json()).some(row=>row.symbol==='VOW3.DE'));
});

test('exact foreign ticker falls back to metadata confirmation when directory search omits it',async()=>{
 const calls=[];const service=createSearchService({yGated:fn=>fn(),httpsGet:async url=>{
  calls.push(url);return {status:200,body:JSON.stringify(url.includes('/search?')?{quotes:[]}:{chart:{result:[{meta:{symbol:'M&M.NS',shortName:'Mahindra',instrumentType:'EQUITY',exchangeName:'NSI',currency:'INR'}}]}})};
 }});
 const rows=await service.yahooSearch('m&m.ns');assert.equal(rows[0]?.symbol,'M&M.NS');assert.equal(rows[0]?.currency,'INR');assert.equal(rows[0]?.source,'yahoo-chart-identity');
 assert.ok(calls.some(url=>url.includes('/chart/M%26M.NS?')));
});
test('metadata lookup rejects mismatched identity and never invents a ticker from company text',async()=>{
 let charts=0;const service=createSearchService({yGated:fn=>fn(),httpsGet:async url=>{
  if(url.includes('/chart/'))charts++;return {status:200,body:JSON.stringify(url.includes('/search?')?{quotes:[]}:{chart:{result:[{meta:{symbol:'AAPL',shortName:'Apple',instrumentType:'EQUITY'}}]}})};
 }});
 assert.deepEqual(await service.yahooSearch('ZZZZ.DE'),[]);assert.equal(charts,1);
 assert.deepEqual(await service.yahooSearch('unlisted-company'),[]);assert.equal(charts,1);
});
test('metadata confirmation follows search HTTP failures with independent chart availability',async()=>{
 const service=createSearchService({yGated:fn=>fn(),httpsGet:async url=>url.includes('/search?')?{status:503,body:''}:{status:200,body:JSON.stringify({chart:{result:[{meta:{symbol:'ZZZZ.DE',shortName:'Confirmed German issuer',exchangeName:'GER',instrumentType:'EQUITY',currency:'EUR'}}]}})}});
 assert.equal((await service.yahooSearch('ZZZZ.DE'))[0]?.symbol,'ZZZZ.DE');
});
test('Tencent does not merge share class into its parent ticker and canonicalizes padded HK codes',async()=>{
 const service=createSearchService({httpsGet:async()=>({status:200,body:'v_hint="us~brk.b.n~Berkshire B^hk~00700~Tencent";'})});
 assert.deepEqual((await service.tencentSuggest('fixture')).map(x=>x.symbol),['BRK-B','0700.HK']);
});
test('Tencent search keeps verified US and HK ETF identities without guessing from fund-like names',async()=>{
 const service=createSearchService({httpsGet:async()=>({status:200,body:'v_hint="hk~02800~Tracker Fund^us~spy.am~SPDR S&P 500 ETF Trust^us~qqq.oq~Invesco QQQ^hk~00700~Tencent^us~zzfake.n~Unverified ETF name";'})});
 const rows=await service.tencentSuggest('fund');
 assert.deepEqual(rows.map(row=>[row.symbol,row.type]),[['2800.HK','ETF'],['SPY','ETF'],['QQQ','ETF'],['0700.HK','EQUITY'],['ZZFAKE','EQUITY']]);
});
