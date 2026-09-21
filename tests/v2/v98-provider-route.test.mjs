import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';

const BASE=Date.parse('2026-09-21T13:19:30Z');
const identity=(symbol='SOXL')=>({code:symbol,name:'Direxion Daily Semiconductor Bull 3X ETF',typeCode:'AMEX',nationCode:'USA',isEtf:true,reutersCode:symbol+'.K',url:'/worldstock/etf/'+symbol+'.K'});
const searchResult=items=>({isSuccess:true,result:{items}});
function tencentRow(symbol='SOXL'){
 const f=Array(80).fill('');Object.assign(f,{1:symbol,2:symbol+'.AM',3:'123.67',4:'114.82',5:'117.03',6:'45459718',30:'2026-09-18 16:00:01',33:'123.90',34:'116.68',35:'USD',70:'GP-ETF'});
 return `v_us${symbol}="${f.join('~')}";`;
}
// Identity and timestamps are a reduced copy of Naver's actual SOXL response,
// verified 2026-09-21. The regular close and new premarket trade are distinct.
const realtime=(at=BASE-1000)=>({reutersCode:'SOXL.K',symbolCode:'SOXL',stockName:'Direxion Daily Semiconductor Bull 3X ETF',
 stockExchangeType:{code:'AMX',zoneId:'EST5EDT',nationType:'USA',nationCode:'USA',delayTime:0,nameEng:'American Stock Exchange'},currencyType:{code:'USD'},
 closePriceRaw:'123.67',compareToPreviousClosePriceRaw:'8.85',localTradedAt:'2026-09-18T16:00:00-04:00',openPriceRaw:'117.03',highPriceRaw:'123.90',lowPriceRaw:'116.68',accumulatedTradingVolumeRaw:'45459718',
 overMarketPriceInfo:{tradingSessionType:'PRE_MARKET',overPrice:'132.38',localTradedAt:new Date(at).toISOString()}});
const json=body=>({status:200,body:JSON.stringify(body)});

test('unknown AMEX ETF resolves its actual .K identity and keeps polling fresh premarket trades',async()=>{
 let now=BASE;const urls=[];
 const httpsGet=async url=>{urls.push(url);if(url.includes('sinajs'))return {status:200,body:''};if(url.includes('qt.gtimg'))return {status:200,body:tencentRow()};
  if(url.includes('/search/autoComplete'))return json(searchResult([identity()]));
  assert.ok(url.endsWith('/worldstock/stock/SOXL.K'),url);return json({pollingInterval:7000,datas:[realtime(now-1000)]});};
 const batch=createBatchProvider({now:()=>now,httpsGet,pollMs:1000}),polling=createFastPolling({now:()=>now,httpsGet,legacy:batch,pollMs:1000});
 const first=(await polling.fetchSnapshotBatch(['SOXL'],{group:'us'})).quotes[0];
 assert.equal(first.src,'naver-us');assert.equal(first.price,132.38);assert.equal(first.instrumentType,'ETF');assert.equal(first.instrumentTypeSource,'provider');
 assert.equal(first.priceSession,'PRE');assert.equal(first.quoteAt,BASE-1000);assert.equal(first.regularQuoteAt,Date.parse('2026-09-18T20:00:00Z'));
 now+=1000;const cached=(await polling.fetchSnapshotBatch(['SOXL'],{group:'us'})).quotes[0];assert.equal(cached.sourceCheckedAt,BASE,'cache reads never advance the provider clock');
 now=BASE+7000;const next=(await polling.fetchSnapshotBatch(['SOXL'],{group:'us'})).quotes[0];assert.equal(next.quoteAt,now-1000);assert.equal(next.sourceCheckedAt,now);
 assert.equal(urls.filter(u=>u.includes('/search/autoComplete')).length,1,'identity is cached independently of quote polling');
 assert.equal(urls.filter(u=>u.endsWith('/worldstock/stock/SOXL.K')).length,2,'the 7 second provider TTL remains authoritative');
 batch.close?.();
});

test('unresolved identities are negatively cached and never manufacture a Naver route',async()=>{
 let now=BASE,searches=0,quotes=0;
 const batch=createBatchProvider({now:()=>now,httpsGet:async url=>{
  if(url.includes('qt.gtimg'))return {status:200,body:tencentRow()};
  if(url.includes('/search/autoComplete')){searches++;return json(searchResult([{...identity(),code:'SOXS'}]));}
  quotes++;return json({pollingInterval:7000,datas:[realtime()]});
 }});
 for(const elapsed of [0,1000,60000]){now=BASE+elapsed;const result=await batch.fetchSnapshotBatch(['SOXL'],{group:'us'});assert.equal(result.quotes[0].src,'tx-batch');}
 assert.equal(searches,1);assert.equal(quotes,0,'a similar symbol cannot become SOXL');
 now=BASE+600001;await batch.fetchSnapshotBatch(['SOXL'],{group:'us'});assert.equal(searches,2);batch.close?.();
});

test('a discovered route still rejects a wrong currency, venue, zone or country quote',async()=>{
 for(const bad of [{currencyType:{code:'CAD'}},{stockExchangeType:{...realtime().stockExchangeType,code:'NSQ'}},{stockExchangeType:{...realtime().stockExchangeType,zoneId:'Asia/Tokyo'}},{stockExchangeType:{...realtime().stockExchangeType,nationCode:'JPN'}},{symbolCode:'SOXS'},{reutersCode:'SOXL.O'}]){
  let searched=false;
  const batch=createBatchProvider({now:()=>BASE,httpsGet:async url=>{
   if(url.includes('qt.gtimg'))return {status:200,body:tencentRow()};
   if(url.includes('/search/autoComplete')){searched=true;return json(searchResult([identity()]));}
   return json({pollingInterval:7000,datas:[{...realtime(),...bad}]});
  }});
  const result=await batch.fetchSnapshotBatch(['SOXL'],{group:'us'});assert.equal(searched,true);assert.equal(result.quotes[0].src,'tx-batch',JSON.stringify(bad));batch.close?.();
 }
});

