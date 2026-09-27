import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {instrumentClassification,nasdaqAssetClass,normalizeInstrumentType} from '../../lib/instruments.js';
import {createInstrumentRegistry} from '../../lib/instrument-registry.js';
import {createNaverIdentityResolver} from '../../lib/providers/naver-identity.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createNasdaqPublicTrades} from '../../lib/providers/nasdaq-public-trades.js';
import {createFinancialSources} from '../../lib/providers/financial-sources.js';
import {createSearchService} from '../../lib/search.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createMultiSourceFundamentals} from '../../lib/fundamentals-multi.js';
import {tencentInstrumentType} from '../../lib/providers/tx.js';
const now=()=>Date.parse('2026-09-27T02:00Z');
const fixtures=JSON.parse(fs.readFileSync(new URL('../fixtures/etf-identities.json',import.meta.url)));
const jepq=JSON.parse(fs.readFileSync(new URL('../fixtures/jepq.json',import.meta.url)));
const response=body=>({status:200,body:JSON.stringify(body)});

test('classification distinguishes stocks, ETF, mutual funds and unverified products',()=>{
 assert.equal(normalizeInstrumentType('Common Stock'),'EQUITY');
 assert.equal(normalizeInstrumentType('Exchange-Traded Fund'),'ETF');
 assert.equal(instrumentClassification('QNEW',{instrumentType:'EQUITY',instrumentTypeSource:'inferred'}).type,'UNKNOWN');
 assert.equal(instrumentClassification('JEPQ',{type:'EQUITY'}).type,'ETF');
 assert.equal(nasdaqAssetClass('QNEW',{instrumentType:'MUTUALFUND'}),null);
 assert.equal(nasdaqAssetClass('QNEW',{instrumentType:'ETP'}),null);
 assert.equal(nasdaqAssetClass('NVDA',{instrumentType:'EQUITY',instrumentTypeSource:'provider'}), 'stocks');
 for(const [index,flag,type] of [[56,'GP','EQUITY'],[61,'GP-A','EQUITY'],[63,'GP','EQUITY'],[56,'GP-ETF','ETF'],[61,'LOF','MUTUALFUND']]){
  const raw=[];raw[index]=flag;assert.equal(tencentInstrumentType(raw),type);
 }
 assert.equal(tencentInstrumentType(['','Some ETF Name']),null);
});

test('uncatalogued funds resolve from exact public listing evidence on a cold history request',async()=>{
 const identity=createNaverIdentityResolver({now,request:async url=>response(fixtures[new URL(url).searchParams.get('query')])});
 const registry=createInstrumentRegistry({now,resolveIdentity:identity.resolve});
 const routes=[];
 const history=createPublicHistory({now,resolveInstrument:registry.resolve,httpsGet:async url=>{
  const u=new URL(url),symbol=u.pathname.split('/')[3];routes.push([symbol,u.searchParams.get('assetclass')]);
  const body=structuredClone(jepq.daily);body.data.symbol=symbol;return response(body);
 }});
 try{
  for(const symbol of ['JEPI','SCHD','TLT']){
   assert.equal(instrumentClassification(symbol).type,'UNKNOWN');
   const data=await history(symbol,'?interval=1d&range=1mo');
   assert.equal(data.meta.instrumentType,'ETF');assert.equal(registry.decorate({symbol,instrumentType:'EQUITY',instrumentTypeSource:'inferred'}).instrumentType,'ETF');
  }
  assert.ok(routes.every(([,type])=>type==='etf'));
  assert.equal(createInstrumentRegistry().peek('JEPI').type,'UNKNOWN');
 }finally{identity.close();history.close();}
});

