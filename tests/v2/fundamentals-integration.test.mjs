import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
import {loadConfig} from '../../config.js';import {createQuoteEngine} from '../../lib/quote-engine.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';import {createYahooService} from '../../lib/yahoo.js';
import {parseSinaQuotes} from '../../lib/providers/sina-quotes.js';
import {NOW,quote,record,summary} from './fundamentals-fixture.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await wait(10);}assert.fail('condition not reached');}

test('configuration validates enable switch and financial TTL/retention boundaries',()=>{
  const c=loadConfig();assert.equal(c.FUNDAMENTALS_ENABLED,'1');assert.equal(c.FUNDAMENTALS_TTL_MS,21600000);
  for(const value of [{FUNDAMENTALS_ENABLED:'yes'},{FUNDAMENTALS_TTL_MS:500},{FUNDAMENTALS_RETRY_MS:1},{FUNDAMENTALS_MAX_AGE_MS:60000}])assert.throws(()=>loadConfig(value));
  assert.equal(loadConfig({FUNDAMENTALS_ENABLED:'0'}).FUNDAMENTALS_ENABLED,'0');
});
test('late source tick cannot downgrade price, timestamps or derived financial fields',async t=>{
  let current=quote(),r=record(),events=0;
  const e=createQuoteEngine({now:()=>NOW,readQuote:async()=>current,decorateQuote:q=>({...q,fundamentals:buildBasicMetrics(q,r,{now:NOW})}),tickMs:60000});
  t.after(()=>e.stop());e.subscribe(()=>events++);e.start();e.watch(['AAOI']);await until(()=>e.read(['AAOI'],{lease:false})[0].fundamentals);await wait(60);
  current=quote('AAOI',{price:80,quoteAt:NOW-1000,ts:NOW-1000,volume:10});r.fields.floatShares.value=80000000;e.poke('AAOI');
  await until(()=>e.read(['AAOI'],{lease:false})[0].fundamentals.fields.floatShares.value===80000000);await wait(60);
  const q=e.read(['AAOI'],{lease:false})[0];assert.equal(q.price,105.36);assert.equal(q.quoteAt,NOW);assert.equal(q.sourceCheckedAt,NOW);
  assert.equal(q.fundamentals.fields.floatMarketCap.value,105.36*80000000);assert.equal(q.fundamentals.fields.turnoverRate.value,5001400/80000000*100);assert.equal(events,2);
});
test('Yahoo financial endpoint uses shared auth and cancellation, and honors source cooldown',async()=>{
  const requests=[];let auth=0;
  const service=createYahooService({httpsGet:async(url,headers,options)=>{requests.push({url,headers,signal:options.signal});return requests.length===1?{status:401,body:'{}'}:{status:200,body:JSON.stringify(summary())};},getCrumb:async()=>{auth++;return {crumb:'test crumb',cookie:'test-cookie'};}});
  const p=await service.fetchQuoteSummary('AAOI');assert.equal(p.quoteSummary.result[0].price.symbol,'AAOI');assert.equal(auth,1);
  assert.match(requests[0].url,/modules=price,summaryDetail,defaultKeyStatistics,quoteType/);assert.match(requests[1].url,/crumb=test%20crumb/);assert.equal(requests[1].headers.Cookie,'test-cookie');assert.ok(requests[1].signal);
  await service.close();await assert.rejects(service.fetchQuoteSummary('AAOI'),{code:'STOPPED'});
  const blocked=createYahooService({breaker:{state:()=>({blocked:true,until:NOW+90000})},httpsGet:async()=>{assert.fail('cooling source must not be contacted');}});
  await assert.rejects(blocked.fetchQuoteSummary('AAOI'),e=>e.code==='RATE_LIMITED'&&e.retryAt===NOW+90000);await blocked.close();
});
test('real HTTP and SSE receive independent financial updates without refreshing the quote clock',async t=>{
  let financialCalls=0,release;const stamp=Date.now()-60000;
  const app=createApplication({env:{PORT:0,LOG_FILE:'',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',CACHE_MS:20},telemetry:createTelemetry(),
    upstream:async()=>{throw new Error('External IO is disabled in this test');},providerOverrides:{fetchQuote:async symbol=>quote(symbol,{quoteAt:stamp,ts:stamp,regularQuoteAt:stamp,sourceCheckedAt:stamp}),
      fetchFundamentals:async symbol=>{financialCalls++;await new Promise(r=>release=r);return record(symbol,Date.now());}}});
  t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');const origin='http://127.0.0.1:'+app.httpServer.address().port;
  const frames=[];let buffer='';const req=http.get(origin+'/api/stream?symbols=AAOI',res=>{res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const body=/^data: (.+)$/m.exec(frame)?.[1];if(body)frames.push(JSON.parse(body));}});});
  t.after(()=>req.destroy());await until(()=>financialCalls===1&&frames.some(f=>f.quotes?.some(q=>q.fundamentals?.status==='loading')));release();
  await until(()=>frames.some(f=>f.quotes?.some(q=>q.fundamentals?.fields.priceToBook.value===5.33)));
  const q=(await (await fetch(origin+'/api/market?symbols=AAOI')).json())[0];
  assert.equal(q.fundamentals.fields.priceToBook.value,5.33);assert.equal(q.quoteAt,stamp);assert.equal(q.sourceCheckedAt,stamp);assert.equal(financialCalls,1);
  const s=await (await fetch(origin+'/api/sources')).json();assert.equal(s.fundamentals.enabled,true);assert.equal(s.fundamentals.entries,1);
  req.destroy();await app.stop();assert.equal(app.services.fundamentals.diagnostics().running,false);
});
test('Sina cumulative trade amount uses the native CN/HK amount column, not last price times volume',()=>{
  const cn=Array(32).fill(''),hk=Array(19).fill('');
  Object.assign(cn,{0:'测试A股',1:'10',2:'9',3:'10.2',4:'11',5:'9.5',8:'1200',9:'12222',30:'2026-09-14',31:'14:00:00'});
  Object.assign(hk,{0:'TEST',1:'测试港股',2:'10',3:'9',4:'11',5:'9.5',6:'10.2',11:'23333',12:'2100',17:'2026/09/14',18:'14:00:00'});
  const out=parseSinaQuotes('var hq_str_sh600000="'+cn.join(',')+'";var hq_str_rt_hk00700="'+hk.join(',')+'";',['600000.SS','0700.HK'],{now:NOW});
  assert.equal(out.length,2);assert.equal(out[0].volume,1200);assert.equal(out[0].turnoverAmount,12222);assert.equal(out[1].volume,2100);assert.equal(out[1].turnoverAmount,23333);
});