test('identity lookups have bounded concurrency, singleflight, cancellation and Retry-After',async()=>{
 let now=BASE,searches=0,active=0,peak=0,limited=false;const pending=[];
 const batch=createBatchProvider({now:()=>now,httpsGet:async(url,headers,{signal})=>{
  if(url.includes('qt.gtimg'))return {status:200,body:['SOXL','LABU','TECL','TNA'].map(tencentRow).join('')};
  searches++;if(limited)return {status:429,headers:{'retry-after':'120'},body:''};
  active++;peak=Math.max(peak,active);
  return new Promise((resolve,reject)=>{const finish=()=>{active--;signal.removeEventListener('abort',abort);resolve(json(searchResult([])));};const abort=()=>{active--;reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});pending.push(finish);});
 }});
 const a=new AbortController(),b=new AbortController();
 const first=batch.resolveNaverCode('SOXL',{signal:a.signal}),same=batch.resolveNaverCode('SOXL',{signal:b.signal});
 const second=batch.resolveNaverCode('LABU'),third=batch.resolveNaverCode('TECL');
 for(let i=0;i<20;i++)await Promise.resolve();
 assert.equal(searches,2);assert.equal(peak,2);assert.equal(await third,null);
 a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(active,2,'one departing reader cannot cancel the other reader');
 pending.shift()();pending.shift()();assert.equal(await same,null);assert.equal(await second,null);
 limited=true;assert.equal(await batch.resolveNaverCode('TNA'),null);const before=searches;now+=119000;assert.equal(await batch.resolveNaverCode('TNA'),null);assert.equal(searches,before);
 now+=1001;await batch.resolveNaverCode('TNA');assert.equal(searches,before+1);batch.close?.();
});

test('Tencent opening-clock placeholders cannot beat a current Naver premarket trade',async()=>{
 let now=Date.parse('2026-09-21T13:28:00Z'),naverCalls=0;
 const future=tencentRow().replace('2026-09-18 16:00:01','2026-09-21 09:30:00');
 const healthy=tencentRow('NVDA').replace('2026-09-18 16:00:01','2026-09-21 09:27:59');
 const httpsGet=async url=>{
  if(url.includes('sinajs'))return {status:200,body:''};
  if(url.includes('qt.gtimg'))return {status:200,body:future+healthy};
  if(url.includes('/search/autoComplete'))return json(searchResult([identity()]));
  naverCalls++;return json({pollingInterval:7000,datas:[realtime(now-1000)]});
 };
 const batch=createBatchProvider({now:()=>now,httpsGet,pollMs:1000});
 assert.deepEqual(batch.parseTencentBatch(future+healthy,['SOXL','NVDA']).map(q=>q.symbol),['NVDA'],'one future row must not poison a healthy sibling');
 const skew=tencentRow().replace('2026-09-18 16:00:01','2026-09-21 09:28:05');
 assert.equal(batch.parseTencentBatch(skew,['SOXL']).length,1,'provider tolerance is bounded at five seconds');
 assert.equal(batch.parseTencentBatch(skew.replace('09:28:05','09:28:06'),['SOXL']).length,0);
 const polling=createFastPolling({now:()=>now,httpsGet,legacy:batch,pollMs:1000});
 const first=(await polling.fetchSnapshotBatch(['SOXL'],{group:'us'})).quotes[0];
 assert.equal(first.src,'naver-us');assert.equal(first.price,132.38);assert.equal(first.quoteAt,now-1000);assert.equal(first.priceSession,'PRE');
 now+=7000;const next=(await polling.fetchSnapshotBatch(['SOXL'],{group:'us'})).quotes[0];
 assert.equal(next.quoteAt,now-1000);assert.equal(next.sourceCheckedAt,now);assert.equal(naverCalls,2);batch.close();
});

test('a future Naver extended timestamp cannot replace a valid regular quote or its sibling',async()=>{
 const now=Date.parse('2026-09-21T13:28:00Z'),future=realtime(now+120000);
 const batch=createBatchProvider({now:()=>now,httpsGet:async()=>json({pollingInterval:7000,datas:[
  {...future,reutersCode:'AAPL.O',symbolCode:'AAPL'},
  {...realtime(now-1000),reutersCode:'NVDA.O',symbolCode:'NVDA'}
 ]})});
 const regular=batch.parseNaverQuote(future,'SOXL',7000);
 assert.equal(regular.price,123.67);assert.equal(regular.quoteAt,Date.parse('2026-09-18T20:00:00Z'));assert.equal(regular.ext,null);
 const result=await batch.fetchSnapshotBatch(['AAPL','NVDA'],{group:'us'});
 assert.equal(result.quotes.length,2);assert.equal(result.quotes.find(q=>q.symbol==='AAPL').quoteAt,regular.quoteAt);
 assert.equal(result.quotes.find(q=>q.symbol==='NVDA').quoteAt,now-1000);assert.equal(result.quotes.find(q=>q.symbol==='NVDA').price,132.38);batch.close();
});
