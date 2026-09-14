import test from 'node:test';
import assert from 'node:assert/strict';
import {symbolValid} from '../../lib/symbol-validation.js';
import {catalogSearch} from '../../lib/catalog-search.js';
import {marketKeyFor,instrumentTypeFor,tencentCodeFor} from '../../lib/instruments.js';
import {eastmoneyIds} from '../../lib/providers/public-history.js';
import {createHistoryService} from '../../lib/history-service.js';
import {marketDirectory} from '../../lib/market-registry.js';

test('futures identifiers survive HTTP/history validation without accepting arbitrary equals expressions',()=>{
 for(const s of ['NQ=F','ES=F','GC=F','NQ00Y.FUT'])assert.equal(symbolValid(s),true,s);
 for(const s of ['NQ=F&x=1','NQ=F/../../','NQ==F','NQ=','https://a'])assert.equal(symbolValid(s),false,s);
});
test('NQ0W produces labelled related futures, not a fabricated cash-index alias',()=>{
 const list=catalogSearch('NQ0W');assert.ok(list.some(x=>x.symbol==='NQ00Y.FUT'));
 assert.ok(list.some(x=>x.symbol==='NQ=F'));
 assert.ok(list.every(x=>x.type==='FUTURE'&&x.matchType==='related'&&x.matchNote));
 assert.ok(!list.some(x=>x.symbol==='^IXIC'||x.symbol==='^NDX'||x.symbol==='NQ0W'));
});
test('Google code and Chinese night-session query resolve distinct provider series',()=>{
 for(const q of ['NQW00:CME_EMINIS','NQW00','纳指夜盘','纳斯达克100期货']){
  const list=catalogSearch(q);assert.ok(list.some(x=>x.symbol==='NQ00Y.FUT'),q);
 }
 assert.equal(catalogSearch('NQ=F')[0].symbol,'NQ=F');
 assert.equal(catalogSearch('NQ00Y')[0].symbol,'NQ00Y.FUT');
});
test('futures never inherit US cash hours or Tencent stock mapping',()=>{
 assert.equal(instrumentTypeFor('NQ=F'),'FUTURE');
 assert.equal(marketKeyFor('NQ=F'),'futures');
 assert.equal(tencentCodeFor('NQ=F'),null);
 assert.equal(tencentCodeFor('NQ00Y.FUT'),null);
 assert.deepEqual(eastmoneyIds('NQ00Y.FUT'),['103.NQ00Y']);
 assert.deepEqual(eastmoneyIds('NQ=F'),[],'different vendor continuous series must not be silently stitched');
});
test('directory contains futures, with original equity markets retained',()=>{
 const d=marketDirectory();assert.equal(d.markets.filter(x=>x.key!=='futures').length,20);
 const future=d.markets.find(x=>x.key==='futures');assert.ok(future);
 assert.ok(future.examples.some(x=>x.symbol==='NQ00Y.FUT'));
 assert.ok(future.examples.every(x=>x.type==='FUTURE'));
});
test('futures daily source can aggregate into all K-line periods without changing identity or point scale',async t=>{
 const data={source:'eastmoney-futures-history',retrievalLimited:true,meta:{symbol:'NQ00Y.FUT',currency:'USD',instrumentType:'FUTURE',exchangeName:'CME',exchangeTimezoneName:'America/Chicago',dataGranularity:'1d'},timestamp:[],indicators:{quote:[{open:[],high:[],low:[],close:[],volume:[]}]}};
 for(let i=0;i<120;i++){data.timestamp.push(Date.parse('2026-01-01T12:00:00Z')/1000+i*86400);for(const [k,n] of Object.entries({open:20000,high:20200,low:19900,close:20100,volume:100}))data.indicators.quote[0][k].push(n+i);}
 const h=createHistoryService({fetchChart:async()=>data,now:()=>Date.parse('2026-09-11T12:00:00Z')});t.after(()=>h.close());
 for(const p of ['daily','weekly','monthly','yearly']){const r=await h.get('NQ00Y.FUT',p,{count:10});assert.equal(r.status,'ready');assert.ok(r.bars.length);assert.equal(r.instrumentType,'FUTURE');assert.equal(r.currency,'POINTS');assert.equal(r.sessionScope,'source-futures-session');assert.ok(r.bars.every(b=>b.c<21000));}
});
