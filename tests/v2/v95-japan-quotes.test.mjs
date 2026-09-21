import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {providerCapabilities} from '../../lib/instruments.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {catalogSearch} from '../../lib/catalog-search.js';
const checkedAt=Date.parse('2026-09-21T07:00:00Z'),tradedAt=Date.parse('2026-09-18T15:30:00+09:00');
const row=(symbol='9766.T')=>({reutersCode:symbol,symbolCode:symbol.slice(0,-2),stockName:'코나미 그룹',
 stockExchangeType:{code:'TYO',zoneId:'Asia/Tokyo',nationType:'JPN',delayTime:15,nameEng:'Tokyo Stock Exchange'},
 currencyType:{code:'JPY'},closePriceRaw:'21055.0',compareToPreviousClosePriceRaw:'-215.0',compareToPreviousPrice:{name:'FALLING'},
 openPriceRaw:'21255.0',highPriceRaw:'21270.0',lowPriceRaw:'20640.0',accumulatedTradingVolumeRaw:'534900',
 accumulatedTradingValueRaw:'11248143000',localTradedAt:'2026-09-18T15:30:00+09:00',marketStatus:'CLOSE'});
test('numeric and alphanumeric Japanese listings have their own supported quote route',()=>{
 for(const symbol of ['9766.T','6758.T','130A.T','1306.T']){assert.equal(providerCapabilities(symbol).batchGroup,'jp');assert.deepEqual(providerCapabilities(symbol).batchProviders,['naver-jp']);}
 assert.notEqual(providerCapabilities('9766.HK').batchGroup,'jp');assert.notEqual(providerCapabilities('^N225').batchGroup,'jp');
 assert.equal(catalogSearch('130A.T')[0].symbol,'130A.T');assert.equal(catalogSearch('130A')[0].symbol,'130A.T');
});
test('Japanese quote preserves original trade time, currency, volume and verified provider delay on a holiday',()=>{
 const provider=createBatchProvider({now:()=>checkedAt}),quote=provider.parseNaverQuote(row(),'9766.T',70000);
 assert.ok(quote);assert.equal(quote.price,21055);assert.equal(quote.prevClose,21270);assert.equal(quote.change,-215);
 assert.equal(quote.currency,'JPY');assert.equal(quote.market,'日股');assert.equal(quote.src,'naver-jp');
 assert.equal(quote.quoteAt,tradedAt);assert.equal(quote.sourceCheckedAt,checkedAt);assert.equal(quote.volume,534900);assert.equal(quote.turnoverAmount,11248143000);
 assert.equal(quote.feedDelayMinutes,15);assert.equal(quote.isDelayed,true);assert.equal(quote.pollAfterMs,70000);
 assert.equal(quote.stale,undefined);assert.ok(['CLOSED','HOLIDAY'].includes(quote.marketState));
 assert.equal(quote.instrumentType,'EQUITY');assert.equal(provider.parseNaverQuote(row('1306.T'),'1306.T',70000).instrumentType,'ETF');
});
test('Japanese mapping rejects different security, venue, currency, missing ticker and future timestamps',()=>{
 const provider=createBatchProvider({now:()=>checkedAt});
 for(const bad of [{reutersCode:'6758.T'},{symbolCode:'6758'},{reutersCode:null},{stockExchangeType:{code:'NYS',nationType:'USA',zoneId:'America/New_York'}},{currencyType:{code:'USD'}},{localTradedAt:'2026-10-01T15:30:00+09:00'}])assert.equal(provider.parseNaverQuote({...row(),...bad},'9766.T',70000),null,JSON.stringify(bad));
});
test('Japanese batch queries only matching listings and uses upstream pollingInterval',async()=>{
 const requests=[],provider=createBatchProvider({now:()=>checkedAt,httpsGet:async url=>{requests.push(url);return {status:200,body:JSON.stringify({pollingInterval:70000,datas:[row(),row('130A.T'),row('6758.T')]})};}});
 const result=await provider.fetchSnapshotBatch(['9766.T','130A.T','AAPL'],{group:'jp'});
 assert.equal(requests.length,1);assert.match(requests[0],/worldstock\/stock\/9766.T,130A.T$/);
 assert.deepEqual(result.quotes.map(x=>x.symbol),['9766.T','130A.T']);assert.equal(result.pollAfterMs,70000);
});
test('Japanese snapshot still delivers the real quote when Yahoo enrichment fails',async()=>{
 let calls=0;const provider=createBatchProvider({now:()=>checkedAt,httpsGet:async()=>({status:200,body:JSON.stringify({pollingInterval:70000,datas:[row()]})})});
 const service=createSnapshotService({now:()=>checkedAt,fetchBatch:async(...args)=>{calls++;return provider.fetchSnapshotBatch(...args);},enrich:async()=>{throw new Error('Yahoo unavailable');}});
 try{
  service.start();service.getCachedQuote('9766.T');for(let i=0;i<100&&service.getCachedQuote('9766.T').price==null;i++)await new Promise(r=>setTimeout(r,10));
  const quote=service.getCachedQuote('9766.T');assert.equal(quote.price,21055);assert.equal(quote.src,'naver-jp');assert.equal(quote.quoteAt,tradedAt);assert.equal(calls,1);
 }finally{service.stop();}
});
test('regional standard ticker searches are not consumed by the Japanese directory',()=>{
 for(const symbol of ['005930.KS','AAPL','0700.HK','600519.SS','2330.TW'])assert.deepEqual(catalogSearch(symbol).map(row=>row.symbol),[symbol]);
 assert.deepEqual(catalogSearch('000001.SZ'),[]); // Provider-confirmed Shenzhen listing, never a guessed JPX listing.
});
