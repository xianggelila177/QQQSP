import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseYahooTwChart,createYahooTwHistory} from '../../lib/providers/yahoo-tw-history.js';
import {createTwseHistory} from '../../lib/providers/twse-history.js';

const captured=JSON.parse(readFileSync(new URL('./yahoo-tw-2330-chart.json',import.meta.url)));
const dailyFixture=JSON.parse(readFileSync(new URL('./twse-2330-fixture.json',import.meta.url)));
const html=chart=>'<script>root.App.main = {"context":{"dispatcher":{"stores":'+
  JSON.stringify({MarketChartStore:{libra:{'2330.TW':chart}}})+'}}};</script>';
const liveNow=Date.parse('2026-10-02T12:32:57+08:00');
// Synthetic replay of the live 2026-10-02 response's next-minute boundary.
// Prices are test data; timestamps model the verified source behavior.
function liveChart(){
  const chart=structuredClone(captured),offset=Date.parse('2026-10-02T09:00:00+08:00')/1000-chart.timestamp[0];
  chart.timestamp=chart.timestamp.map(t=>t+offset).filter(t=>t<=Math.ceil(liveNow/60000)*60);
  for(const field of Object.keys(chart.indicators.quote[0]))chart.indicators.quote[0][field]=chart.indicators.quote[0][field].slice(0,chart.timestamp.length);
  for(const period of Object.values(chart.meta.currentTradingPeriod)){period.start+=offset;period.end+=offset;}
  chart.meta.regularMarketTime=chart.timestamp.at(-1);
  chart.meta.regularMarketPrice=chart.indicators.quote[0].close.at(-1);
  return chart;
}

test('Taiwan live next-minute metadata does not suppress already elapsed minute prices',()=>{
  const chart=liveChart(),parsed=parseYahooTwChart(html(chart),'2330.TW',liveNow);
  assert.equal(chart.meta.regularMarketTime,Date.parse('2026-10-02T12:33:00+08:00')/1000);
  assert.equal(parsed.timestamp.at(-1),Date.parse('2026-10-02T12:32:00+08:00')/1000);
  assert.ok(parsed.timestamp.every(t=>t*1000<=liveNow),'future points are never displayed early');
  assert.equal(parsed.meta.currency,'TWD');
  assert.equal(parsed.meta.chartTimeBasis,'price-point','do not invent interval timestamp semantics');
  assert.ok(parsed.indicators.quote[0].volume.every(v=>v===null));
});

test('Taiwan minute tolerance is bounded and still validates identity, session and source ordering',()=>{
  for(const mutate of [
    chart=>chart.meta.regularMarketTime+=60,
    chart=>chart.meta.regularMarketTime+=1,
    chart=>chart.meta.regularMarketTime=chart.meta.currentTradingPeriod.regular.end+60,
    chart=>chart.meta.currency='USD',
    chart=>chart.meta.symbol='TSM',
    chart=>chart.meta.currentTradingPeriod.regular.start-=86400,
    chart=>chart.timestamp[2]=chart.timestamp[1],
  ]){
    const chart=liveChart();mutate(chart);
    assert.throws(()=>parseYahooTwChart(html(chart),'2330.TW',liveNow));
  }
});

test('Taiwan provider rechecks next-minute data after its minute cache expires',async t=>{
  let now=liveNow,calls=0;
  const chart=liveChart();
  const source=createYahooTwHistory({now:()=>now,httpsGet:async()=>{calls++;return {status:200,body:html(chart)};}});
  t.after(()=>source.close());
  const first=await source('2330.TW','?interval=5m&range=1d');
  assert.equal(first.timestamp.at(-1),chart.timestamp.at(-2));
  await source('2330.TW','?interval=5m&range=1d');assert.equal(calls,1);
  now+=61000;
  const next=await source('2330.TW','?interval=5m&range=1d');
  assert.equal(next.timestamp.at(-1),chart.timestamp.at(-1));assert.equal(calls,2);
});

const syntheticMonth=(month,days)=>({stat:'OK',date:month.replace('-','')+'01',
  title:`${Number(month.slice(0,4))-1911}年${Number(month.slice(5))}月 2330 台積電 各日成交資訊`,
  fields:dailyFixture.daily.fields,data:days.map(day=>[`${Number(month.slice(0,4))-1911}/${month.slice(5)}/${String(day).padStart(2,'0')}`,
    '1,000','2,500,000','2,490.00','2,510.00','2,485.00','2,500.00','+5.00','100',''])});
const months={
  '20261001':syntheticMonth('2026-10',[1]),
  '20260901':syntheticMonth('2026-09',[1,2,3,4,7,8,9,10,11,14,15,16,17,18,21,22,23,24,29,30]),
  '20260801':syntheticMonth('2026-08',[3,4,5,6,7,10,11,12,13,14,17,18,19,20,21,24,25,26,27,28]),
};

test('TWSE quote context keeps thirty daily bars after a new month already has yesterday close',async t=>{
  const calls=[];
  const source=createTwseHistory({now:()=>liveNow,httpsGet:async url=>{
    const month=new URL(url).searchParams.get('date');calls.push(month);
    return {status:200,body:JSON.stringify(months[month])};
  }});t.after(()=>source.close());
  const [a,b]=await Promise.all([source.quoteContext('2330.TW','2026-10-02'),source.quoteContext('2330.TW','2026-10-02')]);
  assert.equal(a.bars.length,30);assert.deepEqual(a,b);
  assert.equal(a.bars.at(-1).date,'2026-10-01');assert.equal(a.previous.date,'2026-10-01');
  assert.ok(a.bars[0].date<'2026-09-01');
  assert.deepEqual(calls,['20261001','20260901','20260801']);
  await source.quoteContext('2330.TW','2026-10-02');assert.equal(calls.length,3,'monthly cache is reused');
});

test('TWSE older-month outage retains current close and available history without fabricated rows',async t=>{
  let calls=0;
  const source=createTwseHistory({now:()=>liveNow,httpsGet:async url=>{
    calls++;return new URL(url).searchParams.get('date')==='20261001'?
      {status:200,body:JSON.stringify(months['20261001'])}:{status:503,body:''};
  }});t.after(()=>source.close());
  const data=await source.quoteContext('2330.TW','2026-10-02');
  assert.equal(data.bars.length,1);assert.equal(data.previous.date,'2026-10-01');assert.equal(calls,2);
  await source.quoteContext('2330.TW','2026-10-02');assert.equal(calls,2,'month failure cooldown is retained');
});
