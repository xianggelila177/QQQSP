import test from 'node:test';
import assert from 'node:assert/strict';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {createMacroQuoteReader} from '../../lib/providers/macro-quotes.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createMultiSourceFundamentals} from '../../lib/fundamentals-multi.js';
import {publicSourceHealth} from '../../lib/source-health-public.js';
import {sinaRow} from './source-fixtures.mjs';
const BASE=Date.parse('2026-09-10T14:00:00Z'),tick=()=>new Promise(r=>setImmediate(r));
const raw=(symbol,source)=>({source,meta:{symbol,dataGranularity:'1d'},timestamp:[BASE/1000-86400],indicators:{quote:[{open:[100],high:[105],low:[99],close:[102]}]}});
const currentSina=now=>sinaRow('NVDA',{date:new Date(now+8*3600000).toISOString().slice(0,19).replace('T',' '),trade:'Sep 10 10:'+String(new Date(now).getUTCMinutes()).padStart(2,'0')+'AM EDT'});

test('v95: healthy quote primary cannot starve supported backup sources',async()=>{
 let now=BASE;const calls={sina:0,tencent:0,naver:0};
 const p=createFastPolling({now:()=>now,httpsGet:async()=>{calls.sina++;return {status:200,body:currentSina(now)};},legacy:{
  tencent:async symbols=>{calls.tencent++;return symbols.map(symbol=>({symbol,price:99,quoteAt:now-60000,sourceCheckedAt:now,pollAfterMs:1000}));},
  fetchSnapshotBatch:async symbols=>{calls.naver++;return {quotes:symbols.map(symbol=>({symbol,price:98,quoteAt:now-60000,sourceCheckedAt:now,pollAfterMs:1000}))};}
 }});
 for(let i=0;i<4;i++){assert.equal((await p.fetchSnapshotBatch(['NVDA'],{group:'us'})).quotes[0].price,100);await tick();now+=60000;}
 assert.ok(calls.tencent>0,'healthy primary must still periodically verify Tencent');assert.ok(calls.naver>0,'healthy primary must still periodically verify Naver');
});

test('v95: polling reset cannot be repopulated by a previous pending batch',async()=>{
 let release;const pending=new Promise(r=>release=r),p=createFastPolling({now:()=>BASE,httpsGet:async()=>pending,legacy:{tencent:async()=>[],fetchSnapshotBatch:async()=>({quotes:[]})}});
 const job=p.fetchSnapshotBatch(['NVDA'],{group:'us'});await tick();p.reset();release({status:200,body:currentSina(BASE)});
 const result=await job.catch(error=>{assert.equal(error.code,'STOPPED');return {quotes:[]};});
 assert.equal(result.quotes.length,0,'result from before reset must be discarded');assert.equal(p.diagnostics().slots,0);
});

test('v95: macro rotation checks alternate sources without downgrading a fresh timestamped quote',async t=>{
 let now=BASE,backup=0;const p=createMacroQuoteReader({now:()=>now,httpsGet:async()=>{throw Error('fixture unsupported');},fetchChart:async()=>{throw Error('fixture unsupported');},
 futures:{getQuote:async symbol=>({symbol,price:100,quoteAt:now,sourceCheckedAt:now,pollAfterMs:30000})},
 publicSources:{routes:{'NQ00Y.FUT':[['test:backup',async()=>{backup++;return {symbol:'alternate',price:999,sourceCheckedAt:now,proxy:true,pollAfterMs:30000};}]]}}});t.after(()=>p.close());
 for(let i=0;i<12;i++){assert.equal((await p.readQuote('NQ00Y.FUT')).price,100);now+=30000;}
 assert.ok(backup>0,'lower-ranked supported source still gets a bounded observation turn');
});

test('v95: historical fallback success cannot keep extending its recovery lock forever',async()=>{
 let now=BASE,primary=0;const p=createHistorySource({now:()=>now,primary:async symbol=>{primary++;if(primary===1)throw Error('temporary');return raw(symbol,'primary');},alternative:async symbol=>raw(symbol,'backup')});
 for(let i=0;i<12;i++){await p('NVDA','?interval=1d');now+=60000;}
 assert.ok(primary>1,'recovered primary must be retried after the fixed probe interval');
});

