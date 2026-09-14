import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createApplication, stop as stopLegacy } from '../server.js';
after(()=>stopLegacy());
import { createTelemetry } from '../log.mjs';
import { createNasdaqProvider } from '../lib/providers/nasdaq.js';
import { createYahooAuth } from '../lib/yahoo-auth.js';
import { createTransport } from '../lib/transport.js';
const log={debug(){},info(){},warn(){},error(){}};
const tick=()=>new Promise(r=>setTimeout(r,5));
const appFor=(options={})=>createApplication({env:{PORT:'0',Y_MIN_GAP:'0',SYMBOLS:'!',...options.env},telemetry:createTelemetry({logger:log}),...options});
const response=(status,body={},headers={})=>({status,body:JSON.stringify(body),headers});

test('B01 all Yahoo entrances honor breaker; search failure never becomes cached empty success',async()=>{
 let calls=0,at=100000;const app=appFor({now:()=>at,upstream:async()=>{calls++;return response(429);}});
 try{
  app.services.auth.seed();app.services.breaker.hit('fixture');
  await assert.rejects(app.services.search.yahooSearch('AAPL'));
  await assert.rejects(app.services.yahoo.yGated(()=>{calls++;return response(200);}));
  await app.services.yahoo.getFxRates();
  assert.equal(calls,0);assert.equal(app.services.search.searchCache.size,0);
  app.services.breaker.reset();app.services.search.clearSearchCache();
  await assert.rejects(app.services.search.yahooSearch('AAPL'));
  assert.equal(calls,1);assert.equal(app.services.breaker.state().events,1);assert.equal(app.services.search.searchCache.size,0);
 }finally{await app.stop();}
});

test('B01 FX batch 429 has no chart fanout and cold failure is stale with retry cooldown',async()=>{
 let calls=0,at=100000;const app=appFor({now:()=>at,upstream:async()=>{calls++;return response(429,{}, {'retry-after':'90'});}});
 try{
  app.services.auth.seed();assert.deepEqual(await app.services.yahoo.getFxRates(),{});
  assert.equal(calls,1);assert.equal(app.services.yahoo.fxMetadata().fxStale,true);
  assert.equal(app.services.breaker.state().events,1);
  assert.ok(app.services.breaker.state().until>=at+90000);
  at+=50000;assert.deepEqual(await app.services.yahoo.getFxRates(),{});assert.equal(calls,1,'Retry-After prevents an early same-source probe');
 }finally{await app.stop();}
});

test('B01 a single half-open request probes and recovers through the gateway',async()=>{
 let calls=0,at=100000,release;const app=appFor({now:()=>at,upstream:()=>{calls++;return new Promise(r=>release=r);}});
 try{
  app.services.breaker.hit('fixture');at+=16000;
  const pending=app.services.search.yahooSearch('AAPL');
  const denied=assert.rejects(app.services.search.yahooSearch('MSFT'));
  await tick();assert.equal(calls,1);release(response(200,{quotes:[]}));await pending;await denied;
  assert.equal(app.services.breaker.state().blocked,false);
 }finally{await app.stop();}
});

for(const failure of ['503','json','timeout'])test('B02 Nasdaq '+failure+' keeps last successful bars and time',async()=>{
 let at=100000,mode='ok',calls=[];const provider=createNasdaqProvider({now:()=>at,slowTtl:20,failureCooldown:30,log,httpsGet:async url=>{
  calls.push(new URL(url));if(mode==='timeout')throw new Error('timeout');if(mode==='503')return response(503);if(mode==='json')return {status:200,body:'{broken'};
  return response(200,{data:{tradesTable:{rows:[{date:'09/01/2026',open:'$100',high:'$102',low:'$99',close:'$101',volume:'1,000'}]}}});
 }});
 const first=await provider.getNasdaqDaily('AAPL'),original=provider.nasdaqDailyMetadata('AAPL').updatedAt;
 at+=300001;mode=failure;calls=[];
 assert.deepEqual(await provider.getNasdaqDaily('AAPL'),first);assert.equal(provider.nasdaqDailyMetadata('AAPL').updatedAt,original);assert.equal(provider.nasdaqDailyMetadata('AAPL').stale,true);
 assert.equal(new Set(calls.map(u=>u.searchParams.get('assetclass'))).size,calls.length);assert.ok(calls.length<=2);
 const count=calls.length;await provider.getNasdaqDaily('AAPL');assert.equal(calls.length,count);
 assert.equal(calls[0].searchParams.get('todate'),new Date(at).toISOString().slice(0,10));
});

