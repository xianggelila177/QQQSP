import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createAdmission,clientIdentity,settleWithin,withDeadline} from '../lib/http-admission.js';
import {createBusinessMonitor} from '../lib/http-diagnostics.js';
import {createTelemetry} from '../log.mjs';
import {createHttp} from '../lib/http.js';
import {chartRevision,parseCv,applyChartVersions} from '../lib/http-charts.js';

const silent={info(){},debug(){},warn(){},error(){}};
let time=1788600000000;
const req={socket:{remoteAddress:'127.0.0.1'},headers:{'cf-connecting-ip':'203.0.113.3'}};
assert.equal(clientIdentity(req,false),'127.0.0.1');
assert.equal(clientIdentity(req,true),'203.0.113.3');
assert.equal(clientIdentity({...req,socket:{remoteAddress:'203.0.113.9'}},true),'203.0.113.9');
const gate=createAdmission({env:{TRUST_PROXY_LOOPBACK:'1'},now:()=>time});
for(let i=0;i<240;i++) assert.equal(gate.consume(req,'snapshot').ok,true,'eight normal tabs fit snapshot budget');
for(let i=0;i<120;i++) assert.equal(gate.consume(req,'expensive').ok,true);
assert.equal(gate.consume(req,'expensive').ok,false);
time+=60000;assert.equal(gate.consume(req,'expensive').ok,true);
const other=createAdmission({env:{},now:()=>time});
assert.equal(other.diagnostics().clients,0,'instance quotas are independent');

let release;
const bounded=createAdmission({env:{HTTP_ACTIVE_MAX:'1',HTTP_QUEUE_MAX:'1'}});
const first=bounded.run(()=>new Promise(resolve=>{release=resolve;}));
await Promise.resolve();
const queued=bounded.run(()=>42);
await assert.rejects(bounded.run(()=>43),{code:'CAPACITY_EXCEEDED'});
queued.cancel();await assert.rejects(queued,{code:'REQUEST_CANCELLED'});
release(1);assert.equal(await first,1);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(bounded.diagnostics().active,0);
assert.equal(bounded.diagnostics().queued,0);
await assert.rejects(withDeadline(new Promise(()=>{}),5),{code:'DEADLINE_EXCEEDED'});
const parts=await settleWithin([Promise.resolve('good'),Promise.reject(new Error('bad')),new Promise(()=>{})],5);
assert.equal(parts[0],'good');assert.equal(parts[1].__error.message,'bad');assert.equal(parts[2].__error.code,'DEADLINE_EXCEEDED');

const t1=createTelemetry({now:()=>time,logger:silent}),t2=createTelemetry({now:()=>time,logger:silent});
for(let i=0;i<100;i++) t1.countUpstream('polling.finance.naver.com',5,i%2===0,false);
assert.deepEqual(t1.recentUpstream('polling.finance.naver.com'),{calls:100,errors:50,errRate:0.5,windowMs:300000,bucketMs:1000});
assert.equal(t2.stats.upstream.total,0);
time+=301000;assert.equal(t1.recentUpstream('polling.finance.naver.com').calls,0);
t1.countQuoteOutcomes([{pending:true},{error:'failed'},{stale:true},{price:1}]);
assert.deepEqual(t1.stats.business,{responses:1,ok:1,pending:1,stale:1,error:1});
const monitor=createBusinessMonitor({now:()=>time});
const q=symbol=>({symbol,price:100,marketState:'REGULAR',quoteAt:time,fetchedAt:time});
monitor.record([q('QQQ')]);assert.equal(monitor.diagnostics().ready,false);
monitor.record([q('SPY')]);assert.equal(monitor.diagnostics().ready,true);
monitor.record([{symbol:'QQQ',pending:true}]);assert.equal(monitor.diagnostics().ready,false);

const bars=Object.freeze([Object.freeze({t:1,c:1})]);
assert.equal(chartRevision(bars),chartRevision(bars));
assert.notEqual(chartRevision([{t:1,c:2}]),chartRevision(bars));
const mutable=[{t:1,c:1}],before=chartRevision(mutable);mutable[0].c=2;assert.notEqual(chartRevision(mutable),before);
assert.equal(parseCv('QQQ:1:2;bad').size,0);
const cv=chartRevision(bars);
assert.equal(applyChartVersions([{symbol:'QQQ',charts:{intraday:bars,daily30:[]}}],parseCv(`QQQ:${cv}:0`))[0].charts.intraday,'same');

const calls=[];
const make=(name,price)=>createHttp({getCachedQuote:symbol=>{calls.push(name+symbol);return {...q(symbol),price};},getMacro:async()=>({items:[]}),requestNews:async()=>({items:[],stale:false}),activateNews(){},cacheSizes:()=>({})},{env:{PORT:'0',SYMBOLS:'QQQ,SPY'},now:()=>time,telemetry:createTelemetry({now:()=>time,logger:silent})});
const a=make('a',10),b=make('b',20);
try {
  a.startListen();b.startListen();
  await Promise.all([once(a.httpServer,'listening'),once(b.httpServer,'listening')]);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(a.diagnostics().business.ready,true,'core self-warm makes fresh application ready without visitors');
  assert.equal(b.diagnostics().business.ready,true);
  const base=app=>`http://127.0.0.1:${app.httpServer.address().port}`;
  const qa=await fetch(base(a)+'/api/market?symbols=QQQ').then(r=>r.json());
  const qb=await fetch(base(b)+'/api/market?symbols=QQQ').then(r=>r.json());
  assert.equal(qa[0].price,10);assert.equal(qb[0].price,20);
  assert.equal((await fetch(base(a)+'/api/stats',{headers:{Host:'localhost','CF-Connecting-IP':'203.0.113.2'}})).status,404,'forwarded public request cannot gain local stats access');
  assert.ok(calls.includes('aSPY')&&calls.includes('bSPY'));
} finally {await Promise.all([a.stop(),b.stop()]);}
console.log('PASS independent HTTP/telemetry factories, self-warming core readiness, fair traffic quotas, partial deadlines and immutable chart revisions');