test('v95: healthy Nasdaq history does not permanently suppress supported Eastmoney history',async()=>{
 let now=BASE,eastmoney=0;const p=createPublicHistory({now:()=>now,httpsGet:async url=>{
  if(url.includes('nasdaq'))return {status:200,body:JSON.stringify({data:{symbol:'NVDA',tradesTable:{rows:[{date:'09/09/2026',open:'100',high:'105',low:'99',close:'102',volume:'10'}]}}})};
  eastmoney++;return {status:200,body:JSON.stringify({data:{code:'NVDA',market:105,klines:['2026-09-09,100,102,105,99,10']}})};
 }});
 await p('NVDA','?interval=1d&range=2y');now+=300001;await p('NVDA','?interval=1d&range=2y');
 assert.ok(eastmoney>0,'independent history sources get a turn after the cache window');
});

test('v95: every applicable financial source is independently polled even when priority fields are covered',async t=>{
 let now=BASE;const calls={primary:0,backup:0};const sources=Object.keys(calls).map((id,priority)=>({id,priority,ttlMs:60000,fields:['priceToBook'],load:async symbol=>{calls[id]++;return {symbol,fields:{priceToBook:{value:priority?99:5,status:'available'}}};}}));
 const p=createMultiSourceFundamentals({sources,now:()=>now});t.after(()=>p.stop());p.start();const quote={symbol:'NVDA',price:100,currency:'USD',instrumentType:'EQUITY'};
 for(let round=0;round<2;round++){p.decorate(quote);for(let i=0;i<20&&p.diagnostics().inflight;i++)await tick();assert.equal(p.decorate(quote).fundamentals.fields.priceToBook.value,5);now+=60001;}
 assert.equal(calls.primary,2);assert.equal(calls.backup,2,'source priority decides values, not whether the source can ever be checked');
});

test('v95: fairness never bypasses source Retry-After',async()=>{
 let now=BASE,limited=0;const p=createFastPolling({now:()=>now,httpsGet:async()=>({status:200,body:currentSina(now)}),legacy:{
 tencent:async()=>{limited++;throw Object.assign(Error('429'),{retryAt:BASE+600000});},fetchSnapshotBatch:async()=>({quotes:[]})}});
 for(let i=0;i<5;i++){await p.fetchSnapshotBatch(['NVDA'],{group:'us'});await tick();now+=60000;}
 assert.equal(limited,1,'fair rotation checks once but respects the ten-minute lower bound');
});

test('v95: public polling health reports actual scheduler fields without raw symbols',()=>{
 const health=publicSourceHealth({polling:{mode:'batch-polling',preferred:'sina',primary:'sina',pollMs:1000,probeMs:30000,requests:3,failures:1,slots:4,inflight:0,secret:'must-not-leak',symbols:['NVDA']}});
 assert.equal(health.polling.mode,'batch-polling');assert.equal(health.polling.probeMs,30000);assert.equal(health.polling.secret,undefined);assert.equal(health.polling.symbols,undefined);
});

test('v95: a slow fairness probe cannot delay healthy quote delivery or duplicate its pending batch',async()=>{
 let now=BASE,release,calls=0;const pending=new Promise(r=>release=r);
 const p=createFastPolling({now:()=>now,httpsGet:async()=>({status:200,body:currentSina(now)}),legacy:{tencent:async()=>{calls++;return pending;},fetchSnapshotBatch:async()=>({quotes:[]})}});
 await p.fetchSnapshotBatch(['NVDA'],{group:'us'});now+=60000;
 let timer;
 try{
  const q=await Promise.race([p.fetchSnapshotBatch(['NVDA'],{group:'us'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('background probe blocked healthy price')),100);})]);
  assert.equal(q.quotes[0].price,100);await tick();assert.equal(calls,1);
  now+=60000;await p.fetchSnapshotBatch(['NVDA'],{group:'us'});now+=60000;await p.fetchSnapshotBatch(['NVDA'],{group:'us'});assert.equal(calls,1);
 }finally{clearTimeout(timer);release([]);await tick();}
});

