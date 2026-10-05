import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createTwseHistory} from '../../lib/providers/twse-history.js';
import {createNaverWorldDailyHistory} from '../../lib/providers/naver-world-daily.js';
import {createNaverIndexProvider} from '../../lib/providers/naver-index.js';

const NOW=Date.parse('2026-10-02T08:00:00Z'),DAY=86400000;
const ok=body=>({status:200,body:JSON.stringify(body)});
function nasdaqFixture(calls){return async url=>{
 if(!url.includes('nasdaq.com'))return ok({data:null});
 const p=new URL(url).searchParams,from=p.get('fromdate'),through=p.get('todate');calls.push({from,through});
 const rows=[];
 for(let at=Date.parse(from+'T00:00:00Z');at<=Date.parse(through+'T00:00:00Z');at+=DAY){
  const d=new Date(at);if([0,6].includes(d.getUTCDay()))continue;
  const date=d.toISOString().slice(0,10);if(date>'2026-10-01'||date<'2010-01-01')continue;
  rows.push({date,open:'100',high:date==='2025-01-02'?'900':'102',low:'98',close:'101',volume:'100'});
 }
 return ok({data:{symbol:'NVDA',tradesTable:{rows:rows.reverse()}}});
};}
function setupNasdaq(t){
 const calls=[],quote={symbol:'NVDA',currency:'USD',instrumentType:'EQUITY'};
 const provider=createPublicHistory({now:()=>NOW,getQuote:()=>quote,httpsGet:nasdaqFixture(calls)});
 const source=createHistorySource({now:()=>NOW,getQuote:()=>quote,alternative:provider});
 const history=createHistoryService({now:()=>NOW,fetchChart:source});
 t.after(()=>{history.close();source.close();});return {calls,provider,history};
}

test('Nasdaq bounded yearly history exposes continuation and advances before 2025 without refetching the latest window',async t=>{
 const {calls,history}=setupNasdaq(t);
 const first=await history.get('NVDA','yearly',{count:20});
 assert.equal(first.hasMore,true);assert.equal(first.extent.satisfied,false);assert.ok(calls.length<=2);
 const anchor=first.bars[0].periodStart,beforeCalls=calls.length;
 const older=await history.get('NVDA','yearly',{count:20,before:anchor,seriesId:first.seriesId});
 assert.ok(older.bars.length>0);assert.ok(older.bars[0].periodStart<'2025-01-01');
 assert.ok(older.bars.every(bar=>bar.periodStart<anchor));assert.ok(calls.length-beforeCalls<=2);
 assert.ok(calls.slice(beforeCalls).every(page=>page.through<calls[0].from));
 assert.equal(older.overlapBars?.[0]?.periodStart,anchor);
});

test('Nasdaq fresh bounded provider cache does not claim a previously attempted twenty-year request is satisfied',async t=>{
 const {calls,provider}=setupNasdaq(t),query='?interval=1d&period1='+Date.parse('2006-01-01T00:00:00Z')/1000+'&period2='+Math.floor(NOW/1000);
 const first=await provider('NVDA',query),firstOldest=first.timestamp[0],count=calls.length;
 const wider=await provider('NVDA',query);
 assert.ok(wider.timestamp[0]<firstOldest);assert.ok(calls.length>count);assert.ok(calls.length-count<=2);
 const old=await provider('NVDA','?interval=1d&period1='+Date.parse('2018-01-01T00:00:00Z')/1000+'&period2='+Date.parse('2021-01-01T00:00:00Z')/1000,{pageBefore:'2021-01-01'});
 assert.ok(old.timestamp.every(at=>at<Date.parse('2021-01-01T00:00:00Z')/1000));
 assert.ok(old.timestamp.some(at=>at<Date.parse('2020-01-01T00:00:00Z')/1000));
});

test('monthly history continues beyond twelve months with an exclusive older cursor and bounded source requests',async t=>{
 const {calls,history}=setupNasdaq(t);
 const first=await history.get('NVDA','monthly',{count:79});assert.ok(first.bars.length>12);assert.equal(first.hasMore,true);
 const before=first.nextBefore,count=calls.length,older=await history.get('NVDA','monthly',{count:79,before,seriesId:first.seriesId});
 assert.ok(older.bars.length>12);assert.ok(older.bars.every(bar=>bar.periodStart<before));assert.ok(older.nextBefore<before);
 assert.ok(calls.length-count<=2);assert.equal(older.overlapBars?.[0]?.periodStart,before);
});

