import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {catalogSearch} from '../../lib/catalog-search.js';
import {canonicalSearchQuery} from '../../lib/equity-directory.js';
import {catalogInstruments} from '../../lib/market-registry.js';
import {marketKeyFor,providerCapabilities} from '../../lib/instruments.js';
import {createSearchService,ALIAS_SYM} from '../../lib/search.js';
import {createHttp} from '../../lib/http.js';

test('SPX search aliases return the canonical queryable S&P 500 instrument locally',()=>{
  for(const query of ['SPX','spx','^SPX',' ^spx ','ＳＰＸ','^GSPC']){
    assert.equal(canonicalSearchQuery(query),'^GSPC',query);
    const rows=catalogSearch(query);assert.equal(rows[0]?.symbol,'^GSPC',query);assert.equal(rows[0]?.type,'INDEX');
    assert.equal(rows[0]?.currency,'USD');assert.equal(marketKeyFor(rows[0]?.symbol),'us');
  }
  for(const symbol of ['SPXC','SPX.L','SPXL','^SOX'])assert.equal(canonicalSearchQuery(symbol),symbol);
});

test('Yahoo canonicalizes index identity before calculating type/market and omits unknown index candidates',async()=>{
  const calls=[];const service=createSearchService({yGated:fn=>fn(),httpsGet:async url=>{
    calls.push(url);return {status:200,body:JSON.stringify({quotes:[
      {symbol:'^SPX',shortname:'S&P 500',quoteType:'INDEX'},
      {symbol:'^UNLISTED',shortname:'Unverified index',quoteType:'INDEX'},
      {symbol:'SPXC',shortname:'SPX Technologies',quoteType:'EQUITY'},
    ]})};
  }});
  const rows=await service.yahooSearch('SPX');
  assert.equal(new URL(calls[0]).searchParams.get('q'),'^gspc');
  assert.deepEqual(rows.map(x=>[x.symbol,x.type,x.market]),[['^GSPC','INDEX','美股指数'],['SPXC','EQUITY','美股']]);
});

async function httpFixture(t,deps={}){
  const server=createHttp({yahooSearch:async()=>[],tencentSuggest:async()=>[],...deps},{env:{PORT:0},monitorCore:false});
  server.startListen();await once(server.httpServer,'listening');t.after(()=>server.stop());
  return async query=>fetch('http://127.0.0.1:'+server.httpServer.address().port+'/api/search?'+query);
}

test('HTTP exact SPX search returns a usable canonical index during provider outage',async t=>{
  let calls=0;const fail=async()=>{calls++;throw Error('offline');};const get=await httpFixture(t,{yahooSearch:fail,tencentSuggest:fail});
  for(const query of ['SPX','^SPX']){
    const response=await get('q='+encodeURIComponent(query));assert.equal(response.status,200);
    assert.deepEqual((await response.json()).map(x=>x.symbol),['^GSPC']);assert.equal(response.headers.get('x-search-status'),'available');
  }
  assert.equal(calls,0);
});

test('HTTP expanded search deduplicates canonical aliases and never advertises an unqueryable index',async t=>{
  const get=await httpFixture(t,{yahooSearch:async()=>[
    {symbol:'^SPX',name:'S&P alias',type:'INDEX'},
    {symbol:'^GSPC',name:'S&P canonical',type:'INDEX'},
    {symbol:'^UNLISTED',name:'Unverified index',type:'INDEX'},
    {symbol:'SPXC',name:'SPX Technologies',type:'EQUITY'},
  ]});
  const response=await get('q=%5ESPX&more=1');const rows=await response.json();
  assert.deepEqual(rows.map(x=>x.symbol),['^GSPC','SPXC']);
});

test('every catalog and named index alias has consistent market identity and an available quote route',()=>{
  for(const row of catalogInstruments().filter(x=>x.type==='INDEX')){
    assert.equal(marketKeyFor(row.symbol),row.market,row.symbol);
    const capability=providerCapabilities(row.symbol);
    assert.ok(capability.legacyQuote||capability.batchProviders.length,row.symbol);
  }
  for(const symbol of new Set(Object.values(ALIAS_SYM)))assert.ok(marketKeyFor(symbol),symbol);
});