test('v95: history verification does not replace a full sequence with a shorter fallback or splice bars',async()=>{
 let now=BASE,backup=0;const full={...raw('NVDA','primary'),retrievalLimited:false},short={...raw('NVDA','backup'),retrievalLimited:true};
 const p=createHistorySource({now:()=>now,primary:async()=>full,alternative:async()=>{backup++;return short;}});
 assert.strictEqual(await p('NVDA','?interval=1d'),full);now+=300001;assert.strictEqual(await p('NVDA','?interval=1d'),full);assert.equal(backup,1);
});

test('v95: rotating historical probes respect explicit source cooldown independently of successful siblings',async()=>{
 let now=BASE,backup=0;const p=createHistorySource({now:()=>now,primary:async()=>raw('NVDA','primary'),alternative:async()=>{backup++;throw Object.assign(Error('limited'),{retryAt:BASE+1200000});}});
 for(let i=0;i<4;i++){assert.equal((await p('NVDA','?interval=1d')).source,'primary');now+=300001;}
 assert.equal(backup,1);
});

test('v95: macro rotation eventually probes and selects a recovered better source',async t=>{
 let now=BASE,primary=0,recovered=false;const p=createMacroQuoteReader({now:()=>now,httpsGet:async()=>{throw Error('offline');},fetchChart:async()=>{throw Error('offline');},
 futures:{getQuote:async symbol=>{if(symbol!=='NQ00Y.FUT')throw Error('offline');primary++;if(!recovered)throw Error('temporary');return {symbol,price:100,quoteAt:now,sourceCheckedAt:now};}},
 publicSources:{routes:{'NQ00Y.FUT':[['test:backup',async()=>({symbol:'alternate',price:99,sourceCheckedAt:now,proxy:true})]]}}});t.after(()=>p.close());
 assert.equal((await p.readQuote('NQ00Y.FUT')).price,99);recovered=true;
 let latest;for(let i=0;i<8;i++){now+=30000;latest=await p.readQuote('NQ00Y.FUT');}
 assert.ok(primary>1);assert.equal(latest.price,100);
});

test('v95: resetting while a background fallback waits prevents it launching the next provider',async()=>{
 let release,naver=0;const pending=new Promise(r=>release=r);
 const p=createFastPolling({now:()=>BASE,httpsGet:async()=>({status:200,body:currentSina(BASE)}),legacy:{tencent:async()=>pending,fetchSnapshotBatch:async()=>{naver++;return {quotes:[]};}}});
 await p.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});p.reset();release([]);await tick();
 assert.equal(naver,0,'pre-reset fallback chain cannot launch work in the new generation');assert.equal(p.diagnostics().slots,0);
});

test('v95: different stock polling phases cannot starve the less frequent stock backup probes',async()=>{
 let now=BASE;const calls={tencent:new Set(),naver:new Set()};
 const p=createFastPolling({now:()=>now,httpsGet:async()=>({status:200,body:currentSina(now)+currentSina(now).replaceAll('NVDA','LITE').replaceAll('nvda','lite')}),legacy:{
  tencent:async symbols=>{for(const s of symbols)calls.tencent.add(s);return symbols.map(symbol=>({symbol,price:100,quoteAt:now,sourceCheckedAt:now,pollAfterMs:1000}));},
  fetchSnapshotBatch:async symbols=>{for(const s of symbols)calls.naver.add(s);return {quotes:symbols.map(symbol=>({symbol,price:100,quoteAt:now,sourceCheckedAt:now,pollAfterMs:1000}))};}
 }});
 await p.fetchSnapshotBatch(['NVDA','LITE'],{group:'us'});
 for(let elapsed=1000;elapsed<=190000;elapsed+=1000){now=BASE+elapsed;await p.fetchSnapshotBatch(['NVDA'],{group:'us'});if(elapsed%60000===10000)await p.fetchSnapshotBatch(['LITE'],{group:'us'});await tick();}
 assert.ok(calls.tencent.has('LITE'),'group cursor cannot consume every slow-stock probe turn');assert.ok(calls.naver.has('LITE'));
});

