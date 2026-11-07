import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createNaverWorldDailyHistory} from '../../lib/providers/naver-world-daily.js';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {parseYahooJapanPage,yahooJapanQuote,createYahooJapan} from '../../lib/providers/yahoo-jp.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createHistoryService} from '../../lib/history-service.js';
import {projectRegularBars} from '../../lib/regular-chart-service.js';
import {hostGroup} from '../../lib/source-registry.js';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/japan-sources.json',import.meta.url),'utf8'));
const at=Date.parse(fixture.checkedAt),symbol='285A.T',now=()=>at;
const html=data=>'<script>self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify(['$',null,null,{state:data}])+'\n'])+')</script>';
const response=data=>({status:200,body:JSON.stringify(data)});
const identity={code:symbol,exchange:'TYO',instrumentType:'EQUITY'};
const query='?interval=1d&period1=1790812800&period2=1794096000';
const page=()=>parseYahooJapanPage(html(fixture.page),symbol);

test('live Japanese history page yields a dated JPY backup quote without PTS contamination',()=>{
 const p=page(),q=yahooJapanQuote(p,symbol,at);
 assert.equal(p.rows.length,20);assert.equal(q.price,8511);assert.equal(q.currency,'JPY');assert.equal(q.src,'yahoo-jp');
 assert.equal(q.quoteAt,Date.parse('2026-11-06T15:30:00+09:00'));assert.equal(q.quoteTimePrecision,'date');
 assert.equal(q.sourceCheckedAt,at);assert.equal(q.prevClose,9324);assert.equal(q.change,-813);
 assert.equal(q.previousCloseStatus,'source-aligned');
});
test('Japanese page parser rejects wrong listing and venue; dates cannot become future quotes',()=>{
 for(const patch of [{codeWithMarketExtension:'6758.T'},{marketDetailCode:'NYS'},{code:'6758'}]){
  const f=structuredClone(fixture.page);Object.assign(f.priceBoard.board,patch);assert.throws(()=>parseYahooJapanPage(html(f),symbol));
 }
 const p=page();p.board.time='23:59';assert.throws(()=>yahooJapanQuote(p,symbol,at));
 p.board.time='11/5';assert.throws(()=>yahooJapanQuote(p,symbol,at));
 assert.notEqual(hostGroup('https://finance.yahoo.co.jp/quote/285A.T'),hostGroup('https://query1.finance.yahoo.com/v8/finance/chart/285A.T'));
});
test('split announcement rows remain annotations and never become fake candles',()=>{
 const f=structuredClone(fixture.page);f.history.history.histories.push({date:'2026-09-29',splitText:'分割：1株→3株'});
 const parsed=parseYahooJapanPage(html(f),symbol);assert.equal(parsed.rows.length,20);
 assert.deepEqual(parsed.corporateActions,[{date:'2026-09-29',note:'分割：1株→3株'}]);
});
test('Naver rate limit does not prevent Japanese backup refresh and Retry-After is honored',async()=>{
 let clock=at,naverCalls=0,backupCalls=0;
 const provider=createBatchProvider({now:()=>clock,httpsGet:async()=>{naverCalls++;return {status:429,headers:{'retry-after':'900'}};},
  japanQuote:async()=>{backupCalls++;return yahooJapanQuote(page(),symbol,clock);}});
 const first=await provider.fetchSnapshotBatch([symbol],{group:'jp'});clock+=61000;
 const second=await provider.fetchSnapshotBatch([symbol],{group:'jp'});
 assert.equal(naverCalls,1);assert.equal(backupCalls,2);assert.equal(first.quotes[0].src,'yahoo-jp');
 assert.equal(second.quotes[0].sourceCheckedAt,clock);assert.equal(second.pollAfterMs,60000);
 provider.close();
});
test('missing Japanese batch row falls back independently, rejecting stale and wrong-currency backups',async()=>{
 let finalCalls=0;const good=yahooJapanQuote(page(),symbol,at);
 const provider=createBatchProvider({now,httpsGet:async()=>response({pollingInterval:70000,datas:[]}),
  japanQuote:async()=>({...good,currency:'USD'}),fallbackQuote:async()=>{finalCalls++;return {...good,src:'yahoo'};}});
 const result=await provider.fetchSnapshotBatch([symbol],{group:'jp'});assert.equal(result.quotes[0].src,'yahoo');assert.equal(finalCalls,1);
 const broken=createBatchProvider({now,httpsGet:async()=>response({datas:[]}),japanQuote:async()=>({...good,stale:true})});
 await assert.rejects(broken.fetchSnapshotBatch([symbol],{group:'jp'}));provider.close();broken.close();
});
test('Japanese daily and weekly histories are available despite global Yahoo cooldown',async()=>{
 const daily=createNaverWorldDailyHistory({now,resolveCode:async()=>identity,httpsGet:async url=>response(url.endsWith('/basic')?fixture.basic:fixture.daily)});
 const source=createHistorySource({now,worldDaily:daily,primary:async()=>{throw Object.assign(Error('global Yahoo cooldown'),{code:'RATE_LIMITED',retryAt:at+900000});}});
 const history=createHistoryService({fetchChart:source,now});
 try{
  const d=await history.get(symbol,'daily',{count:60});assert.equal(d.source,'naver-jp-daily');assert.equal(d.bars.length,25);
  assert.equal(d.bars.at(-1).c,8511);assert.equal(d.bars.at(-1).periodStart,'2026-11-06');assert.equal(d.currency,'JPY');
  const w=await history.get(symbol,'weekly',{count:10});assert.ok(w.bars.length>0);assert.equal(w.bars.at(-1).c,8511);
 }finally{history.close();source.close();}
});
test('Japanese ETF basic endpoint uses stock route plus isEtf, preserving ETF identity',async()=>{
 const daily=createNaverWorldDailyHistory({now,resolveCode:async()=>({code:'1306.T',exchange:'TYO',instrumentType:'ETF'}),
  httpsGet:async url=>response(url.endsWith('/basic')?fixture.etfBasic:fixture.daily)});
 try{const d=await daily('1306.T',query);assert.equal(d.meta.instrumentType,'ETF');assert.equal(d.meta.currency,'JPY');}
 finally{daily.close();}
});
test('Japanese daily identity rejects different currency before accepting unlabelled OHLC arrays',async()=>{
 let calls=0;const daily=createNaverWorldDailyHistory({now,resolveCode:async()=>identity,httpsGet:async()=>{calls++;return response({...fixture.basic,currencyType:{code:'USD'}});}});
 try{await assert.rejects(daily(symbol,query),{code:'HISTORY_IDENTITY_CONFLICT'});assert.equal(calls,1);}finally{daily.close();}
});
test('Japanese minute candles preserve Tokyo time, prices and session gaps',async()=>{
 const minute=createNaverWorldHistory({now,resolveCode:async()=>identity,httpsGet:async()=>response(fixture.minute)});
 try{
  const d=await minute(symbol,'?interval=5m&range=1d');assert.equal(d.source,'naver-jp-chart');assert.equal(d.meta.currency,'JPY');
  const q=d.indicators.quote[0],bars=d.timestamp.map((t,i)=>({t,o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]}));
  const projected=projectRegularBars(symbol,bars,{source:d.source,pointKind:'bar-start',intervalSeconds:300,targetDate:'2026-11-06',now:at});
  assert.ok(projected.bars.length>0);assert.equal(projected.bars[0].o,7900);assert.equal(projected.tradeDate,'2026-11-06');
  assert.ok(projected.bars.every(b=>b.t<Date.parse('2026-11-06T02:30:00Z')/1000));
 }finally{minute.close();}
});
test('independent Japanese daily fallback survives Naver and global Yahoo outages',async()=>{
 const japan=createYahooJapan({now,httpsGet:async()=>({status:200,body:html({...fixture.page,history:{...fixture.page.history,pager:{page:1,hasNext:false}}})})});
 const unavailable=Object.assign(async()=>{throw Object.assign(Error('cooldown'),{code:'SOURCE_COOLDOWN',retryAt:at+900000});},{supports:()=>true});
 const source=createHistorySource({now,worldDaily:unavailable,primary:unavailable,japan:japan.fetchHistory});
 try{const d=await source(symbol,query);assert.equal(d.source,'yahoo-jp-daily');assert.equal(d.timestamp.length,20);assert.equal(d.indicators.quote[0].close.at(-1),8511);}
 finally{source.close();}
});
test('Japanese page cache coalesces readers and cancellation never sends an upstream request',async()=>{
 let calls=0;const japan=createYahooJapan({now,httpsGet:async()=>{calls++;return {status:200,body:html(fixture.page)};}});
 try{
  const results=await Promise.all([japan.getQuote(symbol),japan.getQuote(symbol)]);assert.equal(calls,1);assert.equal(results[0].price,results[1].price);
  await assert.rejects(japan.getQuote(symbol,{signal:AbortSignal.abort()}));assert.equal(calls,1);
 }finally{japan.fetchHistory.close();}
});
