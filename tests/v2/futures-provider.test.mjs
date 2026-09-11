import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import vm from 'node:vm';
import fs from 'node:fs';
import {createFuturesProvider,parseEastmoneyFuture,parseYahooFuture} from '../../lib/providers/futures.js';
import {createApplication} from '../../app.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
const asOf=Date.parse('2026-09-11T12:00:00Z');
const em=(code='NQ00Y')=>({data:{f57:code,f43:25000.25,f44:25100,f45:24800,f46:24900,f47:222,f60:24850,f86:asOf/1000-10,f169:150.25,f170:0.605}});
const response=body=>({status:200,headers:{},body:JSON.stringify(body)});

test('Eastmoney future uses quote timestamp, correct point values and a non-stock change baseline',()=>{
 const d=parseEastmoneyFuture(em(),'NQ00Y.FUT',asOf);
 assert.equal(d.price,25000.25);assert.equal(d.priceUnit,'POINTS');assert.equal(d.quoteAt,asOf-10000);assert.equal(d.sourceCheckedAt,asOf);
 assert.equal(d.marketState,'UNKNOWN');assert.equal(d.changeBasis,'source-reference');assert.equal(d.ext,null);
 assert.throws(()=>parseEastmoneyFuture(em('ES00Y'),'NQ00Y.FUT',asOf),{code:'FUTURE_IDENTITY'});
 const raw=em();delete raw.data.f86;assert.equal(parseEastmoneyFuture(raw,'NQ00Y.FUT',asOf).quoteAt,null);
});
test('cached quotes keep trade time; failures respect Retry-After without attempting alternate rate-limit endpoints',async t=>{
 let now=asOf,calls=0,broken=false;
 const p=createFuturesProvider({now:()=>now,httpsGet:async()=>{calls++;return broken?{status:429,headers:{'Retry-After':'180'},body:''}:response(em());}});t.after(()=>p.close());
 const one=await p.getQuote('NQ00Y.FUT');now+=1000;assert.equal((await p.getQuote('NQ00Y.FUT')).quoteAt,one.quoteAt);assert.equal(calls,1);
 now+=5000;broken=true;const old=await p.getQuote('NQ00Y.FUT');assert.equal(old.stale,true);assert.equal(old.sourceCheckedAt,asOf);
 now+=60000;await p.getQuote('NQ00Y.FUT');assert.equal(calls,2,'no list call or early source retry');
});
test('Yahoo futures do not inherit stock-session OHLC or wrong symbol values',()=>{
 const raw={meta:{symbol:'NQ=F',instrumentType:'FUTURE',regularMarketPrice:25000,regularMarketTime:asOf/1000,exchangeName:'CME',currency:'USD'},timestamp:[],indicators:{quote:[{}]}};
 const q=parseYahooFuture(raw,'NQ=F',asOf);assert.equal(q.src,'yahoo-futures');assert.equal(q.open,null);assert.equal(q.marketState,'UNKNOWN');
 assert.throws(()=>parseYahooFuture({...raw,meta:{...raw.meta,symbol:'QQQ'}},'NQ=F',asOf),{code:'FUTURE_IDENTITY'});
});
test('remote contract search validates known roots and preserves expiry; paged list is cached rather than exhaustively crawled',async t=>{
 let calls=0;
 const p=createFuturesProvider({now:()=>asOf,httpsGet:async url=>{calls++;assert.match(url,/futsseapi/);return response({total:3000,list:[{dm:'NQ26Z'},{dm:'NQ26U'},{dm:'QQQ26Z'},{dm:'ES26Z'}]});}});t.after(()=>p.close());
 const r=await p.search('NQ');assert.deepEqual(r.map(x=>x.symbol),['NQ26Z.FUT','NQ26U.FUT']);assert.ok(r.every(x=>x.cataloguePartial));
 await p.search('NQ');assert.equal(calls,1);
});
test('literal Eastmoney futures history never leaks into Yahoo or US stock endpoints',async()=>{
 const urls=[];let yahoo=0;
 const backup=createPublicHistory({now:()=>asOf,httpsGet:async url=>{urls.push(url);return response({data:{code:'NQ00Y',market:103,klines:['2026-09-10,24000,24100,24200,23900,123']}});}});
 const history=createHistorySource({now:()=>asOf,primary:async()=>{yahoo++;throw Error('should not run');},alternative:backup});
 const raw=await history('NQ00Y.FUT','?interval=1d&range=1y');assert.equal(raw.source,'eastmoney-futures-history');assert.equal(yahoo,0);
 assert.equal(urls.length,1);assert.match(decodeURIComponent(urls[0]),/103.NQ00Y/);assert.ok(!urls[0].includes('nasdaq'));
});
test('point futures display point values and disable currency conversion, without changing instrument type',()=>{
 const s={window:{},Intl,Date};for(const name of ['panel-currency.js','panel-format.js'])vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name,import.meta.url),'utf8'),s);
 const data={instrumentType:'FUTURE',priceUnit:'POINTS',currency:'USD',price:25000};
 const f=s.window.PANEL_FORMAT.createFormatter({data,displayCurrency:'CNY',fxMap:{USD:7}});
 assert.equal(f.unit,'点');assert.equal(f.money(25000),'25,000.00');assert.equal(data.instrumentType,'FUTURE');
});
test('real HTTP: typo discovery works offline and adding the selected symbol reaches futures quote/history paths',async t=>{
 let network=0;const urls=[];
 const app=createApplication({env:{PORT:0,SYMBOLS:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},now:()=>asOf,upstream:async url=>{network++;urls.push(url);
  if(url.includes('stock/get'))return response(em());
  if(url.includes('kline/get'))return response({data:{code:'NQ00Y',market:103,klines:['2026-09-09,24000,24100,24200,23900,100','2026-09-10,24100,24200,24300,24000,150']}});
  return {status:429,headers:{'Retry-After':'60'},body:''};
 }});t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 const list=await (await fetch(origin+'/api/search?q=NQ0W')).json();assert.equal(list.length,2);assert.equal(network,0);
 assert.ok(list.every(x=>x.matchType==='related'&&x.type==='FUTURE'));
 const initial=await fetch(origin+'/api/market?symbols=NQ00Y.FUT');assert.equal(initial.status,200);await new Promise(r=>setTimeout(r,80));
 const quote=(await (await fetch(origin+'/api/market?symbols=NQ00Y.FUT')).json())[0];assert.equal(quote.price,25000.25);assert.equal(quote.instrumentType,'FUTURE');
 const hist=await (await fetch(origin+'/api/history?symbol=NQ00Y.FUT&period=weekly')).json();assert.equal(hist.status,'ready');assert.equal(hist.source,'eastmoney-futures-history');
 assert.ok(!urls.some(u=>u.includes('yahoo')||u.includes('nasdaq')||u.includes('sinajs')));
});

