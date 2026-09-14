import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {brotliCompressSync,gzipSync} from 'node:zlib';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createRecoveryFixture} from './macro-v26-fixture.mjs';
import {parseMacroDailyCsv} from '../../lib/providers/macro-daily.js';import {createMacroQuoteReader,parseSinaMacro} from '../../lib/providers/macro-quotes.js';import {createTransport} from '../../lib/transport.js';
const START=Date.parse('2026-09-11T13:39:00Z');

test('HTTP and background: blocked Yahoo/Sina, partial catalogue and daily references, followed by recovery',async t=>{
 const f=createRecoveryFixture();const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',PORT:0,MACRO_STATE_PATH:'',RECOVERY_PATH:'',LOG_FILE:'',PUBLIC_SOURCE_REDUNDANCY:'0'},now:f.now,upstream:f.upstream,telemetry:createTelemetry()});t.after(()=>app.stop());
 app.start();await once(app.httpServer,'listening');await app.services.macroMonitor.settled();const origin='http://127.0.0.1:'+app.httpServer.address().port;
 let payload=await(await fetch(origin+'/api/macro/snapshot')).json();assert.equal(payload.context.factors.filter(f=>f.price!==null).length,5);
 assert.equal(payload.context.factors.filter(f=>f.daily).length,3);assert.equal(payload.context.factors.filter(f=>f.fresh).length,0);
 assert.equal(payload.context.factors.find(f=>f.id==='dollar').symbol,'DTWEXBGS');assert.equal(payload.context.factors.find(f=>f.id==='brent').symbol,'DCOILBRENTEU');
 for(let i=0;i<2;i++){f.advance();app.services.macroMonitor.runDue();await app.services.macroMonitor.settled();}
 payload=app.services.macroMonitor.snapshot();assert.equal(payload.context.comparison,'observations');assert.match(payload.context.observations.join(' '),/不是成交时间/);
 f.setMode('recovered');f.advance(181000);app.services.macroMonitor.runDue();await app.services.macroMonitor.settled();
 payload=app.services.macroMonitor.snapshot();assert.equal(payload.context.factors.filter(f=>f.daily).length,0);assert.ok(payload.context.factors.every(f=>f.price>0));
 assert.equal(payload.context.factors.find(f=>f.id==='dollar').symbol,'DINIW');assert.equal(payload.context.factors.find(f=>f.id==='brent').symbol,'hf_OIL');
 const before=f.requests.length;await fetch(origin+'/api/macro/context');await fetch(origin+'/api/macro');assert.equal(f.requests.length,before,'HTTP cache reads do not trigger new upstream requests');
});
test('FRED daily parser validates series ID/date/unit, tolerates missing points, never uses latest CPI as a price',()=>{
 const rows=parseMacroDailyCsv('DATE,DTWEXBGS,DGS10\r\n2026-09-09,118.1,4.83\r\n2026-09-10,.,4.9\r\n2026-10-01,200,5\r\n',START);
 assert.equal(rows.get('DTWEXBGS').observationDate,'2026-09-09');assert.equal(rows.get('DGS10').price,4.9);assert.equal(rows.get('DGS10').unit,'%');
 assert.throws(()=>parseMacroDailyCsv('<html>blocked</html>',START));assert.throws(()=>parseMacroDailyCsv('DATE,CPI\n2026-09-10,100',START));assert.throws(()=>parseMacroDailyCsv('DATE,DGS10\n2020-01-01,5',START));
});
test('Sina GBK still works after adding UTF-8 support; no JavaScript execution',()=>{
 const name=Buffer.from('c3c0d4aad6b8cafd','hex').toString('latin1');
 const raw=`var hq_str_DINIW="21:39:00,98.4,98.4,98.5,0,98.6,99,98,98.6,${name},2026-09-11";globalThis.__pwned=1;`;
 assert.equal(parseSinaMacro(raw,START).get('DINIW').price,98.4);assert.equal(globalThis.__pwned,undefined);
});
test('slow shared candidate is bounded and never duplicated while unresolved',async()=>{
 let now=START,calls=0,resolve;const slow=new Promise(r=>resolve=r);
 const reader=createMacroQuoteReader({now:()=>now,candidateTimeoutMs:10,futures:{getQuote:()=>{calls++;return slow;}},fetchChart:async()=>{throw new Error('offline');},httpsGet:async()=>({status:429,headers:{'retry-after':'120'},body:''})});
 await assert.rejects(reader.readQuote('NQ00Y.FUT'));assert.equal(calls,2);now+=61000;await assert.rejects(reader.readQuote('NQ00Y.FUT'));assert.equal(calls,2,'the two named futures must not start a second unresolved call');
 reader.close();resolve(null);
});
test('public daily fallback is cached once for concurrent factor requests; does not increase requested-symbol coverage',async()=>{
 let calls=0;const reader=createMacroQuoteReader({now:()=>START,futures:{getQuote:async()=>{throw new Error('offline');}},fetchChart:async()=>{throw new Error('offline');},httpsGet:async url=>{
  const u=new URL(url);if(u.hostname!=='fred.stlouisfed.org')throw new Error('offline');calls++;
  const ids=u.searchParams.get('id').split(',');return {status:200,body:'observation_date,'+ids.join(',')+'\n2026-09-10,'+ids.map(()=>100).join(',')};
 }});
 const data=await Promise.all(['BZ=F','^TNX','DX-Y.NYB','CL00Y.FUT'].map(reader.readQuote));assert.equal(calls,1);assert.ok(data.every(q=>q.daily&&q.proxy));await reader.readQuote('BZ=F');assert.equal(calls,1);reader.close();
});
test('Brotli decoding and decompressed-size bound work through a real local HTTP socket',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Encoding':req.url==='/br'?'br':'gzip'});res.end(req.url==='/br'?brotliCompressSync('valid'):gzipSync('x'.repeat(10000)));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const tr=createTransport({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',UPSTREAM_MAX_BODY_BYTES:1024},log:{warn(){},debug(){}}});t.after(async()=>{await tr.close();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port;assert.equal((await tr.httpsGet(base+'/br')).body,'valid');await assert.rejects(tr.httpsGet(base+'/too-big'));
});
test('expired persisted daily data becomes stale and cannot pass as available daily context',async()=>{
 const {createMacroContext}=await import('../../lib/macro-context.js');
 const context=createMacroContext({now:()=>START,readQuote:async symbol=>({symbol,price:100,quoteAt:null,sourceCheckedAt:START,observationDate:'2026-08-01',daily:true})});
 await context.getContext();assert.ok(context.snapshot().factors.every(f=>f.status==='stale'&&f.change===null));
});
test('daily CSV rejects impossible calendar dates rather than accepting normalized dates',()=>{
 assert.throws(()=>parseMacroDailyCsv('DATE,DGS10\n2026-02-30,4.9',Date.parse('2026-03-05T12:00:00Z')));
});
