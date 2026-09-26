import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {naverSearchIdentity,matchesNaverIdentity} from '../../lib/providers/naver-identity.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {createFinancialSources} from '../../lib/providers/financial-sources.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {catalogInstrumentFor} from '../../lib/market-registry.js';

// Saved, unmodified Naver responses from the 2026-09-25 TSM audit.
const fixture=JSON.parse(readFileSync(new URL('../fixtures/tsmc-naver.json',import.meta.url),'utf8'));
const NOW=Date.parse('2026-09-25T08:25:00Z');
const json=body=>({status:200,headers:{},body:JSON.stringify(body)});
const tencentRow=()=>{
  const fields=Array(80).fill('');
  Object.assign(fields,{1:'TSM',2:'TSM.N',3:'451.15',4:'446.57',5:'441.80',6:'7720294',30:'2026-09-24 16:00:01',33:'452.56',34:'440.60',35:'USD'});
  return `v_usTSM="${fields.join('~')}";`;
};

test('Naver exact TSM /total identity is NYSE equity; close symbols and quote conflicts are rejected',()=>{
  const identity=naverSearchIdentity(fixture.search,'TSM');
  assert.deepEqual(identity,{code:'TSM',exchange:'NYS',instrumentType:'EQUITY',provenance:'naver-search'});
  const exact=fixture.search.result.items.find(row=>row.code==='TSM');
  assert.deepEqual(naverSearchIdentity({isSuccess:true,result:{items:[{...exact,url:'/worldstock/stock/TSM'}]}},'TSM'),identity);
  for(const bad of [
    {code:'TSMX'}, {reutersCode:'TSM.N'}, {nationCode:'JPN'}, {isEtf:true},
    {typeCode:'UNKNOWN'}, {url:'/worldstock/stock/TSM/total/other'},
  ])assert.equal(naverSearchIdentity({isSuccess:true,result:{items:[{...exact,...bad}]}},'TSM'),null,JSON.stringify(bad));
  const row=fixture.quote.datas[0];
  assert.equal(matchesNaverIdentity(row,'TSM',identity),true);
  for(const bad of [
    {reutersCode:'TSM.N'}, {currencyType:{code:'CAD'}},
    {stockExchangeType:{...row.stockExchangeType,code:'NSQ'}},
    {stockExchangeType:{...row.stockExchangeType,nationCode:'JPN'}},
  ])assert.equal(matchesNaverIdentity({...row,...bad},'TSM',identity),false,JSON.stringify(bad));
});

test('Tencent TSM.N never becomes Naver identity; TSM PRE uses verified prior regular close',async()=>{
  const calls=[],batch=createBatchProvider({now:()=>NOW,httpsGet:async url=>{
    calls.push(url);
    if(url.includes('qt.gtimg.cn'))return {status:200,body:tencentRow()};
    if(url.includes('/worldstock/stock/TSM'))return json(fixture.quote);
    throw Error('unexpected Naver search or guessed code: '+url);
  }});
  assert.equal(batch.parseTencentBatch(tencentRow(),['TSM']).length,1);
  assert.deepEqual(await batch.resolveNaverIdentity('TSM'),{
    code:'TSM',exchange:'NYS',instrumentType:'EQUITY',provenance:'catalog'});
  const result=await batch.fetchSnapshotBatch(['TSM'],{group:'us'});
  assert.equal(result.quotes.length,1);
  assert.ok(calls.some(url=>url.endsWith('/worldstock/stock/TSM')));
  assert.equal(calls.some(url=>url.includes('/worldstock/stock/TSM.N')),false);
  const q=result.quotes[0];
  assert.equal(q.src,'naver-us');assert.equal(q.price,453.97);assert.equal(q.prevClose,451.15);
  assert.equal(q.previousCloseTradeDate,'2026-09-24');
  assert.ok(Math.abs(q.changePct-(453.97/451.15-1)*100)<1e-9);
  assert.equal(catalogInstrumentFor('TSM').currency,'USD');
  batch.close();
});