function twseFixture(calls){return async url=>{
 const date=new URL(url).searchParams.get('date'),year=Number(date.slice(0,4)),month=Number(date.slice(4,6));calls.push(date);
 const rows=[];
 for(let d=1;d<=31;d++){
  const at=new Date(Date.UTC(year,month-1,d));if(at.getUTCMonth()!==month-1||[0,6].includes(at.getUTCDay())||at.getTime()>NOW)continue;
  rows.push([`${year-1911}/${String(month).padStart(2,'0')}/${String(d).padStart(2,'0')}`,'100',year===2025&&month===1?'900':'102','98','101','100']);
 }
 return ok({stat:'OK',date,title:`${year-1911}年${month}月 2330 台積電`,fields:['日期','開盤價','最高價','最低價','收盤價','成交股數'],data:rows});
};}
test('TWSE yearly continuation preserves the exclusive cursor and supplies the repaired boundary-year candle',async t=>{
 const calls=[],provider=createTwseHistory({now:()=>NOW,httpsGet:twseFixture(calls)});
 const source=createHistorySource({now:()=>NOW,twse:provider}),history=createHistoryService({now:()=>NOW,fetchChart:source});
 t.after(()=>{history.close();source.close();});
 const first=await history.get('2330.TW','yearly',{count:20});
 assert.equal(first.hasMore,true);assert.equal(first.bars[0].periodStart,'2025-01-01');assert.equal(first.bars[0].h,102);assert.ok(calls.length<=12);
 const count=calls.length,older=await history.get('2330.TW','yearly',{count:20,before:first.nextBefore,seriesId:first.seriesId});
 assert.ok(older.bars.some(bar=>bar.periodStart<'2025-01-01'));assert.ok(older.bars.every(bar=>bar.periodStart<'2025-01-01'));
 assert.ok(calls.length-count<=12);assert.equal(older.overlapBars?.find(bar=>bar.periodStart==='2025-01-01')?.h,900);
});