test('v95: joining a source job for other symbols retries the uncovered symbols after that job settles',async()=>{
 let release;const calls=[],pending=new Promise(r=>release=r),quote=symbol=>({symbol,price:100,quoteAt:BASE,sourceCheckedAt:BASE,pollAfterMs:1000});
 const p=createFastPolling({preferred:'tencent',now:()=>BASE,httpsGet:async()=>({status:200,body:''}),legacy:{tencent:async symbols=>{calls.push(symbols);if(calls.length===1)await pending;return symbols.map(quote);},fetchSnapshotBatch:async()=>({quotes:[]})}});
 const first=p.fetchSnapshotBatch(['NVDA'],{group:'us'});await tick();const second=p.fetchSnapshotBatch(['LITE'],{group:'us'});release();
 const results=await Promise.all([first,second]);assert.equal(results[1].quotes[0]?.symbol,'LITE');assert.deepEqual(calls,[['NVDA'],['LITE']]);
});

test('v95: Japanese stocks use their dedicated supported provider and preserve its TTL',async()=>{
 const p=createFastPolling({httpsGet:async()=>{throw Error('unsupported Sina route');},legacy:{fetchSnapshotBatch:async(symbols,{group})=>{assert.equal(group,'jp');return {quotes:symbols.map(symbol=>({symbol,pollAfterMs:70000})),pollAfterMs:70000};}}});
 assert.equal((await p.fetchSnapshotBatch(['9766.T'],{group:'jp'})).pollAfterMs,70000);
});

test('v95: more than 48 active chart symbols retain their history source rotation turns',async()=>{
 let now=BASE,backup=0;const p=createHistorySource({now:()=>now,primary:async symbol=>raw(symbol,'primary'),alternative:async symbol=>{backup++;return raw(symbol,'backup');}});
 const symbols=Array.from({length:49},(_,i)=>'TEST'+i);
 for(const symbol of symbols)await p(symbol,'?interval=1d');now+=300001;
 for(const symbol of symbols){await p(symbol,'?interval=1d');await tick();}assert.equal(backup,symbols.length);p.close();
});

test('v95: successful complete history returns before a slow optional probe exhausts the caller deadline',async()=>{
 let now=BASE,probeSignal;const p=createHistorySource({now:()=>now,primary:async()=>({...raw('NVDA','primary'),retrievalLimited:false}),alternative:async(_s,_q,{signal})=>{
  probeSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }});
 await p('NVDA','?interval=1d');now+=300001;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Object.assign(Error('deadline'),{code:'HISTORY_TIMEOUT'})),20);
 try{assert.equal((await p('NVDA','?interval=1d',{signal:controller.signal})).source,'primary');assert.equal(controller.signal.aborted,false);await tick();assert.ok(probeSignal);}
 finally{clearTimeout(timer);controller.abort();await tick();p.close?.();}
 assert.equal(probeSignal.aborted,true);
});

test('v95: successful Nasdaq history is not lost to an optional Eastmoney deadline',async()=>{
 let now=BASE,probeSignal;const p=createPublicHistory({now:()=>now,httpsGet:async(url,_headers,{signal})=>{
  if(url.includes('nasdaq'))return {status:200,body:JSON.stringify({data:{symbol:'NVDA',tradesTable:{rows:[{date:'09/09/2026',open:'100',high:'105',low:'99',close:'102',volume:'1'}]}}})};
  probeSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }});
 await p('NVDA','?interval=1d');now+=300001;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Object.assign(Error('deadline'),{code:'HISTORY_TIMEOUT'})),20);
 try{assert.equal((await p('NVDA','?interval=1d',{signal:controller.signal})).source,'nasdaq-history');assert.equal(controller.signal.aborted,false);await tick();assert.ok(probeSignal);}
 finally{clearTimeout(timer);controller.abort();await tick();p.close?.();}
 assert.equal(probeSignal.aborted,true);
});

