import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){let price=100,calls=0;const stamp=Date.now();const bars=Object.freeze([{t:Math.floor(stamp/1000)-120,o:99,h:101,l:98,c:100,v:0}]);
 const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',CACHE_MS:20},telemetry:createTelemetry(),upstream:async()=>{throw new Error('unexpected upstream');},providerOverrides:{fetchQuote:async symbol=>{calls++;return {symbol,price,quoteAt:stamp+price-100,sourceCheckedAt:stamp,src:'fixture',currency:'USD',marketState:'REGULAR',charts:{intraday:bars,daily30:bars}};}}});
 app.start();await once(app.httpServer,'listening');const url='http://127.0.0.1:'+app.httpServer.address().port;t.after(()=>app.stop());return {app,url,calls:()=>calls,change(value){price=value;app.services.quote.cacheMap.clear();app.services.engine.poke('QQQ');}};
}
function stream(url){const events=[];let buffer='';const req=http.get(url,res=>{res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const text=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=/^event: (.+)$/m.exec(text)?.[1],data=/^data: (.+)$/m.exec(text)?.[1];if(type&&data)events.push({type,...JSON.parse(data)});}});});return {events,close(){req.destroy();}};}
test('real HTTP serves readiness without source polling; SSE propagates cached changes and cv deltas',async t=>{
 const f=await fixture(t);const health=await (await fetch(f.url+'/readyz')).json();assert.equal(health.ready,true);assert.equal(health.dataReady,false);assert.equal(f.calls(),0);
 const socket=stream(f.url+'/api/stream?symbols=QQQ');t.after(()=>socket.close());await wait(180);const initial=socket.events.find(e=>e.quotes?.[0]?.price===100);assert.ok(initial);assert.equal(initial.quotes[0].sourceCheckedAt<initial.serverNow,true);
 const initialCalls=f.calls();for(let i=0;i<5;i++)await (await fetch(f.url+'/api/market?symbols=QQQ')).json();assert.equal(f.calls(),initialCalls,'HTTP reads do not call upstream');
 f.change(101);await wait(250);const changed=socket.events.find(e=>e.quotes?.[0]?.price===101);assert.ok(changed);assert.equal(changed.quotes[0].charts.intraday,'same');assert.equal(changed.quotes[0].charts.daily30,'same');
 assert.equal((await fetch(f.url+'/api/stream?symbols=QQQ',{method:'HEAD'})).status,200);
 assert.equal((await fetch(f.url+'/api/not-found')).status,404);assert.equal((await fetch(f.url+'/api/market?symbols=QQQ;bad')).status,400);
 const sources=await (await fetch(f.url+'/api/sources')).json();assert.ok(sources.hosts);assert.ok(!JSON.stringify(sources).includes('APCA_API_SECRET_KEY'));
 assert.equal((await (await fetch(f.url+'/api/markets')).json()).markets.length,21);
 socket.close();await wait(30);assert.equal(f.app.services.engine.diagnostics().subscribers,0);
});
test('server construction/import and two lifecycle cycles own no global network instance',async t=>{
 const f=await fixture(t);await f.app.stop();assert.equal(f.app.httpServer.listening,false);f.app.start();await once(f.app.httpServer,'listening');assert.equal(f.app.services.engine.diagnostics().active.length,0);assert.equal(f.calls(),0);
});
