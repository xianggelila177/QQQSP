import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createHistoryService} from '../../lib/history-service.js';
import {chartCloseConflict} from '../../lib/history-close-consistency.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {parseContextQuery} from '../../lib/context-query.js';

const at=Date.parse('2026-09-26T01:30:00Z');
const quote={symbol:'LITE',src:'naver-us',currency:'USD',instrumentType:'EQUITY',price:942.77,
 regularPrice:941.65,regularQuoteAt:Date.parse('2026-09-25T20:00:00Z'),quoteAt:Date.parse('2026-09-26T00:00:00Z'),priceSession:'POST'};
const chart=(close=959.50)=>({source:'eastmoney-history',retrievalLimited:true,
 meta:{symbol:'LITE',currency:'USD',exchangeTimezoneName:'America/New_York',instrumentType:'EQUITY',dataGranularity:'1d'},
 timestamp:['2026-09-24','2026-09-25'].map(d=>Date.parse(d+'T12:00:00Z')/1000),
 indicators:{quote:[{open:[923.83,936.035],high:[954.45,962.88],low:[912,913.29],close:[929.04,close],volume:[null,null]}]}});
const ok=body=>({status:200,body:JSON.stringify(body)});
const daily=close=>({data:{symbol:'LITE',tradesTable:{rows:[{date:'09/25/2026',open:'936.035',high:'962.8797',low:'913.29',close:String(close),volume:'3861501'}]}}});
const east=()=>({data:{code:'LITE',market:105,klines:['2026-09-24,923.83,929.04,954.45,912,3677013','2026-09-25,936.035,959.50,962.88,913.29,3861501']}});

test('LITE same-date close conflict compares regular close, not POST headline or another date',()=>{
 assert.equal(chartCloseConflict('LITE',chart(),quote,at).quoteClose,941.65);
 assert.equal(chartCloseConflict('LITE',chart(941.65),quote,at),null);
 assert.equal(chartCloseConflict('LITE',chart(),{...quote,regularQuoteAt:Date.parse('2026-09-24T20:00:00Z'),regularPrice:929.04},at),null);
 assert.equal(chartCloseConflict('LITE',chart(),{...quote,regularQuoteAt:Date.parse('2026-09-25T18:00:00Z')},at),null);
 assert.equal(chartCloseConflict('LITE',chart(),{...quote,regularQuoteAt:Date.parse('2026-09-25T19:59:30Z')},at),null);
 assert.equal(chartCloseConflict('LITE',chart(),{...quote,currency:'TWD'},at),null);
});

test('cached conflicting date is quarantined in every aggregate without rewriting source OHLC',async()=>{
 let visible=null;
 const service=createHistoryService({now:()=>at,getQuote:()=>visible,fetchChart:async()=>chart()});
 try{
  assert.equal((await service.get('LITE','daily',{count:2})).bars.at(-1).c,959.5);
  visible=quote;
  for(const period of ['daily','weekly','monthly','yearly']){
   const result=await service.get('LITE',period,{count:1,cacheOnly:true});
   assert.equal(result.errorCode,'HISTORY_CLOSE_CONFLICT');assert.equal(result.historyAsOf,'2026-09-24');
   assert.equal(result.bars.at(-1).c,929.04);
  }
  assert.equal(service.exportState().entries[0].rows.at(-1)[4],959.5);
  const d=await service.get('LITE','daily',{count:1,cacheOnly:true});
  const out=buildMarketContext({query:parseContextQuery({symbol:'LITE',include:['daily'],daily_bar_count:1}),requestId:'fixture',generatedAt:at,quote,daily:d});
  assert.equal(out.sections.daily.status,'partial');assert.equal(out.sections.daily.missing_reason,'HISTORY_CLOSE_CONFLICT');
  assert.ok(out.quality.warnings.includes('daily_close_conflict'));
 }finally{service.close();}
});

test('wider Eastmoney probe cannot displace healthy official Nasdaq daily close',async()=>{
 let clock=at;
 const source=createPublicHistory({now:()=>clock,getQuote:()=>quote,httpsGet:async url=>ok(url.includes('nasdaq')?daily(941.65):east())});
 try{
  assert.equal((await source('LITE','?interval=1d&range=2y')).source,'nasdaq-history');
  clock+=300001;await source('LITE','?interval=1d&range=2y');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await source('LITE','?interval=1d&range=2y')).indicators.quote[0].close.at(-1),941.65);
 }finally{source.close();}
});

