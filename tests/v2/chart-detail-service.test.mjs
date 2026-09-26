import test from 'node:test';
import assert from 'node:assert/strict';
import {createChartDetailService} from '../../lib/chart-detail-service.js';
import {createTradeTape} from '../../lib/trade-tape.js';
import {recentRegularSessions} from '../../lib/regular-chart-service.js';
import {createHttp} from '../../lib/http.js';
import {once} from 'node:events';

const now=Date.parse('2026-09-23T01:00:00Z');
const sessions=recentRegularSessions('AAOI','2026-09-22',5);

test('five-day detail keeps five real trading dates and their regular OHLCV bars',async()=>{
  const rows=sessions.flatMap(day=>[0,300000].map((shift,i)=>({t:(day.sessions[0].open_at_ms+shift)/1000,
    o:100+i,h:102+i,l:99+i,c:101+i,v:1000+i})));
  const readQuote=()=>({symbol:'AAOI',currency:'USD',instrumentType:'EQUITY',price:102,
    regularChart:{tradeDate:'2026-09-22',bars:rows.slice(-2),regularSessions:sessions.at(-1).sessions}});
  const fetchChart=async(symbol,query)=>{
    assert.equal(symbol,'AAOI');assert.match(query,/interval=5m/);
    return {meta:{symbol,currency:'USD',dataGranularity:'5m'},timestamp:rows.map(r=>r.t),
      indicators:{quote:[{open:rows.map(r=>r.o),high:rows.map(r=>r.h),low:rows.map(r=>r.l),
        close:rows.map(r=>r.c),volume:rows.map(r=>r.v)}]}};
  };
  const service=createChartDetailService({readQuote,fetchChart,now:()=>now});
  const result=await service.read('AAOI',{range:'5d'});
  assert.equal(result.fiveDay.status,'ready');assert.equal(result.fiveDay.coveredDays,5);
  assert.equal(result.fiveDay.bars.length,10);assert.equal(result.fiveDay.days.length,5);
  assert.ok(result.fiveDay.days.every(d=>d.status==='ready'&&d.bars.every(b=>b.v>=1000)));
  assert.equal(result.book.reason,'SOURCE_HAS_NO_BOOK');
});

test('five-day source failure reports partial coverage without fabricating dates',async()=>{
  const today=sessions.at(-1),bar={t:today.sessions[0].open_at_ms/1000,c:100,v:null};
  const service=createChartDetailService({readQuote:()=>({symbol:'AAOI',currency:'USD',instrumentType:'EQUITY',
    regularChart:{tradeDate:today.date,bars:[bar],regularSessions:today.sessions}}),
    fetchChart:async()=>{throw Object.assign(new Error('rate limited'),{status:429});},now:()=>now});
  const result=await service.read('AAOI',{range:'5d'});
  assert.equal(result.fiveDay.status,'partial');assert.equal(result.fiveDay.coveredDays,1);
  assert.equal(result.fiveDay.days.filter(d=>d.status==='missing').length,4);
  assert.equal(result.fiveDay.bars.length,1);
});

test('an entitled Alpaca feed supplies same-source minute OHLCV without Yahoo',async()=>{
  let yahooCalls=0;
  const advanced={capabilities:()=>({intraday:{authenticated:true}}),intraday:async({symbol,intraday_date})=>{
    assert.equal(symbol,'AAOI');const day=sessions.find(s=>s.date===intraday_date);
    return {source:'alpaca-iex',currency:'USD',volumeUnit:'shares',adjustment:'raw',
      points:[{t:day.sessions[0].open_at_ms/1000,o:99,h:101,l:98,c:100,v:1234}]};
  }};
  const service=createChartDetailService({advanced,readQuote:()=>({symbol:'AAOI',currency:'USD',instrumentType:'EQUITY'}),
    fetchChart:async()=>{yahooCalls++;throw new Error('not expected');},now:()=>now});
  const result=await service.read('AAOI',{range:'5d'});
  assert.equal(yahooCalls,0);assert.equal(result.fiveDay.status,'ready');
  assert.equal(result.fiveDay.source,'alpaca-iex');assert.equal(result.fiveDay.coverage,'single-exchange');
  assert.deepEqual(result.fiveDay.bars.map(b=>b.v),[1234,1234,1234,1234,1234]);
});

test('tape retains same-time same-price distinct trades and labels fragment coverage',()=>{
  const tape=createTradeTape({maxPerSymbol:3,now:()=>now});tape.retain(['AAOI']);
  const at=sessions.at(-1).sessions[0].open_at_ms+60000;
  for(const [id,size] of [['a',10],['b',20],['a',10],['c',30]])
    tape.record({symbol:'AAOI',source:'alpaca-iex',price:100,size,at,id,exchange:'X'});
  let snapshot=tape.snapshot('AAOI','2026-09-22');
  assert.equal(snapshot.events.length,3);assert.deepEqual(snapshot.events.map(e=>e.size),[10,20,30]);
  assert.equal(snapshot.coverage.complete,false);
  tape.invalidate({symbol:'AAOI',source:'alpaca-iex',id:'b',exchange:'X',kind:'cancellation'});
  snapshot=tape.snapshot('AAOI','2026-09-22');
  assert.equal(snapshot.events[1].reportState,'cancelled');
});

test('browser chart detail route validates symbol and range under the shared HTTP budget',async()=>{
  const calls=[],server=createHttp({chartDetail:{read:async(symbol,options)=>{
    calls.push({symbol,range:options.range});return {symbol,range:options.range,chart:{bars:[]}};
  }}},{env:{PORT:0},monitorCore:false});
  server.startListen();await once(server.httpServer,'listening');
  const base='http://127.0.0.1:'+server.httpServer.address().port;
  try{
    const good=await fetch(base+'/api/chart/detail?symbol=AAOI&range=5d');
    assert.equal(good.status,200);assert.equal((await good.json()).range,'5d');
    assert.deepEqual(calls,[{symbol:'AAOI',range:'5d'}]);
    assert.equal((await fetch(base+'/api/chart/detail?symbol=AAOI&range=20d')).status,400);
    assert.equal((await fetch(base+'/api/chart/detail?symbol=AAOI&tapeSession=night')).status,400);
    assert.equal((await fetch(base+'/api/chart/detail?symbol=%3Cbad%3E')).status,400);
  }finally{await server.stop();}
});
