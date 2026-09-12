import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {sinaRow} from './source-fixtures.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('real HTTP with production source composition: US batch every second, Korean identity/history, no per-card polling',async t=>{
 const born=Date.now(),base=Date.parse('2026-09-10T13:59:00Z'),now=()=>base+Date.now()-born,calls=[],sina=[];
 const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PORT:0,POLL_MS:1000,PUBLIC_SOURCE_REDUNDANCY:'0'},now,telemetry:createTelemetry(),upstream:async url=>{
  calls.push(url);
  if(url.includes('hq.sinajs.cn')){sina.push(Date.now());return {status:200,body:sinaRow('NVDA',{price:100+sina.length,date:'2026-09-10 21:59:00'})+sinaRow('LITE',{price:900+sina.length,date:'2026-09-10 21:59:00'})};}
  if(url.includes('/domestic/stock/'))return {status:200,body:JSON.stringify({pollingInterval:7000,datas:[{itemCode:'000660',stockName:'SK hynix',closePrice:'200000',compareToPreviousClosePrice:'1000',localTradedAt:'2026-09-10T15:30:00+09:00',stockExchangeType:{code:'KS',nameEng:'KOSPI',nationType:'KOR',delayTime:0},currencyType:{code:'KRW'}}]})};
  if(url.includes('fchart.stock.naver.com'))return {status:200,body:'<protocol><chartdata symbol="000660"><item data="'+(url.includes('timeframe=minute')?'202609101530|null|null|null|200000|1000':'20260909|198000|201000|197000|200000|1000')+'"/></chartdata></protocol>'};
  return {status:429,headers:{'retry-after':'120'},body:''};
 }});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
 const stream=await fetch(origin+'/api/stream?symbols=NVDA,LITE,000660.KS');t.after(()=>stream.body.cancel().catch(()=>{}));assert.match(stream.headers.get('content-type'),/event-stream/);
 await wait(3400);
 const rows=await (await fetch(origin+'/api/market?symbols=NVDA,LITE,000660.KS')).json();
 const us=rows.find(q=>q.symbol==='NVDA'),kr=rows.find(q=>q.symbol==='000660.KS');assert.ok(us.price>=103,JSON.stringify(rows));assert.equal(us.src,'sina-batch');assert.equal(kr.currency,'KRW');assert.equal(kr.src,'naver-kr');assert.equal(kr.charts.intraday[0].c,200000);assert.equal(kr.charts.intraday[0].v,null);
 assert.ok(sina.length>=3&&sina.length<=4,sina.length);const gaps=sina.slice(1).map((at,i)=>at-sina[i]);assert.ok(Math.max(...gaps)<1300,JSON.stringify(gaps));
 assert.equal(calls.filter(u=>u.includes('/domestic/stock/')).length,1);assert.ok(calls.filter(u=>u.includes('hq.sinajs.cn')).every(u=>u.includes('gb_nvda')&&u.includes('gb_lite')));
 assert.equal(calls.filter(u=>u.includes('qt.gtimg.cn')).length,0,'healthy primary never triggers secondary quote source');
 const before=calls.filter(u=>u.includes('hq.sinajs.cn')).length;for(let i=0;i<8;i++)await (await fetch(origin+'/api/market?symbols=NVDA,LITE')).json();assert.equal(calls.filter(u=>u.includes('hq.sinajs.cn')).length,before,'HTTP cache reads cannot force upstream reads');
});
