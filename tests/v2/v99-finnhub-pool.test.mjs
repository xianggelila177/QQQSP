import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../../config.js';
import { createHttp } from '../../lib/http.js';
import { createSearchService } from '../../lib/search.js';
import { createFinancialSources } from '../../lib/providers/financial-sources.js';
import { createFinnhubRestPool, parseFinnhubTokens } from '../../lib/providers/finnhub-rest.js';
import { createHostGate } from '../../lib/host-gate.js';
import { createTransport } from '../../lib/transport.js';
import { publicSourceHealth } from '../../lib/source-health-public.js';

const first='first_token_1234567890',second='second_token_123456789';

test('Finnhub token configuration is strict, deduplicated and never exposed by diagnostics',async()=>{
  assert.deepEqual(parseFinnhubTokens(first,`${first}, ${second}`),[first,second]);
  assert.throws(()=>loadConfig({FINNHUB_TOKENS:'valid_token_123456,not valid'}),/invalid entry/);
  const seen=[];
  const pool=createFinnhubRestPool({tokens:[first,second],httpsGet:async(_url,headers)=>{
    seen.push(headers['X-Finnhub-Token']);return {status:200,headers:{},body:'{}'};
  }});
  await pool.request('/search?q=AAPL');await pool.request('/search?q=MSFT');
  assert.deepEqual(seen,[first,second]);
  const report=JSON.stringify(pool.diagnostics());
  assert.equal(pool.diagnostics().tokenCount,2);assert.doesNotMatch(report,/first_token|second_token/);
  const publicReport=JSON.stringify(publicSourceHealth({finnhubRest:pool.diagnostics()}));
  assert.match(publicReport,/"tokenCount":2/);assert.doesNotMatch(publicReport,/first_token|second_token/);
});

test('a rate-limited Finnhub token fails over once and remains cooled while the other token serves requests',async()=>{
  let now=1_000_000;const seen=[];
  const pool=createFinnhubRestPool({tokens:[first,second],now:()=>now,httpsGet:async(_url,headers)=>{
    const token=headers['X-Finnhub-Token'];seen.push(token);
    return token===first?{status:429,headers:{'retry-after':'60'},body:'{}'}:{status:200,headers:{},body:'{"result":[]}'};
  }});
  assert.equal((await pool.request('/search?q=SOXL')).status,200);
  assert.deepEqual(seen,[first,second]);
  await pool.request('/search?q=NVDA');assert.deepEqual(seen,[first,second,second]);
  assert.deepEqual(pool.diagnostics().counts,{requests:3,successes:2,failovers:1,rateLimits:1,rejected:0,failures:0});
  assert.equal(pool.diagnostics().coolingTokens,1);
});

test('the real transport gate isolates a 429 to one Finnhub credential slot',async()=>{
  let at=1_000_000;const seen=[];
  const gate=createHostGate({now:()=>at,minGap:()=>0,baseMs:30000});
  const transport=createTransport({now:()=>at,gate,upstream:async(_url,headers)=>{
    seen.push(headers['X-Finnhub-Token']);
    return headers['X-Finnhub-Token']===first?
      {status:429,headers:{'retry-after':'60'},body:'{}'}:
      {status:200,headers:{},body:'{"result":[]}'};
  }});
  try{
    const pool=createFinnhubRestPool({httpsGet:transport.httpsGet,tokens:[first,second],now:()=>at});
    assert.equal((await pool.request('/search?q=SOXL')).status,200);
    assert.deepEqual(seen,[first,second]);
    assert.equal(gate.diagnostics()['finnhub.io:rest-0'].state,'cooldown');
    assert.equal(gate.diagnostics()['finnhub.io:rest-1'].state,'ready');
  }finally{await transport.close();}
});

