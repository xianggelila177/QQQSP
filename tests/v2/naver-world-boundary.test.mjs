import test from 'node:test';
import assert from 'node:assert/strict';
import {createNaverWorldHistory} from '../../lib/providers/naver-world-history.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createChartDetailService} from '../../lib/chart-detail-service.js';

const now=Date.parse('2026-10-02T03:31:00Z'),at=date=>Date.parse(date)/1000;
const start=at('2026-09-25T12:30Z'),end=at('2026-10-01T21:00Z');
const row=(tradeAt,extra={})=>({reutersCode:'NVDA.O',stockExchangeType:'NASDAQ',tradeAt,
  openPrice:230.51,highPrice:230.6,lowPrice:230.4938,closePrice:230.58,tradingVolume:20701,...extra});
const original=['2026-09-25T13:30Z','2026-09-28T13:30Z','2026-09-29T12:30Z',
  '2026-09-29T13:30Z','2026-09-30T13:30Z','2026-10-01T12:30Z','2026-10-01T13:30Z'].map(time=>row(time));
const decode=s=>at(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T'+s.slice(8,10)+':'+s.slice(10,12)+':'+s.slice(12,14)+'Z');
const payload=rows=>({reutersCode:'NVDA.O',stockExchangeType:'NASDAQ',hasVolume:true,candleList:rows});

test('Naver page owns [from,to), retaining the full next-page bar instead of truncated right-edge OHLCV',async t=>{
  let pages=0;
  const world=createNaverWorldHistory({now:()=>now,resolveCode:async()=>({code:'NVDA.O',exchange:'NSQ'}),httpsGet:async url=>{
    pages++;const p=new URL(url).searchParams,from=decode(p.get('startDateTime')),to=decode(p.get('endDateTime'));
    const rows=original.filter(b=>at(b.tradeAt)>=from&&at(b.tradeAt)<=to).map(b=>at(b.tradeAt)===to?
      {...b,closePrice:230.54,tradingVolume:14579}:{...b});
    // A provider may also repeat an older bar outside this page. It cannot
    // conflict with the earlier page that actually owns its full interval.
    const earlier=original.find(b=>at(b.tradeAt)<from);
    if(earlier)rows.unshift({...earlier,closePrice:230.55,tradingVolume:15000});
    return {status:200,body:JSON.stringify(payload(rows))};
  }});t.after(()=>world.close());
  const chart=await world('NVDA','?interval=5m&period1='+start+'&period2='+end);
  assert.equal(pages,4);assert.equal(chart.timestamp.length,original.length);
  assert.deepEqual(chart.timestamp,original.map(b=>at(b.tradeAt)));
  assert.ok(chart.indicators.quote[0].close.every(value=>value===230.58));
  assert.ok(chart.indicators.quote[0].volume.every(value=>value===20701));

  // The router must choose verified interval OHLCV over Nasdaq close-only data,
  // and the detail projection must recover all five regular trading dates.
  const backup=Object.assign(async()=>({source:'nasdaq-intraday',retrievalLimited:true,
    meta:{symbol:'NVDA',currency:'USD',dataGranularity:'1m'},timestamp:[at('2026-10-01T13:30Z')],
    indicators:{quote:[{close:[230.58],volume:[null]}]}}),{supports:()=>true});
  const fetchChart=createHistorySource({alternative:backup,world,now:()=>now});
  const detail=createChartDetailService({fetchChart,now:()=>now,readQuote:()=>({symbol:'NVDA',currency:'USD',instrumentType:'EQUITY'})});
  t.after(async()=>{await detail.stop();fetchChart.close();});
  const value=(await detail.read('NVDA',{range:'5d',sections:'chart'})).fiveDay;
  assert.equal(value.source,'naver-world-chart');assert.equal(value.coveredDays,5);
  assert.equal(value.bars.length,5);assert.equal(value.pointKind,'bar-start');
  assert.ok(value.bars.every(b=>b.h>Math.max(b.o,b.c)&&b.l<Math.min(b.o,b.c)));
  assert.equal(value.reason,'CLOSING_PRINT_COVERAGE_UNVERIFIED');
});

test('conflicting candles inside a single Naver page still fail instead of being silently replaced',async t=>{
  const one=original[0];
  const world=createNaverWorldHistory({now:()=>now,resolveCode:async()=>({code:'NVDA.O',exchange:'NSQ'}),
    httpsGet:async()=>({status:200,body:JSON.stringify(payload([one,{...one,closePrice:230.55}]))})});
  t.after(()=>world.close());
  await assert.rejects(world('NVDA','?interval=5m&period1='+start+'&period2='+(start+86400)),error=>error.code==='HISTORY_CONFLICT');
});