test('Yahoo display type Futures cannot be mistaken for an equity or filtered out of futures discovery',async()=>{
 const {createSearchService}=await import('../../lib/search.js');
 const s=createSearchService({now:()=>asOf,yGated:fn=>fn(),httpsGet:async()=>response({quotes:[{symbol:'NQ=F',quoteType:'FUTURE',typeDisp:'Futures',shortname:'Nasdaq 100'}]})});
 assert.equal((await s.yahooSearch('NQ'))[0].type,'FUTURE');
});


test('expanded search keeps supported futures and cash results, not orphan futures without a quote/history identity',async t=>{
 const app=createApplication({env:{PORT:0,SYMBOLS:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},now:()=>asOf,upstream:async url=>{
  if(url.includes('/finance/search'))return response({quotes:[{symbol:'NQ=F',quoteType:'FUTURE',typeDisp:'Futures',shortname:'Nasdaq future'},{symbol:'UNSUPPORTED=F',quoteType:'FUTURE',typeDisp:'Futures',shortname:'Unregistered future'},{symbol:'NVDA',quoteType:'EQUITY',shortname:'NVIDIA'}]});
  return response({total:0,list:[]});
 }});t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');
 const origin='http://127.0.0.1:'+app.httpServer.address().port;
 const result=await (await fetch(origin+'/api/search?q=Nasdaq&more=1')).json();
 assert.ok(result.some(x=>x.symbol==='NQ=F'&&x.type==='FUTURE'));
 assert.ok(result.some(x=>x.symbol==='NVDA'));
 assert.ok(!result.some(x=>x.symbol==='UNSUPPORTED=F'));
});

test('futures without source intraday history still display a timestamped observation in the exchange timezone',()=>{
 const q=parseEastmoneyFuture(em(),'NQ00Y.FUT',asOf);
 const s={window:{},Date};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),s);
 const observe=s.window.PANEL_CHART_ENGINE.createObservationSeries({now:()=>asOf});
 const plotted=observe(q);
 assert.equal(q.gmtoff,-18000,'Chicago daylight-saving offset for the fixture date');
 assert.equal(plotted.sampled,true);assert.equal(plotted.bars.length,1);
 assert.equal(plotted.bars[0].t,(asOf-10000)/1000);assert.equal(plotted.bars[0].v,null);
 assert.equal(plotted.bars[0].c,25000.25);
});

test('the slower futures catalogue quote actually waits 30 seconds before retrying its primary endpoint',async t=>{
 let current=asOf,calls=0,primaryReady=false;
 const p=createFuturesProvider({now:()=>current,httpsGet:async url=>{
  calls++;
  if(url.includes('stock/get'))return primaryReady?response(em()):{status:500,headers:{},body:''};
  return response({total:1,list:[{dm:'NQ00Y',p:25000,o:24800,h:25100,l:24700,zjsj:24850,vol:100}]});
 }});t.after(()=>p.close());
 const q=await p.getQuote('NQ00Y.FUT');assert.equal(q.src,'eastmoney-futures-list');assert.equal(q.quoteAt,null);assert.equal(calls,2);
 current+=6000;primaryReady=true;const cached=await p.getQuote('NQ00Y.FUT');assert.equal(cached.src,'eastmoney-futures-list');assert.equal(calls,2,'declared 30-second fallback interval is not merely a label');
 current+=25000;assert.equal((await p.getQuote('NQ00Y.FUT')).src,'eastmoney-futures');assert.equal(calls,3);
});