test('conflicting fallback is rejected when official history is unavailable',async()=>{
 const source=createPublicHistory({now:()=>at,getQuote:()=>quote,httpsGet:async url=>url.includes('nasdaq')?{status:503}:ok(east())});
 try{await assert.rejects(source('LITE','?interval=1d&range=2y'),{code:'HISTORY_CLOSE_CONFLICT'});}
 finally{source.close();}
});

test('expired Nasdaq cache refreshes current tail before older-history expansion',async()=>{
 let clock=at,close=941.65;const ends=[];
 const source=createPublicHistory({now:()=>clock,httpsGet:async url=>{
  if(!url.includes('nasdaq'))return {status:503};
  const end=new URL(url).searchParams.get('todate');ends.push(end);return ok(daily(close));
 }});
 try{
  await source('LITE','?interval=1d&range=2y');clock+=300001;close=941.66;
  const next=await source('LITE','?interval=1d&range=2y');
  assert.equal(ends[1],'2026-09-26');assert.equal(next.indicators.quote[0].close.at(-1),941.66);
 }finally{source.close();}
});

test('Nasdaq lagging wide history confirms the missing close with one bounded same-source tail',async()=>{
 const urls=[],older={data:{symbol:'LITE',tradesTable:{rows:[{date:'09/24/2026',open:'923.83',high:'954.45',low:'912',close:'929.04',volume:'3677013'}]}}};
 const source=createPublicHistory({now:()=>at,getQuote:()=>quote,httpsGet:async url=>{
  urls.push(url);assert.ok(url.startsWith('https://api.nasdaq.com/'));
  return ok(new URL(url).searchParams.get('limit')==='10'?daily(941.65):older);
 }});
 try{
  const result=await source('LITE','?interval=1d&range=2y');
  assert.equal(urls.length,2);const tail=new URL(urls[1]).searchParams;
  assert.deepEqual([tail.get('fromdate'),tail.get('todate'),tail.get('limit')],['2026-09-23','2026-09-26','10']);
  assert.equal(result.source,'nasdaq-history');assert.equal(result.coverage.lastTradingDate,'2026-09-25');
  assert.deepEqual(result.indicators.quote[0].close,[929.04,941.65]);
  assert.equal(result.coverage.recentTail.status,'confirmed');
  await source('LITE','?interval=1d&range=2y');assert.equal(urls.length,2,'a complete cached tail needs no extra request');
 }finally{source.close();}
});

test('Nasdaq recent-tail gaps retain real older rows, honor range/budget and propagate reader cancellation',async()=>{
 const older={data:{symbol:'LITE',tradesTable:{rows:[{date:'09/24/2026',open:'923.83',high:'954.45',low:'912',close:'929.04',volume:'3677013'}]}}};
 for(const mode of ['empty','failure','outside-range','no-budget','cancel']){
  let calls=0;const controller=new AbortController();
  const source=createPublicHistory({now:()=>at,getQuote:()=>quote,httpsGet:async url=>{
   calls++;if(new URL(url).searchParams.get('limit')!=='10')return ok(older);
   if(mode==='cancel'){controller.abort(Object.assign(new Error('reader left'),{code:'TEST_READER_CANCELLED'}));return ok(daily(941.65));}
   return mode==='empty'?ok({data:{symbol:'LITE',tradesTable:{rows:[]}}}):{status:503};
  }});
  try{
   const query=mode==='outside-range'?'?interval=1d&range=2y&period2='+Date.parse('2026-09-25T00:00:00Z')/1000:'?interval=1d&range=2y';
   const pending=source('LITE',query,{signal:controller.signal,...(mode==='no-budget'?{deadlineMs:1}:{})});
   if(mode==='cancel'){await assert.rejects(pending,{code:'TEST_READER_CANCELLED'});continue;}
   const result=await pending;
   assert.equal(result.coverage.lastTradingDate,'2026-09-24',mode);
   assert.deepEqual(result.indicators.quote[0].close,[929.04],mode);
   if(mode==='outside-range'){assert.equal(calls,1);assert.equal(result.coverage.recentTail,undefined);}
   else{
    assert.equal(calls,mode==='no-budget'?1:2);assert.equal(result.coverage.stopReason,'recent-tail-unavailable');
    assert.equal(result.coverage.recentTail.expectedTradeDate,'2026-09-25');
    assert.equal(result.coverage.recentTail.status,mode==='no-budget'?'skipped':'unavailable');
   }
  }finally{source.close();}
 }
});
