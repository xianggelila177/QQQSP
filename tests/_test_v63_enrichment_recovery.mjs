import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSnapshotService} from '../lib/snapshot-service.js';
import {createYahooBreaker} from '../lib/yahoo-breaker.js';
import {createYahooService} from '../lib/yahoo.js';
import {createQuoteCache} from '../lib/quote-cache.js';
import {cacheSet} from '../lib/cache.js';
const quiet={debug(){},info(){},warn(){},error(){}};
const start=Date.parse('2026-09-06T02:00:00Z');
function fixture(enrich,options={}) {
  const original={setTimeout,clearTimeout,setInterval,clearInterval},timeouts=new Map(),intervals=new Map();let id=0;
  const h={time:start,market:'CLOSED',calls:0};
  globalThis.setTimeout=(fn,ms=0)=>{timeouts.set(++id,{fn,at:h.time+ms});return id;};
  globalThis.clearTimeout=key=>timeouts.delete(key);
  globalThis.setInterval=(fn,ms)=>{intervals.set(++id,{fn,ms});return id;};
  globalThis.clearInterval=key=>intervals.delete(key);
  const drain=async()=>{for(let i=0;i<40;i++){await Promise.resolve();for(const [key,t] of [...timeouts])if(t.at<=h.time){timeouts.delete(key);t.fn();}}};
  h.service=createSnapshotService({now:()=>h.time,sessionFor:()=>h.market,fetchBatch:async symbols=>({quotes:symbols.map(symbol=>({symbol,price:200,src:'naver-us',quoteAt:h.time,fetchedAt:h.time,marketState:h.market})),pollAfterMs:2000}),enrich:async symbol=>{h.calls++;return enrich(symbol,h);},...options});
  h.read=(symbol='QQQ')=>h.service.getCachedQuote(symbol);
  h.tick=async()=>{for(const timer of [...intervals.values()])timer.fn();await drain();};
  h.advance=async ms=>{h.time+=ms;h.read();await h.tick();};
  h.close=async()=>{h.service.stop();await drain();Object.assign(globalThis,original);};
  h.service.start();h.read();return h;
}
const fallback=(symbol,h)=>({symbol,price:100,src:'tx-us',quoteAt:h.time,fetchedAt:h.time,marketState:h.market,charts:{intraday:[],daily30:[{t:1,c:100}]}});
const full=(symbol,h)=>({symbol,price:100,src:'yahoo',quoteAt:h.time,fetchedAt:h.time,marketState:h.market,charts:{intraday:[{t:h.time/1000,c:100}],daily30:[{t:1,c:100}]},slowFields:{intraday:{source:'yahoo',updatedAt:h.time,stale:false},daily30:{source:'nasdaq',updatedAt:h.time,stale:false},charts:{source:'yahoo/nasdaq',updatedAt:h.time,stale:false}}});

test('cold US fallback has honest missing-field metadata and recovers after60seconds while batch price stays fresh',async()=>{
 const h=fixture((symbol,h)=>h.calls===1?fallback(symbol,h):full(symbol,h));
 try{
  await h.tick();const initial=h.read();assert.equal(initial.price,200);assert.equal(initial.src,'naver-us');assert.equal(initial.stale,undefined);assert.equal(initial.staleInfo,undefined);
  assert.equal(initial.slowFields.intraday.status,'missing');assert.equal(initial.slowFields.intraday.stale,true);assert.equal(initial.slowFields.intraday.updatedAt,null);assert.equal(initial.slowFields.charts.stale,true);assert.equal(initial.slowFields.daily30.stale,false);
  await h.advance(59999);assert.equal(h.calls,1);await h.advance(1);assert.equal(h.calls,2);
  const recovered=h.read();assert.equal(recovered.charts.intraday.length,1);assert.equal(recovered.slowFields.intraday.stale,false);assert.equal(recovered.slowFields.intraday.error,undefined);assert.equal(recovered.slowFields.charts.stale,false);assert.equal(recovered.price,200);assert.ok(recovered.quoteAt>=h.time-2000,'fast quote stays within its own provider cadence');
  assert.equal(recovered.sessionStartedAt,initial.sessionStartedAt,'session context remains present and stable');
  await h.advance(60000);assert.equal(h.calls,2,'complete recovery restores the closed-market cadence');
 }finally{await h.close();}
});