test('B02 explicit unsupported Nasdaq result is negative cached',async()=>{
 let calls=0;const p=createNasdaqProvider({log,httpsGet:async()=>{calls++;return response(200,{data:null,status:{bCodeMessage:[{errorMessage:'Symbol not exist'}]}});}});
 assert.deepEqual(await p.getNasdaqDaily('MISSING'),[]);assert.equal(calls,2);
 assert.deepEqual(await p.getNasdaqDaily('MISSING'),[]);assert.equal(calls,2);assert.equal(p.nasdaqDailyMetadata('MISSING').status,'unsupported');
});

for(const stage of ['cookie','crumb'])for(const kind of ['timeout','reset','429'])test(`B06 auth ${stage} ${kind} cools down then single-flights recovery`,async()=>{
 let at=100000,calls=0,mode=kind,hits=0;const auth=createYahooAuth({now:()=>at,failureCooldown:100,log,onRateLimit:()=>hits++,yGated:fn=>fn(new AbortController().signal,1000),httpsGet:async url=>{
  calls++;if(mode!=='ok'&&(url.includes('fc.yahoo.com')?stage==='cookie':stage==='crumb')){
   if(mode==='429')return response(429);throw Object.assign(new Error(mode),{code:mode==='reset'?'ECONNRESET':'ETIMEDOUT'});
  }
  return url.includes('fc.yahoo.com')?response(404,{}, {'set-cookie':['sid=good; Path=/']}):{status:200,body:'crumb-good'};
 }});
 await assert.rejects(auth.getCrumb());const first=calls;await assert.rejects(auth.getCrumb());assert.equal(calls,first);assert.ok(auth.state().crumbFailUntil>at);if(kind==='429')assert.equal(hits,1);
 at+=101;mode='ok';const pairs=await Promise.all([auth.getCrumb(),auth.getCrumb()]);assert.equal(calls,first+2);assert.equal(pairs[0].cookie,'sid=good');
});

test('B05 stop cancels wait, queued, and non-cooperating active promises and supports clean restart',async()=>{
 let started=0,release;const app=appFor({env:{PORT:'0',Y_MIN_GAP:'50',SYMBOLS:'!'},upstream:()=>{started++;return new Promise(r=>release=r);}});
 const first=app.services.yahoo.yGated((signal,timeout)=>app.services.transport.httpsGet('https://query1.finance.yahoo.com/test',{}, {signal,timeout}));
 const second=app.services.yahoo.yGated(()=>{started++;return response(200);});
 const settled=Promise.allSettled([first,second]);await tick();assert.equal(started,1);
 await app.stop();await app.stop();
 const result=await Promise.race([settled,new Promise((_,reject)=>setTimeout(()=>reject(new Error('stop did not settle pending work')),150))]);
 assert.ok(result.every(x=>x.status==='rejected'));release(response(200));await tick();assert.equal(started,1);
 await assert.rejects(app.services.yahoo.yGated(()=>{started++;}));await assert.rejects(app.services.transport.httpsGet('https://query1.finance.yahoo.com/test'));
 app.start();await new Promise(r=>app.httpServer.listening?r():app.httpServer.once('listening',r));
 assert.equal(await app.services.yahoo.yGated(()=>42),42);await app.stop();
});

