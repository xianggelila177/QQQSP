import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createHttp} from '../lib/http.js';
import {createAdmission,withDeadline} from '../lib/http-admission.js';
import {diskDiagnostics} from '../lib/http-diagnostics.js';
import {createTelemetry} from '../log.mjs';
const silent={debug(){},info(){},warn(){},error(){}};
let releaseNews,releaseQuote,newsStarted=false,quoteStarted=false;
const good=symbol=>({symbol,price:100,quoteAt:Date.now(),fetchedAt:Date.now(),marketState:'REGULAR'});
const app=createHttp({
  getCachedQuote:symbol=>symbol==='BLOCK'?new Promise(resolve=>{quoteStarted=true;releaseQuote=()=>resolve(good(symbol));}):good(symbol),
  requestNews:()=>new Promise(resolve=>{newsStarted=true;releaseNews=()=>resolve({items:[],stale:false});}),
  activateNews(){},getMacro:async()=>({items:[]}),cacheSizes:()=>({}),
},{env:{PORT:'0',HTTP_ACTIVE_MAX:'1',HTTP_QUEUE_MAX:'0',HTTP_QUOTE_ACTIVE_MAX:'1',HTTP_QUOTE_QUEUE_MAX:'0',HTTP_REQUEST_DEADLINE_MS:'1000'},telemetry:createTelemetry({logger:silent})});
app.startListen();await once(app.httpServer,'listening');
const base=`http://127.0.0.1:${app.httpServer.address().port}`;
const read=path=>fetch(base+path).then(async r=>({status:r.status,body:await r.json()}));
const waitFor=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,2));assert.ok(check());};
let news,blocked;
try {
  await waitFor(()=>app.diagnostics().business.ready);
  news=read('/api/news?symbols=SLOW');await waitFor(()=>newsStarted);
  assert.equal((await read('/api/market?symbols=QQQ')).body[0].price,100,'blocked upstream admission cannot reject cached quotes');
  blocked=read('/api/market?symbols=BLOCK');await waitFor(()=>quoteStarted);
  const overloaded=await read('/api/market?symbols=QQQ');
  assert.equal(overloaded.body[0].code,'CAPACITY_EXCEEDED');
  assert.equal((await read('/readyz')).status,200,'visitor admission failure does not overwrite core probe evidence');
} finally {releaseNews?.();releaseQuote?.();await Promise.all([news,blocked]);await app.stop();}
const gate=createAdmission({env:{HTTP_ACTIVE_MAX:'1',HTTP_QUEUE_MAX:'1'}});
let release;const running=gate.run(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
const queued=gate.run(()=>1);
await assert.rejects(withDeadline(queued,5),{code:'DEADLINE_EXCEEDED'});
release(1);await running;
const original=fs.statfsSync;
try {
  fs.statfsSync=()=>({blocks:10,bavail:8,bsize:1024**3});
  assert.equal(diskDiagnostics().warning,true,'minimum9GiB is shared with scheduled check');
  fs.statfsSync=()=>{throw Object.assign(new Error('fixture unavailable'),{code:'EIO'});};
  assert.equal(diskDiagnostics().warning,true);assert.equal(diskDiagnostics().critical,true);
} finally {fs.statfsSync=original;}
console.log('PASS isolated quote admission, core readiness, deadline identity and consistent capacity warnings');
