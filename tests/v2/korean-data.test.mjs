import test from 'node:test';import assert from 'node:assert/strict';
import {catalogSearch} from '../../lib/catalog-search.js';
import {createKoreanSearch} from '../../lib/providers/korean-search.js';
import {parseNaverHistory,createNaverHistory} from '../../lib/providers/naver-history.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createHttp} from '../../lib/http.js';import {once} from 'node:events';
const now=Date.parse('2026-09-10T07:00:00Z');
const xml=(symbol,rows)=>`<protocol><chartdata symbol="${symbol}">${rows.map(row=>`<item data="${row}"/>`).join('')}</chartdata></protocol>`;
test('Hynix aliases return both listings; Korean code and US ADR remain distinct',()=>{
 for(const q of ['海力士','SK海力士','SK Hynix','Hynix'])assert.deepEqual(new Set(catalogSearch(q).map(x=>x.symbol)),new Set(['000660.KS','SKHY']));
 const k=catalogSearch('000660')[0];assert.equal(k.symbol,'000660.KS');assert.equal(k.currency,'KRW');assert.equal(k.exch,'KOSPI');
 assert.equal(catalogSearch('SKHY')[0].currency,'USD');assert.equal(catalogSearch('005930')[0].symbol,'005930.KS');
});
test('HTTP exact company alias works when every remote search is unavailable',async t=>{
 let calls=0;const fail=()=>{calls++;throw new Error('offline');};const layer=createHttp({yahooSearch:fail,tencentSuggest:fail},{env:{PORT:0},monitorCore:false});
 layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
 const q=await (await fetch('http://127.0.0.1:'+layer.httpServer.address().port+'/api/search?q='+encodeURIComponent('海力士'))).json();
 assert.deepEqual(q.map(x=>x.symbol),['000660.KS','SKHY']);assert.equal(calls,0);
});
test('unknown Korean numeric code requires exact provider identity and exchange confirmation',async()=>{
 let row={itemCode:'035420',stockName:'NAVER',stockExchangeType:{code:'KS'}};
 const search=createKoreanSearch({now:()=>now,httpsGet:async()=>({status:200,body:JSON.stringify({datas:[row]})})});
 const q=await search('035420');assert.equal(q[0].symbol,'035420.KS');assert.deepEqual(await search('035420.KQ'),[]);
 row={...row,itemCode:'000660'};assert.deepEqual(await search('123456'),[]);assert.deepEqual(await search('NVDA'),[]);
});
test('Korean minute XML uses close and cumulative volume differences; daily XML retains real OHLC',()=>{
 const minute=parseNaverHistory(xml('000660',['202609091530|null|null|null|200000|1000','202609100900|null|null|null|201000|100','202609100901|null|null|null|202000|170']), '000660.KS',{minute:true,now});
 const q=minute.indicators.quote[0];assert.equal(minute.meta.currency,'KRW');assert.equal(minute.timestamp.length,2);assert.deepEqual(q.close,[201000,202000]);assert.deepEqual(q.volume,[null,70]);assert.deepEqual(q.open,[null,null]);
 const day=parseNaverHistory(xml('000660',['20260909|198000|202000|197000|200000|1000']), '000660.KS',{now});assert.equal(day.meta.dataGranularity,'1d');assert.equal(day.indicators.quote[0].high[0],202000);
 assert.throws(()=>parseNaverHistory(xml('005930',['20260909|1|3|1|2|10']),'000660.KS',{now}),/identity/);
 assert.throws(()=>parseNaverHistory(xml('000660',[]),'000660.KS',{now}),/usable/);
});
test('Korean minute history is deduplicated, cached for 60s and never requested for the ADR',async()=>{
 let calls=0;const loader=createNaverHistory({now:()=>now,httpsGet:async url=>{calls++;assert.match(url,/symbol=000660/);return {status:200,body:xml('000660',['202609100900|null|null|null|201000|100'])};}});
 const [a,b]=await Promise.all([loader('000660.KS','?interval=5m'),loader('000660.KS','?interval=5m')]);assert.strictEqual(a,b);await loader('000660.KS','?interval=5m');assert.equal(calls,1);
 await assert.rejects(loader('SKHY','?interval=5m'),/Unsupported/);
});
test('shared history router tries Naver for Korea, keeps ADR on US route; daily fallback never leaks into intraday',async()=>{
 // Route fixtures must satisfy the real history contract, not only HTTP success.
 const raw=symbol=>({meta:{symbol,dataGranularity:'1d'},timestamp:[now/1000-86400],indicators:{quote:[{open:[10],high:[12],low:[9],close:[11]}]}});
 let calls=[];const source=createHistorySource({primary:async symbol=>{calls.push('primary:'+symbol);return raw(symbol);},naver:async symbol=>{calls.push('naver:'+symbol);return raw(symbol);}});
 await source('000660.KS','?interval=1d');await source('SKHY','?interval=1d');assert.deepEqual(calls,['naver:000660.KS','primary:SKHY']);
 let fallback=0;const fail=createHistorySource({primary:async()=>{throw new Error('offline');},sina:async()=>{fallback++;return [];}});await assert.rejects(fail('600519.SS','?interval=5m'));assert.equal(fallback,0);
});