test('B05 stopping in the request-gap window never starts queued work',async()=>{
 const app=appFor({env:{PORT:'0',Y_MIN_GAP:'80',SYMBOLS:'!'},upstream:async()=>response(200)});let calls=0;
 await app.services.yahoo.yGated(()=>{calls++;});const p=app.services.yahoo.yGated(()=>{calls++;});const outcome=Promise.allSettled([p]);await app.stop();await outcome;
 await new Promise(r=>setTimeout(r,90));assert.equal(calls,1);
});

test('B10 two application configs, clocks, and logger attribution stay isolated',async()=>{
 let at=100000;const logsA=[],logsB=[];const logger=events=>Object.fromEntries(['debug','info','warn','error'].map(k=>[k,(msg,meta)=>events.push({msg,meta})]));
 const a=appFor({env:{PORT:'0',Y_MIN_GAP:'0',NEWS_MAX_ACTIVE:'1',NEWS_TTL:'10',SLOW_TTL:'10',CACHE_MS:'1',QUOTE_MAX_AGE:'1'},now:()=>at,telemetry:createTelemetry({now:()=>at,logger:logger(logsA)}),upstream:async()=>response(503),providerOverrides:{fetchQuote:async symbol=>({symbol,price:1})}});
 const b=appFor({env:{PORT:'0',NEWS_MAX_ACTIVE:'2',NEWS_TTL:'1000'},now:()=>at+1000,telemetry:createTelemetry({logger:logger(logsB)}),upstream:async()=>response(503)});
 try{
  assert.equal(a.services.news.activateNews('AAPL'),true);assert.equal(a.services.news.activateNews('MSFT'),false);assert.equal(b.services.news.activateNews('AAPL'),true);assert.equal(b.services.news.activateNews('MSFT'),true);
  let loads=0;a.services.news.__impl.newsFor=async()=>{loads++;return [];};await a.services.news.requestNews('AAPL');at+=11;await a.services.news.requestNews('AAPL');assert.equal(loads,2);
  a.services.auth.seed();at+=55*60*1000+1;await assert.rejects(a.services.auth.getCrumb());assert.ok(a.services.auth.state().crumbFailUntil>at);
  await a.services.nasdaq.getNasdaqDaily('AAPL');assert.ok(logsA.length>0);assert.equal(logsB.length,0);
  await a.getCachedQuote('AAPL');assert.equal(a.services.quote.cacheMap.get('AAPL').ts,at);at+=2;await a.getCachedQuote('AAPL');assert.equal(a.services.quote.cacheMap.get('AAPL').ts,at);
 }finally{await a.stop();await b.stop();}
});

test('B10 invalid resource configuration fails closed instead of disabling limits',()=>{
 assert.throws(()=>appFor({env:{NEWS_MAX_ACTIVE:'NaN'}}),/NEWS_MAX_ACTIVE/);
 assert.throws(()=>appFor({env:{Y_QUEUE_MAX:'-1'}}),/Y_QUEUE_MAX/);
});

test('B01 search failed refresh retains prior success and cools down network errors',async()=>{
 let at=100000,calls=0,fail=false;const app=appFor({now:()=>at,upstream:async()=>{calls++;if(fail)throw new Error('reset');return response(200,{quotes:[{symbol:'AAPL',shortname:'Apple'}]});}});
 try{
  await app.services.search.yahooSearch('AAPL');const cached=app.services.search.searchCache.get('aapl');at+=60001;fail=true;
  await assert.rejects(app.services.search.yahooSearch('AAPL'));await assert.rejects(app.services.search.yahooSearch('AAPL'));assert.equal(calls,2);assert.equal(app.services.search.searchCache.get('aapl'),cached);
  at+=30001;fail=false;await app.services.search.yahooSearch('AAPL');assert.equal(calls,3);
 }finally{await app.stop();}
});