test('Naver-verified .N and .O Reuters identifiers still route to their own listing',async()=>{
  const exact=fixture.search.result.items.find(row=>row.code==='TSM');
  for(const [suffix,typeCode,exchange] of [['.N','NYSE','NYS'],['.O','NASDAQ','NSQ']]){
    const symbol='ACME',code=symbol+suffix;
    const search={isSuccess:true,result:{items:[{...exact,code:symbol,reutersCode:code,
      typeCode,url:'/worldstock/stock/'+code+'/total'}]}};
    const row={...fixture.quote.datas[0],symbolCode:symbol,reutersCode:code,
      stockExchangeType:{...fixture.quote.datas[0].stockExchangeType,code:exchange}};
    const urls=[],batch=createBatchProvider({now:()=>NOW,httpsGet:async url=>{
      urls.push(url);
      if(url.includes('/search/autoComplete'))return json(search);
      if(url.endsWith('/worldstock/stock/'+code))return json({pollingInterval:7000,datas:[row]});
      throw Error('wrong route: '+url);
    }});
    assert.equal((await batch.resolveNaverIdentity(symbol)).code,code);
    assert.equal((await batch.fetchSnapshotBatch([symbol],{group:'us'})).quotes[0].src,'naver-us');
    assert.ok(urls.some(url=>url.endsWith('/worldstock/stock/'+code)));
    batch.close();
  }
});

test('a Naver HTTP 200 empty array reports no data, drops the route and rechecks identity',async()=>{
  let clock=NOW,empty=true,searches=0;
  const batch=createBatchProvider({now:()=>clock,httpsGet:async url=>{
    if(url.includes('qt.gtimg.cn'))return {status:200,body:''};
    if(url.includes('/search/autoComplete')){searches++;return json(fixture.search);}
    if(url.endsWith('/worldstock/stock/TSM'))return json(empty?fixture.guessed:fixture.quote);
    throw Error('wrong route: '+url);
  }});
  const first=await batch.fetchSnapshotBatch(['TSM'],{group:'us'});
  assert.equal(first.quotes.length,0);
  assert.equal(first.identityIssues.TSM,'NAVER_NO_DATA');
  assert.equal(await batch.resolveNaverIdentity('TSM'),null,'empty response must not look like a usable identity');
  assert.equal(searches,1,'the direct catalog route was rechecked against Naver');
  clock+=60001;empty=false;
  const recovered=await batch.fetchSnapshotBatch(['TSM'],{group:'us'});
  assert.equal(recovered.quotes[0].src,'naver-us');
  assert.equal(recovered.identityIssues.TSM,undefined);
  batch.close();
});

test('polling carries Naver identity diagnostics to cold snapshots without suppressing Tencent fallback',async()=>{
  const naver=async()=>({quotes:[],identityIssues:{TSM:'NAVER_NO_DATA'}});
  const httpsGet=async()=>({status:503,headers:{},body:''});
  const cold=createFastPolling({now:()=>NOW,httpsGet,legacy:{tencent:async()=>[],fetchSnapshotBatch:naver}});
  let wake;const updated=new Promise(resolve=>{wake=resolve;});
  const snapshots=createSnapshotService({now:()=>NOW,env:{POLL_MS:1000},sessionFor:()=> 'PRE',
    fetchBatch:cold.fetchSnapshotBatch,onUpdate:symbol=>{if(symbol==='TSM')wake();}});
  snapshots.start();snapshots.getCachedQuote('TSM');
  let timeout;
  try{
    await Promise.race([updated,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('snapshot did not update')),1000);})]);
    const quote=snapshots.getCachedQuote('TSM');
    assert.equal(quote.code,'NAVER_NO_DATA');assert.equal(quote.price,null);
  }finally{clearTimeout(timeout);snapshots.stop();cold.reset();}

  const fallbackQuote={symbol:'TSM',price:453,quoteAt:NOW-10000,sourceCheckedAt:NOW,
    priceSession:'PRE',currency:'USD',src:'tx-batch',pollAfterMs:1000};
  const withFallback=createFastPolling({now:()=>NOW,httpsGet,legacy:{tencent:async()=>[fallbackQuote],fetchSnapshotBatch:naver}});
  const result=await withFallback.fetchSnapshotBatch(['TSM'],{group:'us',force:true});
  assert.equal(result.quotes[0].price,453);
  assert.equal(result.identityIssues.TSM,'NAVER_NO_DATA');
  withFallback.reset();
});