test('verified world daily route precedes a bounded recent fallback and never handles minute requests',async t=>{
 const calls=[],make=(source,date)=>({source,meta:{symbol:'NVDA',currency:'USD',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp:[Date.parse(date+'T12:00:00Z')/1000],indicators:{quote:[{open:[100],high:[102],low:[98],close:[101]}]}});
 const daily=make('naver-world-daily','2020-06-01'),fallback=make('nasdaq-history','2026-10-01');let unavailable=false;
 const worldDaily=Object.assign(async()=>{calls.push('daily');if(unavailable)throw Object.assign(Error('empty'),{code:'HISTORY_EMPTY'});return daily;},{supports:()=>true});
 const alternative=Object.assign(async()=>{calls.push('alternative');return fallback;},{supports:()=>true});
 const source=createHistorySource({now:()=>NOW,worldDaily,alternative});t.after(()=>source.close());
 assert.equal((await source('NVDA','?interval=1d&period1=1577836800&period2=1609459200')).source,'naver-world-daily');
 assert.equal(calls[0],'daily');
 calls.length=0;await source('NVDA','?interval=5m');assert.ok(!calls.includes('daily'));
 unavailable=true;source.invalidate('NVDA');assert.equal((await source('NVDA','?interval=1d')).source,'nasdaq-history');
});

test('a verified source change during backfill replaces the series instead of splicing or permanently retrying the old identity',async t=>{
 let source='nasdaq-history';
 const history=createHistoryService({now:()=>NOW,fetchChart:async(_symbol,_query,options)=>{
  const dates=source==='nasdaq-history'?['2025-11-03','2026-10-01']:options.pageBefore?['2020-01-02','2024-12-31']:['2020-01-02','2024-12-31','2026-10-01'];
  return {source,sourceCheckedAt:NOW,retrievalLimited:true,hasMore:true,coverage:{firstTradingDate:dates[0]},meta:{symbol:'NVDA',currency:'USD',exchangeName:'NMS',exchangeTimezoneName:'America/New_York',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp:dates.map(date=>Date.parse(date+'T12:00:00Z')/1000),indicators:{quote:[{open:dates.map(()=>100),high:dates.map(()=>102),low:dates.map(()=>98),close:dates.map(()=>101)}]}};
 }});t.after(()=>history.close());
 const first=await history.get('NVDA','yearly',{count:20});source='naver-world-daily';
 await assert.rejects(history.get('NVDA','yearly',{count:20,before:first.nextBefore,seriesId:first.seriesId}),{code:'HISTORY_SERIES_CHANGED'});
 const next=await history.get('NVDA','yearly',{count:20});assert.equal(next.source,'naver-world-daily');assert.notEqual(next.seriesId,first.seriesId);
 assert.equal(next.bars.at(-1).periodStart,'2026-01-01');assert.ok(!next.bars.some(bar=>bar.periodStart==='2025-01-01'),'the prior source-only year is not spliced into the replacement');
});

test('verified Naver adapter and history service extend real daily OHLC in bounded ten-year segments and repair the boundary year',async t=>{
 const calls=[],identity={code:'NVDA.O',exchange:'NSQ',instrumentType:'EQUITY',provenance:'fixture-verified'},quote={symbol:'NVDA',currency:'USD',instrumentType:'EQUITY'};
 const provider=createNaverWorldDailyHistory({now:()=>NOW,resolveCode:async()=>identity,httpsGet:async url=>{
  calls.push(url);if(url.endsWith('/basic'))return ok({symbolCode:'NVDA',reutersCode:'NVDA.O',currencyType:{code:'USD'},stockEndType:'stock',isEtf:false,stockExchangeType:{code:'NSQ',zoneId:'EST5EDT',nationCode:'USA'}});
  const p=new URL(url).searchParams,stamp=key=>{const v=p.get(key);return Date.parse(v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8)+'T00:00:00Z');},from=stamp('startDateTime'),through=stamp('endDateTime');
  assert.ok((through-from)/DAY<3660);const rows=[];
  for(let at=from;at<=Math.min(through,Date.parse('2026-10-01T00:00:00Z'));at+=DAY){const d=new Date(at);if([0,6].includes(d.getUTCDay()))continue;
   const date=d.toISOString().slice(0,10);rows.push({localDate:date.replaceAll('-',''),openPrice:100,highPrice:date==='2016-01-04'?777:102,lowPrice:98,closePrice:101,accumulatedTradingVolume:1234});
  }return ok(rows);
 }});
 const source=createHistorySource({now:()=>NOW,worldDaily:provider,getQuote:()=>quote}),history=createHistoryService({now:()=>NOW,fetchChart:source});t.after(()=>{history.close();source.close();});
 const first=await history.get('NVDA','yearly',{count:39});assert.equal(first.source,'naver-world-daily');assert.equal(first.hasMore,true);assert.equal(first.bars[0].periodStart,'2016-01-01');assert.equal(first.bars[0].h,102);
 const older=await history.get('NVDA','yearly',{count:39,before:first.nextBefore,seriesId:first.seriesId});assert.ok(older.bars[0].periodStart<'2010-01-01');assert.equal(older.overlapBars[0].h,777);
 assert.ok(older.bars.every(bar=>bar.v===null));assert.equal(calls.filter(url=>url.includes('/day?')).length,2);
 const monthly=await history.get('NVDA','monthly',{count:79});assert.equal(monthly.bars.length,79);assert.ok(monthly.bars[0].periodStart<'2021-01-01');assert.equal(calls.filter(url=>url.includes('/day?')).length,2);
});

test('real application HTTP before 2021 reads the requested TWSE year without displacing the retained recent history',async t=>{
 const calls=[],twse=twseFixture(calls),request=async url=>url.includes('/STOCK_DAY?')?twse(url):{status:429,headers:{'retry-after':'120'},body:''};
 const app=createApplication({now:()=>NOW,telemetry:createTelemetry(),transport:{httpsGet:request,rawHttpsGet:request,close(){},reopen(){}},env:{HOST:'127.0.0.1',PORT:0,SYMBOLS:'2330.TW',LOG_FILE:'',RECOVERY_PATH:'',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',SAMPLES_STATE_PATH:'',LLM_KEY_STORE_PATH:'',HISTORY_BACKGROUND_ENABLED:'0',MACRO_BACKGROUND_ENABLED:'0',SAMPLES_BACKGROUND_ENABLED:'0',FUNDAMENTALS_ENABLED:'0',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'}});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 const read=async query=>{const r=await fetch(origin+'/api/history?symbol=2330.TW&period=yearly&'+query),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 const recent=await read('count=20');assert.equal(recent.bars.at(-1).periodStart,'2026-01-01');const count=calls.length;
 const older=await read('count=20&before=2021-01-01&seriesId='+recent.seriesId);
 assert.ok(older.bars.length>0);assert.ok(older.bars.every(bar=>bar.periodStart<'2021-01-01'));assert.ok(older.nextBefore<'2021-01-01');
 assert.ok(calls.length-count<=12);assert.ok(calls.slice(count).every(date=>date<'20210101'));
 const retained=await read('count=2');assert.equal(retained.bars.at(-1).periodStart,'2026-01-01');assert.equal(retained.seriesId,recent.seriesId);
 const fetched=calls.length;await read('count=20&before=2021-01-01&seriesId='+recent.seriesId);assert.equal(calls.length,fetched,'the source month cache retains the detached older window');
});

test('source rejected dates mark only the affected aggregate partial and survive the history checkpoint',async t=>{
 let clock=NOW;
 const dates=['2012-01-03','2012-12-31','2013-01-02','2013-12-31'];
 const data={source:'naver-index-history',sourceCheckedAt:NOW,historyQuality:{status:'partial',missingTradingDates:['2012-10-22'],rejectedRows:1,reason:'source-invalid-ohlc'},meta:{symbol:'^IXIC',currency:'USD',exchangeName:'NASDAQ',exchangeTimezoneName:'America/New_York',instrumentType:'INDEX',dataGranularity:'1d'},timestamp:dates.map(date=>Date.parse(date+'T12:00:00Z')/1000),indicators:{quote:[{open:dates.map(()=>100),high:dates.map(()=>102),low:dates.map(()=>98),close:dates.map(()=>101)}]}};
 const history=createHistoryService({now:()=>clock,fetchChart:async()=>data}),restored=createHistoryService({now:()=>clock});t.after(()=>{history.close();restored.close();});
 const result=await history.get('^IXIC','yearly',{count:20});
 const affected=result.bars.find(bar=>bar.periodStart==='2012-01-01'),other=result.bars.find(bar=>bar.periodStart==='2013-01-01');
 assert.equal(affected.coverageStatus,'partial');assert.deepEqual(affected.missingTradingDates,['2012-10-22']);assert.ok(affected.qualityFlags.includes('source-invalid-ohlc'));
 assert.ok(!other.qualityFlags.includes('source-invalid-ohlc'));assert.deepEqual(result.historyQuality.missingTradingDates,['2012-10-22']);
 restored.restore(history.exportState());const replay=await restored.get('^IXIC','yearly',{count:20,cacheOnly:true});assert.deepEqual(replay.historyQuality.missingTradingDates,['2012-10-22']);
 // A later explicit valid row may clear the quarantined date; other valid
 // rows are left unchanged. This models a source correction, not a fill.
 clock+=86400001;data.sourceCheckedAt=clock;delete data.historyQuality;data.timestamp.push(Date.parse('2012-10-22T12:00:00Z')/1000);
 for(const [field,value] of Object.entries({open:100,high:102,low:98,close:101}))data.indicators.quote[0][field].push(value);
 const corrected=await history.get('^IXIC','yearly',{count:20,force:true});assert.ok(!corrected.bars.find(bar=>bar.periodStart==='2012-01-01').qualityFlags.includes('source-invalid-ohlc'));assert.equal(corrected.historyQuality,undefined);
});

test('recorded IXIC provider data reaches yearly API metadata with only its bad 2012 date quarantined',async t=>{
 const clock=Date.parse('2026-10-05T02:07:50Z'),fixture=JSON.parse(readFileSync(new URL('../fixtures/naver-ixic-invalid-ohlc-2012.json',import.meta.url),'utf8'));
 const basic={stockEndType:'index',reutersCode:'.IXIC',stockExchangeType:{code:'NSQ',zoneId:'EST5EDT',nationCode:'USA'},indexType:{symbolCode:'IXIC',currencyType:null}};
 const provider=createNaverIndexProvider({now:()=>clock,httpsGet:async url=>ok(url.endsWith('/basic')?basic:fixture.rows)});
 const source=createHistorySource({now:()=>clock,index:provider.fetchChart}),history=createHistoryService({now:()=>clock,fetchChart:source});t.after(()=>{history.close();source.close();provider.close();});
 const result=await history.get('^IXIC','yearly',{count:20});assert.equal(result.source,'naver-index-history');assert.equal(result.status,'ready');
 assert.equal(result.bars.find(bar=>bar.periodStart==='2012-01-01').coverageStatus,'partial');
 assert.ok(!result.bars.find(bar=>bar.periodStart==='2018-01-01').qualityFlags.includes('source-invalid-ohlc'));
 assert.deepEqual(result.coverage.missingTradingDates,['2012-10-22']);assert.ok(result.warnings.includes('source-invalid-ohlc'));
});