test('B01 queued requests are rechecked after a prior request reports 429',async()=>{
 const app=appFor();let calls=0;
 const result=await Promise.allSettled([app.services.yahoo.yGated(()=>{calls++;return response(429);}),app.services.yahoo.yGated(()=>{calls++;return response(200);})]);
 assert.equal(calls,1);assert.ok(result.every(r=>r.status==='rejected'));await app.stop();
});

test('B06 cookie 429 through the real gateway never starts the crumb stage',async()=>{
 const urls=[];const app=appFor({upstream:async url=>{urls.push(url);return response(429);}});
 try{await assert.rejects(app.services.auth.getCrumb());await assert.rejects(app.services.auth.getCrumb());assert.equal(urls.length,1);assert.match(urls[0],/fc.yahoo.com/);assert.equal(app.services.breaker.state().events,1);}finally{await app.stop();}
});

test('B05 old quote and news completions cannot change restarted caches',async()=>{
 let resolveQuote,resolveNews;const app=appFor({providerOverrides:{fetchQuote:()=>new Promise(r=>resolveQuote=r)}});
 app.services.news.__impl.newsFor=()=>new Promise(r=>resolveNews=r);
 const quotes=app.getCachedQuote('AAPL'),news=app.services.news.requestNews('AAPL');const settled=Promise.allSettled([quotes,news]);await tick();
 await app.stop();assert.ok((await settled).every(r=>r.status==='rejected'));
 app.start();await new Promise(r=>app.httpServer.listening?r():app.httpServer.once('listening',r));
 resolveQuote({symbol:'AAPL',price:99});resolveNews([{title:'obsolete'}]);await tick();
 assert.equal(app.services.quote.cacheMap.size,0);assert.equal(app.services.news.newsCache.size,0);await app.stop();
});

test('B05 cancel queued Yahoo request and deadline release the slot',async()=>{
 const app=appFor({env:{PORT:'0',Y_MIN_GAP:'0',Y_TASK_DEADLINE:'15'}});let calls=0;
 try{
  const first=app.services.yahoo.yGated(()=>new Promise(()=>{}));const ctrl=new AbortController();const second=app.services.yahoo.yGated(()=>{calls++;},{signal:ctrl.signal});
  const settled=Promise.allSettled([first,second]);ctrl.abort();assert.ok((await settled).every(r=>r.status==='rejected'));
  assert.equal(await app.services.yahoo.yGated(()=>3),3);assert.equal(calls,0);
 }finally{await app.stop();}
});

test('B10 independent slow cache TTL uses the application env and fake clocks',async()=>{
 let at=100000,callsA=0,callsB=0;
 const fixture=response(200,{data:{tradesTable:{rows:[{date:'09/01/2026',open:'1',high:'2',low:'1',close:'2'}]}}});
 const a=appFor({env:{PORT:'0',SLOW_TTL:'10'},now:()=>at,upstream:async()=>{callsA++;return fixture;}}),b=appFor({env:{PORT:'0',SLOW_TTL:'100'},now:()=>at,upstream:async()=>{callsB++;return fixture;}});
 try{await a.services.nasdaq.getNasdaqDaily('AAPL');await b.services.nasdaq.getNasdaqDaily('AAPL');at+=11;await a.services.nasdaq.getNasdaqDaily('AAPL');await b.services.nasdaq.getNasdaqDaily('AAPL');assert.equal(callsA,2);assert.equal(callsB,1);}finally{await a.stop();await b.stop();}
});

