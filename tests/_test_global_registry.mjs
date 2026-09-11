import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MARKET_REGISTRY, marketDirectory } from '../lib/market-registry.js';
import { marketKeyFor, instrumentMeta, providerCapabilities, instrumentTypeFor } from '../lib/instruments.js';
import { createHttp, symbolValid } from '../lib/http.js';
import { parseCv } from '../lib/http-charts.js';
import { createNasdaqProvider } from '../lib/providers/nasdaq.js';
import { createYahooService } from '../lib/yahoo.js';

const cases={us:'AAPL',cn:'600519.SS',hk:'0700.HK',jp:'7203.T',kr:'005930.KS',uk:'VOD.L',de:'SAP.DE',fr:'MC.PA',ch:'NESN.SW',nl:'ASML.AS',it:'ENI.MI',es:'SAN.MC',ca:'RY.TO',au:'BHP.AX',in:'M&M.NS',sg:'D05.SI',tw:'00632R.TW',br:'PETR4.SA',mx:'WALMEX.MX',za:'NPN.JO'};
assert.equal(Object.keys(MARKET_REGISTRY).length,20);
for(const [key,symbol] of Object.entries(cases)){
  assert.equal(marketKeyFor(symbol),key,symbol);assert.equal(symbolValid(symbol),true,symbol);
  if(key!=='cn')assert.equal(instrumentMeta(symbol).market,MARKET_REGISTRY[key].label);
  if(!['us','cn','kr','hk'].includes(key))assert.deepEqual(providerCapabilities(symbol).batchProviders,[]);
}
assert.equal(marketKeyFor('FOO.XX'),null);assert.equal(marketKeyFor('BTC-USD'),null);
assert.equal(marketKeyFor('BRK-B'),'us');assert.equal(marketKeyFor('^FTSE'),'uk');
assert.equal(instrumentTypeFor('FTSEMIB.MI'),'INDEX');
for(const symbol of ['510300.SS','NIFTYBEES.NS','BOVA11.SA','NAFTRACISHRS.MX','STX40.JO']){
 const meta=instrumentMeta(symbol,{instrumentType:'EQUITY'});assert.equal(meta.instrumentType,'ETF');assert.equal(meta.instrumentTypeSource,'catalog');
}
for(const symbol of ['QQQ?x=1','M&M.NS&crumb=x','<script>','../VOD.L','123456','M&M'])assert.equal(symbolValid(symbol),false,symbol);
assert.equal(parseCv('M&M.NS:123:456').get('M&M.NS').dVer,456);
const directory=marketDirectory();assert.equal(directory.version,1);assert.deepEqual(directory.featured,['^FTSE']);assert.equal(directory.markets.length,20);
for(const market of directory.markets){assert.ok(market.timezone);assert.ok(market.benchmarks.length);assert.ok(market.examples.some(x=>x.type==='EQUITY'));assert.ok(market.examples.some(x=>x.type==='ETF'));assert.ok(market.examples.every(x=>['EQUITY','ETF'].includes(x.type)));}
let calls=0;const nasdaq=createNasdaqProvider({httpsGet:async()=>{calls++;throw new Error('foreign routing');}});
for(const symbol of Object.values(cases).filter(s=>s!=='AAPL'))assert.deepEqual(await nasdaq.getNasdaqDaily(symbol),[]);
assert.equal(calls,0);nasdaq.close();
let requested='';const yahoo=createYahooService({env:{Y_MIN_GAP:'0'},getCrumb:async()=>({crumb:'fixture',cookie:'fixture'}),httpsGet:async url=>{requested=url;return {status:200,body:JSON.stringify({chart:{result:[{meta:{symbol:'M&M.NS'}}]}})};}});
await yahoo.fetchChart('M&M.NS','?range=1d');assert.match(requested,/chart\/M%26M\.NS\?/);await yahoo.close();
const http=createHttp({getCachedQuote:()=>{throw new Error('directory must not fetch quotes');}},{env:{PORT:'0'},monitorCore:false});
try{http.startListen();await once(http.httpServer,'listening');const response=await fetch('http://127.0.0.1:'+http.httpServer.address().port+'/api/markets');assert.equal(response.status,200);assert.deepEqual(await response.json(),directory);assert.match(response.headers.get('cache-control'),/max-age=/);}finally{await http.stop();}
console.log('PASS global identity, bounded symbols, provider isolation and read-only directory');