test('Finnhub search validates and normalizes the provider response, including ETP and verified index aliases',async()=>{
  const service=createSearchService({finnhubRequest:async path=>{
    assert.match(path,/\/search\?q=SOXL$/i);
    return {status:200,body:JSON.stringify({count:4,result:[
      {symbol:'SOXL',displaySymbol:'SOXL',description:'Semiconductor Bull 3X',type:'ETP'},
      {symbol:'SPX',displaySymbol:'SPX',description:'S&P 500',type:'Index'},
      {symbol:'BINANCE:BTCUSDT',description:'Bitcoin',type:'Crypto'},
      {symbol:'SOXL.ZZ',description:'Unknown exchange suffix',type:'ETP'},
      {symbol:'SOXL',description:'duplicate',type:'ETP'},
    ]})};
  }});
  const rows=await service.finnhubSearch('soxl');
  assert.deepEqual(rows.map(row=>[row.symbol,row.type,row.source]),[
    ['SOXL','ETF','finnhub-search'],['^GSPC','INDEX','finnhub-search'],
  ]);
});

test('Finnhub failure exposes the source status and still returns Yahoo candidates',async t=>{
  const base=await searchServer(t,{
    finnhubSearch:async()=>{throw Object.assign(new Error('limited'),{code:'FINNHUB_RATE_LIMITED'});},
    yahooSearch:async()=>[{symbol:'AAPL',name:'Yahoo Apple',type:'EQUITY'}],
  });
  const response=await fetch(base+'/api/search?q=apple-fallback');
  assert.equal(response.status,200);
  assert.equal((await response.json())[0].symbol,'AAPL');
  assert.equal(response.headers.get('x-search-status'),'partial');
  const metadata=JSON.parse(Buffer.from(response.headers.get('x-search-meta'),'base64url').toString());
  assert.equal(metadata.sources.finnhub.code,'FINNHUB_RATE_LIMITED');
  assert.equal(metadata.sources.yahoo.status,'available');
});

async function searchServer(t,deps){
  const layer=createHttp({yahooSearch:async()=>[],tencentSuggest:async()=>[],...deps},{env:{PORT:0},monitorCore:false});
  layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
  return 'http://127.0.0.1:'+layer.httpServer.address().port;
}

test('HTTP search uses Finnhub first and only falls back to Yahoo by default when Finnhub has no result',async t=>{
  let yahooCalls=0;
  const base=await searchServer(t,{
    finnhubSearch:async()=>[{symbol:'SOXL',name:'Finnhub SOXL',type:'ETF',source:'finnhub-search'}],
    yahooSearch:async()=>{yahooCalls++;return [{symbol:'SOXL',name:'Yahoo SOXL',type:'ETF'}];},
  });
  const primary=await fetch(base+'/api/search?q=semiconductor-leverage');
  assert.equal(primary.status,200);assert.equal((await primary.json())[0].name,'Finnhub SOXL');assert.equal(yahooCalls,0);
  const metadata=JSON.parse(Buffer.from(primary.headers.get('x-search-meta'),'base64url').toString());
  assert.equal(metadata.sources.finnhub.status,'available');assert.equal(metadata.sources.yahoo,undefined);

  const expanded=await fetch(base+'/api/search?q=semiconductor-leverage&more=1');
  assert.equal((await expanded.json())[0].name,'Finnhub SOXL');assert.equal(yahooCalls,1);
});

test('empty Finnhub search falls through to Yahoo and pooled Finnhub also serves financial polling',async t=>{
  let yahooCalls=0;
  const base=await searchServer(t,{
    finnhubSearch:async()=>[],
    yahooSearch:async()=>{yahooCalls++;return [{symbol:'AAPL',name:'Yahoo Apple',type:'EQUITY'}];},
  });
  const response=await fetch(base+'/api/search?q=unlisted-apple-query');
  assert.equal((await response.json())[0].symbol,'AAPL');assert.equal(yahooCalls,1);

  let requested;
  const sources=createFinancialSources({httpsGet:async()=>{throw new Error('unexpected direct request');},batch:{},fetchYahooSummary:async()=>null,
    finnhubRequest:async path=>{requested=path;return {status:200,headers:{},body:JSON.stringify({symbol:'AAPL',metric:{peTTM:25}})};}});
  const source=sources.find(row=>row.id==='finnhub-metric');
  const data=await source.load('AAPL',{});assert.match(requested,/^\/stock\/metric\?symbol=AAPL/);assert.equal(data.fields.peTTM.value,25);
});