test('search ETF evidence reaches tape and stale inferred quotes cannot replace it',async()=>{
 const registry=createInstrumentRegistry({now});
 const search=createSearchService({now,instruments:registry,finnhubRequest:async()=>response({result:[{symbol:'QNEW',description:'New Fund',type:'ETF'}]})});
 const rows=await search.finnhubSearch('QNEW');assert.equal(rows[0].type,'ETF');
 assert.equal(registry.decorate({symbol:'QNEW',instrumentType:'EQUITY',instrumentTypeSource:'inferred'}).instrumentType,'ETF');
 const tape=createNasdaqPublicTrades({now,resolveInstrument:registry.resolve,httpsGet:async url=>{
  assert.equal(new URL(url).searchParams.get('assetclass'),'etf');const body=structuredClone(jepq.post);body.data.symbol='QNEW';return response(body);
 }});
 try{const value=await tape.read('QNEW',{session:'post',tradeDate:'2026-09-25'});assert.equal(value.reason,'SOURCE_DATE_MISMATCH');}
 finally{tape.close();search.clearSearchCache();}
});

test('Tencent search without type evidence stays unclassified',async()=>{
 const search=createSearchService({now,httpsGet:async()=>({status:200,body:'v_hint="us~QNEW~New Fund~qnew";'})});
 assert.equal((await search.tencentSuggest('QNEW'))[0].type,'UNKNOWN');search.clearSearchCache();
});

test('Nasdaq fundamentals separate equity, ETF and unsupported mutual-fund routes',async()=>{
 const seen=[],sources=createFinancialSources({now,httpsGet:async url=>{seen.push(url);return response({data:null});}});
 for(const id of ['nasdaq-summary','nasdaq-dividends']){
  const source=sources.find(s=>s.id===id);
  for(const instrumentType of ['ETF','EQUITY']){
   const quote={symbol:'QNEW',instrumentType,currency:'USD'};assert.equal(source.match(quote),true);
   await source.load('QNEW',{quote}).catch(()=>{});
   assert.equal(new URL(seen.at(-1)).searchParams.get('assetclass'),instrumentType==='ETF'?'etf':'stocks');
  }
  assert.equal(source.match({symbol:'QNEW',instrumentType:'MUTUALFUND',currency:'USD'}),false);
 }
});

test('source cooldown for the former stock classification does not block an ETF retry',async()=>{
 let type='EQUITY',calls=0;
 const alternative=async(symbol,query,options)=>{
  calls++;if(options.instrumentType==='EQUITY')throw Object.assign(new Error('wrong route'),{retryAt:now()+600000});
  return {source:'nasdaq-history',meta:{symbol,currency:'USD',dataGranularity:'1d'},timestamp:[1790294400],indicators:{quote:[{open:[60],high:[62],low:[59],close:[61],volume:[10]}]}};
 };
 const history=createHistorySource({now,alternative,resolveInstrument:async()=>({type})});
 try{await assert.rejects(history('QNEW','?interval=1d&range=1mo'));type='ETF';assert.equal((await history('QNEW','?interval=1d&range=1mo')).timestamp.length,1);assert.equal(calls,2);}
 finally{history.close();}
});

test('fundamentals retry immediately with the new asset class and suppress equity-only metrics',async()=>{
 const called=[];let resolveStock;
 const service=createMultiSourceFundamentals({now,sources:[{id:'sample',fields:['dividendTTM','marketCap'],load:async(symbol,{quote})=>{
  called.push(quote.instrumentType);
  if(quote.instrumentType==='EQUITY')return new Promise(resolve=>{resolveStock=resolve;});
  return {symbol,source:'sample',fetchedAt:now(),fields:{dividendTTM:{value:3,status:'available',source:'sample'},marketCap:{value:100,status:'available',source:'sample'}}};
 }}]});
 service.start();const quote={symbol:'QNEW',currency:'USD',price:61,instrumentType:'EQUITY'};
 try{
  service.decorate(quote);await new Promise(r=>setImmediate(r));
  const fund={...quote,instrumentType:'ETF'};service.decorate(fund);resolveStock({symbol:'QNEW',source:'sample',fetchedAt:now(),fields:{dividendTTM:{value:99,status:'available'}}});
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  const result=service.decorate(fund);assert.deepEqual(called,['EQUITY','ETF']);assert.equal(result.fundamentals.fields.dividendTTM.value,3);assert.equal(result.fundamentals.fields.marketCap.status,'not-applicable');
 }finally{service.stop();}
});