test('TSM minute history uses the exact NYSE identity and real 9/24 OHLC and interval volume',async()=>{
  const identity=naverSearchIdentity(fixture.search,'TSM'),calls=[];
  const history=createNaverWorldHistory({now:()=>NOW,resolveCode:async()=>identity,httpsGet:async url=>{calls.push(url);return json(fixture.chart);}});
  const start=Date.parse('2026-09-24T13:30:00Z')/1000,end=Date.parse('2026-09-24T20:01:00Z')/1000;
  const chart=await history('TSM',`?interval=5m&period1=${start}&period2=${end}`);
  assert.equal(calls.length,1);
  assert.match(calls[0],/\/chart\/foreign\/ITEM\/NYSE\/TSM\/interval\/5\?/);
  assert.equal(chart.meta.identityProvenance,'naver-search');
  assert.equal(chart.timestamp.length,79);
  assert.equal(chart.indicators.quote[0].open[0],441.81);
  assert.equal(chart.indicators.quote[0].volume[0],265427);
  assert.equal(chart.indicators.quote[0].volume.at(-1),629412);
  assert.ok(chart.timestamp.every(t=>t>=start&&t<=end));
  assert.equal(chart.timestamp.some(t=>t>=Date.parse('2026-09-25T08:00:00Z')/1000),false);
  history.close();
});

test('a failed guessed history code cannot cool down the corrected TSM identity',async()=>{
  let identity={code:'TSM.N',exchange:'NYS',instrumentType:'EQUITY',provenance:'old-guess'};
  const urls=[],history=createNaverWorldHistory({now:()=>NOW,resolveCode:async()=>identity,
    httpsGet:async url=>{urls.push(url);return json(url.includes('/TSM.N/')?
      {...fixture.chart,reutersCode:'TSM.N',candleList:[]}:fixture.chart);}});
  const start=Date.parse('2026-09-24T13:30:00Z')/1000,end=Date.parse('2026-09-24T20:01:00Z')/1000;
  await assert.rejects(history('TSM',`?interval=5m&period1=${start}&period2=${end}`),{code:'HISTORY_EMPTY'});
  identity=naverSearchIdentity(fixture.search,'TSM');
  const corrected=await history('TSM',`?interval=5m&period1=${start}&period2=${end}`);
  assert.equal(corrected.timestamp.length,79);
  assert.equal(urls.length,2);
  history.close();
});

test('Naver chart and financial identity conflicts invalidate the shared mapping',async()=>{
  const identity=naverSearchIdentity(fixture.search,'TSM'),invalid=[];
  const start=Date.parse('2026-09-24T13:30:00Z')/1000,end=Date.parse('2026-09-24T20:01:00Z')/1000;
  const history=createNaverWorldHistory({now:()=>NOW,resolveCode:async()=>identity,
    invalidateIdentity:(...args)=>invalid.push(args),httpsGet:async()=>json({...fixture.chart,stockExchangeType:'NASDAQ'})});
  await assert.rejects(history('TSM',`?interval=5m&period1=${start}&period2=${end}`),{code:'HISTORY_IDENTITY_CONFLICT'});
  assert.equal(invalid[0][0],'TSM');assert.equal(invalid[0][1].code,'TSM');history.close();

  const batch={resolveNaverIdentity:async()=>identity,invalidateNaverIdentity:(...args)=>invalid.push(args)};
  const sources=createFinancialSources({batch,now:()=>NOW,httpsGet:async()=>json({...fixture.quote.datas[0],stockExchangeType:{...fixture.quote.datas[0].stockExchangeType,code:'NSQ'}})});
  await assert.rejects(sources.find(x=>x.id==='naver-basic').load('TSM',{}),{code:'FUNDAMENTALS_IDENTITY'});
  assert.equal(invalid[1][2],'NAVER_FINANCIAL_IDENTITY_CONFLICT');
});
