import test from 'node:test';
import assert from 'node:assert/strict';
import {providerCapabilities} from '../../lib/instruments.js';
import {createNaverIndexProvider,parseNaverIndexQuote,parseNaverIndexCandles} from '../../lib/providers/naver-index.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {projectRegularBars} from '../../lib/regular-chart-service.js';

const now=Date.parse('2026-10-02T04:30:00Z');
const exchange={code:'NSQ',zoneId:'EST5EDT',nationCode:'USA',delayTime:0};
// Identity, source timestamps and the first five-minute candle were read from
// the public Naver INDEX endpoints on 2026-10-02. Other rows are test fixtures.
const quote=(symbol='^IXIC')=>({reutersCode:'.'+symbol.slice(1),symbolCode:symbol.slice(1),stockExchangeType:exchange,
  closePrice:symbol==='^IXIC'?'26,871.60':'30,501.56',compareToPreviousClosePrice:'10.53',compareToPreviousPrice:{name:'RISING'},
  openPrice:'26,992.31',highPrice:'27,014.47',lowPrice:'26,733.89',marketStatus:'CLOSE',localTradedAt:'2026-10-01T17:15:59-04:00'});
const candle=(tradeAt,extra={})=>({reutersCode:'.IXIC',stockExchangeType:'NASDAQ',tradeAt,
  openPrice:26992.312,highPrice:27007.867,lowPrice:26927.138,closePrice:26987.842,tradingVolume:93798,...extra});
const payload=(rows,extra={})=>({reutersCode:'.IXIC',stockExchangeType:'NASDAQ',zoneId:'EST5EDT',infoType:'index',timeFrame:'minute5',hasVolume:true,candleList:rows,...extra});
const json=data=>({status:200,body:JSON.stringify(data)});
const seconds=iso=>Date.parse(iso)/1000;
const stamp=value=>Date.parse(value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8)+'T'+value.slice(8,10)+':'+value.slice(10,12)+':'+value.slice(12,14)+'Z')/1000;

test('Nasdaq cash indexes route through verified Naver identities without stock or ETF substitution',async()=>{
  for(const symbol of ['^IXIC','^NDX']){
    assert.equal(providerCapabilities(symbol).batchGroup,'index');assert.deepEqual(providerCapabilities(symbol).batchProviders,['naver-index']);
    const q=parseNaverIndexQuote(quote(symbol),symbol,{now});
    assert.equal(q.symbol,symbol);assert.equal(q.instrumentType,'INDEX');assert.equal(q.currency,'USD');assert.equal(q.volume,null);
    assert.equal(q.quoteAt,Date.parse('2026-10-01T21:15:59Z'));assert.equal(q.sourceCheckedAt,now);assert.equal(q.priceSession,'REGULAR');
    assert.throws(()=>parseNaverIndexQuote(quote(symbol==='^IXIC'?'^NDX':'^IXIC'),symbol,{now}),/identity mismatch/);
  }
  const calls=[],index=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{
    calls.push(url);const symbol=url.endsWith('.IXIC')?'^IXIC':'^NDX';return json({pollingInterval:70000,datas:[quote(symbol)]});
  }});
  const batch=createBatchProvider({indexProvider:index,now:()=>now,httpsGet:async()=>{throw Error('unsupported stock route');}});
  const polling=createFastPolling({legacy:batch,now:()=>now,httpsGet:async()=>{throw Error('unsupported public stock route');}});
  try{const result=await polling.fetchSnapshotBatch(['^IXIC','^NDX'],{group:'index'});
    assert.deepEqual(result.quotes.map(q=>q.symbol),['^IXIC','^NDX']);assert.ok(result.quotes.every(q=>q.src==='naver-index'));
    assert.equal(calls.length,2);assert.ok(calls.every(url=>url.includes('/worldstock/index/')));
  }finally{index.close();}
});

test('index candles preserve real OHLC, strict UTC interval identity and unknown volume units',()=>{
  const data=payload([candle('2026-10-01T13:30Z')]);
  const bars=parseNaverIndexCandles(data,'^IXIC',5,{now});
  assert.deepEqual(bars,[{t:seconds('2026-10-01T13:30Z'),o:26992.312,h:27007.867,l:26927.138,c:26987.842,v:null}]);
  for(const extra of [{zoneId:'Asia/Seoul'},{timeFrame:'minute'},{infoType:'stock'},{reutersCode:'.NDX'},{stockExchangeType:'NYSE'}])
    assert.throws(()=>parseNaverIndexCandles({...data,...extra},'^IXIC',5,{now}));
  for(const tradeAt of ['2026-10-01T09:30-04:00','2026-10-01T13:30','2026-02-30T13:30Z','2026-10-01T13:31Z'])
    assert.throws(()=>parseNaverIndexCandles(payload([candle(tradeAt)]),'^IXIC',5,{now}),/timestamp mismatch/);
  assert.throws(()=>parseNaverIndexCandles(payload([candle('2026-10-01T13:30Z',{reutersCode:'.NDX'})]),'^IXIC',5,{now}),/identity mismatch/);
  assert.throws(()=>parseNaverIndexCandles(payload([candle('2026-10-01T13:30Z'),candle('2026-10-01T13:30Z',{closePrice:26990})]),'^IXIC',5,{now}),e=>e.code==='HISTORY_CONFLICT');
});

