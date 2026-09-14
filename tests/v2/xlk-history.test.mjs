import test from 'node:test';
import assert from 'node:assert/strict';
import {instrumentTypeFor} from '../../lib/instruments.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createHistoryService} from '../../lib/history-service.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';

const at=Date.parse('2026-09-13T15:20:00Z');
import {nasdaqXlkResponse} from './xlk-fixture.mjs';
import {catalogInstrumentFor} from '../../lib/market-registry.js';
test('XLK has authoritative ETF identity without depending on a prior quote',()=>{
 assert.equal(instrumentTypeFor('XLK'),'ETF');assert.equal(instrumentTypeFor('XLK','EQUITY'),'ETF');
 assert.equal(instrumentTypeFor('NVDA'),'EQUITY');assert.equal(instrumentTypeFor('QQQ'),'ETF');assert.notEqual(catalogInstrumentFor('XLKI')?.symbol,'XLK');
});
test('XLK intraday uses the ETF endpoint after the primary fails; cached reads do not refetch',async()=>{
 const urls=[];const fallback=createPublicHistory({now:()=>at,httpsGet:async url=>{urls.push(url);return nasdaqXlkResponse(url);}});
 const source=createHistorySource({now:()=>at,primary:async()=>{throw Object.assign(Error('429'),{status:429});},alternative:fallback});
 const result=await source('XLK','?interval=5m&range=1d&includePrePost=true');
 assert.equal(result.meta.instrumentType,'ETF');assert.equal(result.source,'nasdaq-intraday');assert.equal(result.timestamp.length,2);
 assert.equal(new URL(urls[0]).searchParams.get('assetclass'),'etf');assert.equal(result.timestamp.at(-1),Date.parse('2026-09-12T00:00:00Z')/1000);
 await source('XLK','?interval=5m&range=1d&includePrePost=true');assert.equal(urls.length,1);
});
test('independent daily, weekly, monthly and yearly histories all use the verified XLK ETF route',async()=>{
 const urls=[];const fallback=createPublicHistory({now:()=>at,httpsGet:async url=>{urls.push(url);return nasdaqXlkResponse(url);}});
 const service=createHistoryService({now:()=>at,fetchChart:fallback});
 try{for(const period of ['daily','weekly','monthly','yearly']){
  const result=await service.get('XLK',period,{count:5});assert.ok(result.bars.length>0,period);assert.equal(result.source,'nasdaq-history');assert.equal(result.symbol,'XLK');
  assert.ok(result.bars.every(b=>[b.o,b.h,b.l,b.c].every(Number.isFinite)),period);
 }assert.ok(urls.every(url=>new URL(url).searchParams.get('assetclass')==='etf'));}finally{service.close();}
});
test('XLK Naver listing is explicit and its after-hours quote remains distinct from regular close',async()=>{
 const urls=[];const row={reutersCode:'XLK',symbolCode:'XLK',stockName:'State Street Technology Select Sector SPDR ETF',stockExchangeType:{code:'AMX',nameEng:'American Stock Exchange',delayTime:0},currencyType:{code:'USD'},closePriceRaw:'187.67',compareToPreviousClosePriceRaw:'2.45',localTradedAt:'2026-09-11T16:00:00-04:00',overMarketPriceInfo:{tradingSessionType:'AFTER_MARKET',overPrice:'187.66',localTradedAt:'2026-09-11T20:00:00-04:00'}};
 const provider=createBatchProvider({now:()=>at,httpsGet:async url=>{urls.push(url);assert.match(url,/worldstock\/stock\/XLK$/);return {status:200,body:JSON.stringify({pollingInterval:70000,datas:[row]})};}});
 const out=await provider.fetchSnapshotBatch(['XLK'],{group:'us'});assert.equal(urls.length,1);assert.equal(out.quotes.length,1);assert.equal(out.quotes[0].instrumentType,'ETF');assert.equal(out.quotes[0].priceSession,'POST');assert.equal(out.quotes[0].price,187.66);assert.equal(out.quotes[0].regularPrice,187.67);
 assert.equal(out.quotes[0].quoteAt,Date.parse('2026-09-12T00:00:00Z'));
});
