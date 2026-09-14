import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import http from 'node:http';import vm from 'node:vm';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
const file=name=>fs.readFileSync(new URL('../fixtures/fundamentals-live/'+name,import.meta.url));
const json=name=>JSON.parse(file(name));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<800;i++){if(predicate())return;await wait(10);}assert.fail('composed financial update did not arrive');}
test('real adapters -> financial service -> HTTP/SSE -> UI formatter refresh all three metrics',async t=>{
  let now=Date.parse('2026-09-14T07:10:00Z'),round=0;const calls=[];
  const parse=createBatchProvider({now:()=>now});
  const rawTx=()=>file('tencent.raw').toString('latin1').replace(/(v_usAAOI="[^"]*)"/,(_,body)=>{const f=body.split('~');if(round)f[51]='6.36';return f.join('~')+'"';});
  const rows=()=>[
    ...parse.parseTencentBatch(rawTx(),['161128.SZ']),
    ...json('naver-us.json').datas.map(r=>({...parse.parseNaverQuote({...r,accumulatedTradingVolumeRaw:String(Number(r.accumulatedTradingVolumeRaw)+round*100000),accumulatedTradingValueRaw:String(Number(r.accumulatedTradingValueRaw)+round*10000000)},r.symbolCode,70000),regularQuoteAt:Date.parse(r.localTradedAt)+round*2000})),
    parse.parseNaverQuote(json('naver-kr.json').datas[0],'000660.KS',7000)
  ];
  const app=createApplication({now:()=>now,env:{PORT:0,LOG_FILE:'',CACHE_MS:20,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',RECOVERY_PATH:''},telemetry:createTelemetry(),
    providerOverrides:{fetchQuote:async symbol=>rows().find(q=>q.symbol===symbol)},upstream:async url=>{
      calls.push(url);
      if(url.includes('qt.gtimg.cn'))return {status:200,body:rawTx()};
      if(url.includes('wisereport'))return {status:200,body:file('naver-kr-company.html').toString()};
      if(url.includes('m.stock.naver.com/api/stock/'))return {status:200,body:file('naver-kr-detail.json').toString()};
      return {status:429,body:'{}',headers:{'retry-after':'120'}};
    }});
  t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');
  const origin='http://127.0.0.1:'+app.httpServer.address().port,symbols=['161128.SZ','AAOI','LITE','000660.KS'];
  const frames=[];let buffer='';const req=http.get(origin+'/api/stream?symbols='+symbols.join(','),res=>{res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const body=/^data: (.+)$/m.exec(frame)?.[1];if(body)frames.push(JSON.parse(body));}});});
  t.after(()=>req.destroy());const read=()=>app.services.engine.read(symbols,{lease:false});
  await until(()=>read().every(q=>q.fundamentals?.fields.turnoverRate.value>0));
  const first=await (await fetch(origin+'/api/market?symbols='+symbols.join(','))).json();
  for(const q of first){for(const k of ['turnoverAmount','turnoverRate'])assert.ok(q.fundamentals.fields[k].value>0,q.symbol+':'+k);assert.ok(q.instrumentType==='MUTUALFUND'?q.fundamentals.fields.priceToBook.status==='not-applicable':q.fundamentals.fields.priceToBook.value>0);}
  const before=first.find(q=>q.symbol==='AAOI');round=1;now+=61001;app.services.engine.tick();
  await until(()=>frames.some(f=>f.quotes?.some(q=>q.symbol==='AAOI'&&q.fundamentals?.fields.priceToBook.value===6.36)));
  const after=(await (await fetch(origin+'/api/market?symbols=AAOI')).json())[0];
  assert.equal(after.quoteAt,before.quoteAt,'financial refresh does not fabricate a newer trade');
  assert.equal(after.fundamentals.fields.priceToBook.value,6.36);
  assert.equal(after.fundamentals.fields.turnoverAmount.value,540156000);
  assert.ok(after.fundamentals.fields.turnoverRate.value>before.fundamentals.fields.turnoverRate.value);
  const context={window:{},console};vm.createContext(context);
  for(const name of ['panel-format','panel-currency','panel-fundamentals'])vm.runInContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),context);
  const ui=context.window.PANEL_FUNDAMENTALS,format=q=>Object.fromEntries(['turnoverAmount','turnoverRate','priceToBook'].map(k=>[k,ui.formatMetric(ui.definitions.find(d=>d.key===k),q,{unit:'USD',money:String,convert:v=>v}).text]));
  assert.equal(format(after).priceToBook,'6.36');assert.notEqual(format(after).turnoverRate,format(before).turnoverRate);
  assert.ok(calls.some(u=>u.includes('finance.yahoo.com')),'partial public data must not suppress supplemental financial reads');
  req.destroy();
});