test('five-day index history owns each page half-open interval and retains every requested session',async()=>{
  const dates=['2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01'];
  const original=dates.map(date=>candle(date+'T13:30Z'));
  const start=seconds('2026-09-25T13:30Z'),end=seconds('2026-10-01T21:00Z');
  // This point lands exactly on the first two-day boundary.
  original.push(candle('2026-09-27T13:30Z'));
  const calls=[],index=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{
    calls.push(url);const p=new URL(url).searchParams,from=stamp(p.get('startDateTime')),to=stamp(p.get('endDateTime'));
    const rows=original.filter(row=>seconds(row.tradeAt)>=from&&seconds(row.tradeAt)<=to).map(row=>seconds(row.tradeAt)===to?{...row,closePrice:26950}:{...row});
    const earlier=original.find(row=>seconds(row.tradeAt)<from);if(earlier)rows.unshift({...earlier,closePrice:26960});
    return json(payload(rows));
  }});
  try{
    const query='?interval=5m&period1='+start+'&period2='+end;
    const data=await index.fetchChart('^IXIC',query);
    assert.equal(calls.length,4);assert.equal(data.timestamp.length,6);assert.ok(data.indicators.quote[0].close.every(value=>value===26987.842));
    assert.equal(data.meta.chartTimeBasis,'bar-start');assert.equal(data.meta.chartIntervalSeconds,300);assert.equal(data.meta.dataGranularity,'5m');
    assert.equal(data.meta.currency,'USD');assert.equal(data.source,'naver-index-candles');
    await index.fetchChart('^IXIC',query);assert.equal(calls.length,4,'matching ranges reuse the source page cache');
    for(const bad of ['?interval=15m&range=1d','?interval=5m&period1=NaN','?interval=5m&period1=0','?interval=5m&period1='+end+'&period2='+start])
      await assert.rejects(index.fetchChart('^IXIC',bad));
    assert.equal(calls.length,4,'invalid interval and ranges never reach the source');
    const bars=data.timestamp.map((t,i)=>({t,o:data.indicators.quote[0].open[i],h:data.indicators.quote[0].high[i],l:data.indicators.quote[0].low[i],c:data.indicators.quote[0].close[i]}));
    for(const date of dates){const p=projectRegularBars('^IXIC',bars,{source:data.source,pointKind:'bar-start',intervalSeconds:300,targetDate:date,now});assert.equal(p.tradeDate,date);assert.equal(p.bars.length,1);}
  }finally{index.close();}
});

test('preopen one-day lookup uses the previous completed session, and daily OHLC remains current',async()=>{
  const calls=[],index=createNaverIndexProvider({now:()=>now,httpsGet:async url=>{
    calls.push(url);
    if(url.includes('/interval/'))return json(payload([candle('2026-10-01T13:30Z'),candle('2026-10-01T20:00Z')]));
    if(url.endsWith('/basic'))return json({stockEndType:'index',reutersCode:'.IXIC',stockExchangeType:exchange,indexType:{symbolCode:'IXIC',currencyType:null}});
    return json([{localDate:'20261001',openPrice:26992.312,highPrice:27014.473,lowPrice:26733.894,closePrice:26871.595}]);
  }});
  try{
    const data=await index.fetchChart('^IXIC','?interval=5m&range=1d');const p=new URL(calls[0]).searchParams;
    assert.equal(p.get('startDateTime'),'20261001040000');assert.equal(p.get('endDateTime'),'20261002040000');
    const bars=data.timestamp.map((t,i)=>({t,c:data.indicators.quote[0].close[i]}));
    const projected=projectRegularBars('^IXIC',bars,{source:data.source,pointKind:'bar-start',intervalSeconds:300,targetDate:'2026-10-01',now});
    assert.equal(projected.bars.length,1,'close and after-close index publications cannot enter regular interval candles');
    const daily=await index.fetchChart('^IXIC','?interval=1d&range=2y');
    assert.equal(daily.timestamp.at(-1),seconds('2026-10-01T13:00Z'));assert.equal(daily.indicators.quote[0].close.at(-1),26871.595);
    assert.equal(daily.meta.instrumentType,'INDEX');
  }finally{index.close();}
});

test('new index failures retain the existing independent quote fallback',async()=>{
  const index=createNaverIndexProvider({now:()=>now,httpsGet:async()=>({status:503,body:'{}'})});
  const calls=[],batch=createBatchProvider({indexProvider:index,now:()=>now,fallbackQuote:async symbol=>{
    calls.push(symbol);return {symbol,price:26871.6,quoteAt:now-1000,sourceCheckedAt:now,instrumentType:'INDEX',currency:'USD',src:'yahoo'};
  }});
  try{const r=await batch.fetchSnapshotBatch(['^IXIC'],{group:'index'});assert.equal(r.quotes[0].src,'yahoo');assert.deepEqual(calls,['^IXIC']);}
  finally{index.close();}
});