test('incomplete and rejected enrichments back off exponentially to the normal closed cadence',async()=>{
 let reject=false;const h=fixture((symbol,h)=>{if(reject)throw new Error('primary unavailable');return fallback(symbol,h);});
 try{
  await h.tick();let count=1;
  for(const delay of [60000,120000,240000,480000,900000,900000]){
   // Keep the established300second subscriber lease alive during long waits.
   for(let elapsed=0;elapsed<delay-1;){const step=Math.min(180000,delay-1-elapsed);await h.advance(step);elapsed+=step;}
   assert.equal(h.calls,count);reject=!reject;await h.advance(1);assert.equal(h.calls,++count);
  }
 }finally{await h.close();}
});

test('legitimate empty and explicitly unsupported history do not start a minute retry loop',async()=>{
 for(const mode of ['empty','empty-primary-status','unsupported','no-history','no-requested-charts']){
  const h=fixture((symbol,h)=>({...full(symbol,h),charts:mode==='no-requested-charts'?undefined:{intraday:[],daily30:[]},src:mode==='unsupported'?'tx-us':'yahoo',slowFields:['unsupported','no-history'].includes(mode)?{intraday:{status:mode,stale:false,updatedAt:null},daily30:{status:mode,stale:false,updatedAt:null}}:mode==='empty-primary-status'?{intraday:{source:'yahoo',updatedAt:h.time,stale:true}}:{}}));
  try{await h.tick();assert.equal(h.read().slowFields?.intraday?.error,undefined,mode+' has no invented failure');for(let i=0;i<14;i++)await h.advance(60000);assert.equal(h.calls,1,mode);await h.advance(60000);assert.equal(h.calls,2,mode+' uses normal cadence');}finally{await h.close();}
 }
});

test('failed primary field refresh retains prior successful series and timestamp without rolling back the fast price',async()=>{
 const h=fixture((symbol,h)=>h.calls===1?full(symbol,h):h.calls===2?{...full(symbol,h),charts:{intraday:[],daily30:[{t:1,c:100}]},slowFields:{intraday:{source:'yahoo',updatedAt:null,stale:true,error:'primary chart request failed'}}}:full(symbol,h));
 try{
  await h.tick();const initial=h.read();for(let i=0;i<15;i++)await h.advance(60000);
  const degraded=h.read();assert.equal(h.calls,2);assert.equal(degraded.charts.intraday,initial.charts.intraday);assert.equal(degraded.slowFields.intraday.updatedAt,start);assert.equal(degraded.slowFields.intraday.stale,true);assert.equal(degraded.slowFields.charts.stale,true);assert.equal(degraded.price,200);assert.equal(degraded.stale,undefined);
  await h.advance(60000);assert.equal(h.calls,3);assert.equal(h.read().slowFields.intraday.stale,false);
 }finally{await h.close();}
});

test('recovery retries remain single-flight while a request is pending',async()=>{
 let release;const h=fixture((symbol,h)=>h.calls===1?fallback(symbol,h):new Promise(resolve=>{release=()=>resolve(full(symbol,h));}));
 try{
  await h.tick();await h.advance(60000);assert.equal(h.calls,2);assert.equal(h.service.diagnostics().enriching,1);
  for(let i=0;i<4;i++)await h.advance(60000);assert.equal(h.calls,2);assert.equal(h.read().slowFields.intraday.refreshState,'refreshing');
  release();await h.tick();assert.equal(h.read().slowFields.intraday.stale,false);
 }finally{release?.();await h.close();}
});

test('retry floors from explicit upstream failures survive the faster recovery schedule',async()=>{
 const h=fixture((symbol,h)=>{if(h.calls===1)throw Object.assign(new Error('rate limit'),{retryAfterMs:180000});return full(symbol,h);});
 try{
  await h.tick();await h.advance(60000);assert.equal(h.calls,1);await h.advance(119999);assert.equal(h.calls,1);await h.advance(1);assert.equal(h.calls,2);assert.equal(h.read().price,200);assert.equal(h.read().stale,undefined);
 }finally{await h.close();}
});

test('snapshot recovery cannot bypass the real Yahoo gateway breaker',async()=>{
 let h,yahoo,cache,upstreamCalls=0;
 h=fixture(symbol=>cache.getCachedQuote(symbol));
 const breaker=createYahooBreaker({now:()=>h.time,base:180000,cap:180000,log:quiet});breaker.gatewayManaged=true;
 yahoo=createYahooService({now:()=>h.time,env:{Y_MIN_GAP:0,Y_TASK_DEADLINE:1000},breaker});
 cache=createQuoteCache({cacheMap:new Map(),inflight:new Map(),failAt:new Map(),cacheSet,now:()=>h.time,breaker,log:quiet,stats:{quote:{fetched:0}},usFallbackQuote:async symbol=>fallback(symbol,h),fetchQuote:async symbol=>{await yahoo.yGated(()=>{upstreamCalls++;return {status:200};});return full(symbol,h);}});
 try{
  breaker.hit('fixture');await h.tick();assert.equal(upstreamCalls,0);assert.equal(h.calls,1);
  await h.advance(60000);assert.equal(h.calls,2);assert.equal(upstreamCalls,0,'still-blocked gateway gets no new upstream work');
  await h.advance(120000);assert.equal(h.calls,3);assert.equal(upstreamCalls,1);assert.equal(h.read().slowFields.intraday.stale,false);
 }finally{cache.close();await yahoo.close();await h.close();}
});