test('B07 one daily history request derives OHLC and bars, with original successful times on failure',async()=>{
 let at=Date.UTC(2026,8,1,20),calls=0,fail=false;const rows=[{t:Date.UTC(2026,7,31,13,30)/1000,o:90,h:100,l:85,c:95},{t:Date.UTC(2026,8,1,13,30)/1000,o:96,h:105,l:92,c:101}];
 const app=appFor({env:{PORT:'0',Y_MIN_GAP:'0',SLOW_TTL:'100'},now:()=>at,upstream:async url=>{calls++;assert.match(url,/range=6mo/);if(fail)throw new Error('offline');return response(200,{chart:{result:[{meta:{gmtoffset:-14400},timestamp:rows.map(r=>r.t),indicators:{quote:[{open:rows.map(r=>r.o),high:rows.map(r=>r.h),low:rows.map(r=>r.l),close:rows.map(r=>r.c)}]}}]}});}});
 try{
  app.services.auth.seed();const [ohlc,bars]=await Promise.all([app.services.yahoo.getDayOhlc('AAPL','2026-8-1'),app.services.yahoo.getYahooDaily('AAPL')]);
  assert.equal(calls,1);assert.equal(ohlc.prevClose,95);assert.equal(ohlc.open,96);assert.equal(bars.length,2);
  const successfulAt=app.services.yahoo.yahooDailyMetadata('AAPL').updatedAt;at+=101;fail=true;
  const [oldOhlc,oldBars]=await Promise.all([app.services.yahoo.getDayOhlc('AAPL','2026-8-1'),app.services.yahoo.getYahooDaily('AAPL')]);
  assert.deepEqual(oldOhlc,ohlc);assert.deepEqual(oldBars,bars);assert.equal(calls,2);assert.equal(app.services.yahoo.yahooDailyMetadata('AAPL').updatedAt,successfulAt);assert.equal(app.services.yahoo.yahooDailyMetadata('AAPL').stale,true);
  await app.services.yahoo.getYahooDaily('AAPL');assert.equal(calls,2);
 }finally{await app.stop();}
});

test('T06 explicit relay credential file is bounded, fail-closed, and never disclosed in errors',async()=>{
 const {mkdtemp,writeFile,symlink,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'v62-relay-'));const file=join(dir,'credential'),secret='fixture-relay-value';
 const env={YAHOO_RELAY:'http://127.0.0.1:9999',YAHOO_RELAY_TOKEN_FILE:file};
 try{
  await writeFile(file,secret,{mode:0o600});const transport=createTransport({env,log});
  assert.equal(new URL(transport.relayRewrite('https://query1.finance.yahoo.com/test')).searchParams.get('token'),secret);await transport.close();
  const direct=createTransport({env:{...env,YAHOO_RELAY_TOKEN:'preferred-value',YAHOO_RELAY_TOKEN_FILE:join(dir,'missing')},log});assert.equal(new URL(direct.relayRewrite('https://query1.finance.yahoo.com/test')).searchParams.get('token'),'preferred-value');await direct.close();
  await symlink(file,join(dir,'link'));
  for(const bad of [join(dir,'missing'),join(dir,'link'),dir,'relative/path'])assert.throws(()=>createTransport({env:{...env,YAHOO_RELAY_TOKEN_FILE:bad},log}),e=>e.message==='Unable to load configured Yahoo relay credential file'&&!e.message.includes(secret));
  await writeFile(file,secret+'\ninvalid');assert.throws(()=>createTransport({env,log}),/Unable to load configured Yahoo relay credential file/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('B01 unavailable quote endpoint retains chart FX fallback, and later 429 halts remaining charts',async()=>{
 let calls=0,chartCalls=0,limited=false;const app=appFor({upstream:async url=>{
  calls++;if(url.includes('/v7/'))return response(401);chartCalls++;if(limited)return response(429);
  return response(200,{chart:{result:[{meta:{regularMarketPrice:7}}]}});
 }});
 try{
  app.services.auth.seed();const rates=await app.services.yahoo.getFxRates();assert.equal(Object.keys(rates).length,4);assert.equal(calls,5);
  app.__test.resetState();app.services.auth.seed();limited=true;calls=0;chartCalls=0;
  assert.deepEqual(await app.services.yahoo.getFxRates(),{});assert.equal(calls,2);assert.equal(chartCalls,1);assert.equal(app.services.breaker.state().events,1);
 }finally{await app.stop();}
});