test('v95: optional history probes have their own execution deadline and caller success is retained',async()=>{
 let now=BASE,probeSignal;const p=createHistorySource({now:()=>now,probeTimeoutMs:10,primary:async()=>raw('NVDA','primary'),alternative:async(_s,_q,{signal})=>{
  probeSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 }});
 await p('NVDA','?interval=1d');now+=300001;assert.equal((await p('NVDA','?interval=1d')).source,'primary');
 await new Promise(r=>setTimeout(r,30));assert.equal(probeSignal.aborted,true);assert.equal(probeSignal.reason.code,'HISTORY_PROBE_TIMEOUT');assert.equal(p.diagnostics().probes.active,0);p.close();
});

test('v95: optional probes remain single-flight, stop cancels them and old completion cannot affect restart',async()=>{
 let now=BASE,calls=0,release,probeSignal;const pending=new Promise(r=>release=r),p=createHistorySource({now:()=>now,primary:async()=>raw('NVDA','primary'),alternative:async(_s,_q,{signal})=>{calls++;probeSignal=signal;await pending;return {...raw('NVDA','backup'),retrievalLimited:false};}});
 await p('NVDA','?interval=1d');now+=300001;await p('NVDA','?interval=1d');await tick();now+=300001;await p('NVDA','?interval=1d');assert.equal(calls,1);
 p.close();assert.equal(probeSignal.aborted,true);await assert.rejects(p('NVDA','?interval=1d'),{code:'STOPPED'});p.reopen();release();await tick();
 assert.equal(p.diagnostics().probes.results,0);assert.equal((await p('NVDA','?interval=1d')).source,'primary');p.close();
});

test('v95: a verified broader probe may guide a later complete read but never replaces the current response',async()=>{
 let now=BASE,backup=0;const wider={...raw('NVDA','backup'),timestamp:[BASE/1000-2*86400,BASE/1000-86400],indicators:{quote:[{open:[100,100],high:[105,105],low:[99,99],close:[102,102]}]}};
 const p=createHistorySource({now:()=>now,primary:async()=>raw('NVDA','primary'),alternative:async()=>{backup++;return wider;}});
 await p('NVDA','?interval=1d');now+=300001;assert.equal((await p('NVDA','?interval=1d')).source,'primary');await tick();
 now++;const result=await p('NVDA','?interval=1d');assert.strictEqual(result,wider);assert.equal(backup,2,'later selection obtains the validated whole source sequence');p.close();
});

test('v95: a foreground wider history request does not inherit an optional shared probe deadline',async()=>{
 let now=BASE,eastmoney=0,failPrimary=false;
 const p=createPublicHistory({now:()=>now,probeTimeoutMs:10,httpsGet:async(url,_headers,{signal})=>{
  if(url.includes('nasdaq'))return failPrimary?{status:503,headers:{}}:{status:200,body:JSON.stringify({data:{symbol:'NVDA',tradesTable:{rows:[{date:'09/09/2026',open:'100',high:'105',low:'99',close:'102',volume:'1'}]}}})};
  eastmoney++;if(eastmoney===1)return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  return {status:200,body:JSON.stringify({data:{code:'NVDA',market:105,klines:['2026-09-09,100,102,105,99,1']}})};
 }});
 await p('NVDA','?interval=1d&range=2y');now+=300001;await p('NVDA','?interval=1d&range=2y');await tick();failPrimary=true;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('foreground deadline')),200);
 try{assert.equal((await p('NVDA','?interval=1d&range=40y',{signal:controller.signal})).source,'eastmoney-history');assert.equal(eastmoney,2);}
 finally{clearTimeout(timer);controller.abort();p.close();}
});