test('a full chart recovery resets the retry streak and optional missing fields do not hold it open',async()=>{
 const h=fixture((symbol,h)=>[1,2,4].includes(h.calls)?fallback(symbol,h):{...full(symbol,h),slowFields:{...full(symbol,h).slowFields,week52Range:{stale:true,error:'optional range unavailable'},fx:{stale:true,error:'reference FX handled separately'}}});
 try{
  await h.tick();await h.advance(60000);assert.equal(h.calls,2);await h.advance(120000);assert.equal(h.calls,3);
  assert.deepEqual(h.service.diagnostics().enrichmentRetries,{});
  for(let i=0;i<15;i++)await h.advance(60000);assert.equal(h.calls,4);
  await h.advance(60000);assert.equal(h.calls,5,'a fresh failure begins at60seconds after successful recovery');
 }finally{await h.close();}
});

test('the300second subscriber lease and pruning discard retry bookkeeping',async()=>{
 const h=fixture(fallback);
 try{
  await h.tick();assert.equal(h.service.diagnostics().enrichmentRetries.QQQ.failures,1);
  h.time+=299999;h.read();assert.equal(h.service.diagnostics().active,1,'a subscriber within300seconds remains registered');
  h.time+=300001;await h.tick();assert.equal(h.service.diagnostics().active,0);assert.deepEqual(h.service.diagnostics().enrichmentRetries,{});
  h.read();await h.tick();assert.equal(h.calls,2);assert.equal(h.service.diagnostics().enrichmentRetries.QQQ.failures,1,'a new lease starts cleanly');
 }finally{await h.close();}
});

test('an explicit terminal response clears prior partial retry markers while retaining successful history',async()=>{
 const h=fixture((symbol,h)=>h.calls===1?full(symbol,h):h.calls===2?fallback(symbol,h):{...fallback(symbol,h),slowFields:{intraday:{source:'primary',status:'unsupported',stale:false,updatedAt:null}}});
 try{
  await h.tick();const initial=h.read();for(let i=0;i<15;i++)await h.advance(60000);assert.equal(h.calls,2);assert.equal(h.read().slowFields.charts.retryable,true);
  await h.advance(60000);assert.equal(h.calls,3);const terminal=h.read();assert.equal(terminal.charts.intraday,initial.charts.intraday);assert.equal(terminal.slowFields.intraday.status,'unsupported');assert.equal(terminal.slowFields.intraday.error,undefined);assert.equal(terminal.slowFields.charts.retryable,false);assert.deepEqual(h.service.diagnostics().enrichmentRetries,{});
  await h.advance(60000);assert.equal(h.calls,3,'terminal result restores ordinary cadence');
 }finally{await h.close();}
});

for(const kind of ['absolute','relative'])test('retaining old series also retains the current '+kind+' upstream retry floor',async()=>{
 const h=fixture((symbol,h)=>h.calls===2?{...full(symbol,h),charts:{intraday:[],daily30:[{t:1,c:100}]},slowFields:{intraday:{source:'yahoo',error:'primary rate limited',...(kind==='absolute'?{retryAt:h.time+180000}:{retryAfterMs:180000})}}}:full(symbol,h));
 try{
  await h.tick();const first=h.read();for(let i=0;i<15;i++)await h.advance(60000);assert.equal(h.calls,2);
  const failed=h.read();assert.equal(failed.charts.intraday,first.charts.intraday);assert.equal(failed.slowFields.intraday.updatedAt,start);assert.equal(failed.slowFields.intraday.retryAt,h.time+180000);
  await h.advance(60000);assert.equal(h.calls,2);await h.advance(119999);assert.equal(h.calls,2);await h.advance(1);assert.equal(h.calls,3);
 }finally{await h.close();}
});

test('an unusable resolved error quote honors its upstream retry hint',async()=>{
 const h=fixture((symbol,h)=>h.calls===1?{symbol,price:null,error:'rate limited',retryAfterMs:180000}:full(symbol,h));
 try{await h.tick();await h.advance(60000);assert.equal(h.calls,1);await h.advance(120000);assert.equal(h.calls,2);}finally{await h.close();}
});
