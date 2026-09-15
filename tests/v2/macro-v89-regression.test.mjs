import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createFuturesProvider} from '../../lib/providers/futures.js';
import {createMacroContext} from '../../lib/macro-context.js';
import {createMacroMonitor} from '../../lib/macro-monitor.js';
const START=Date.parse('2026-09-15T01:20:00Z'),flush=()=>new Promise(r=>setImmediate(r));
test('oversized NYMEX catalogue request must not prevent CL refresh',async()=>{
 let now=START,calls=0;const provider=createFuturesProvider({now:()=>now,httpsGet:async url=>{
  const u=new URL(url);if(u.hostname==='push2.eastmoney.com')throw Error('direct quote unavailable');
  calls++;if(Number(u.searchParams.get('pageSize'))>200)throw Object.assign(Error('socket closed on oversized catalogue'),{code:'ECONNRESET'});
  return {status:200,body:JSON.stringify({total:115,list:[{dm:'CL00Y',sc:102,p:100+calls,zjsj:99}]})};
 }});try{const first=await provider.getQuote('CL00Y.FUT');assert.equal(first.price,101);now+=31000;const second=await provider.getQuote('CL00Y.FUT');assert.equal(second.price,102);assert.equal(second.sourceCheckedAt,now);}finally{provider.close();}
});
test('one unresolved factor does not block the next refresh of the other factors',async()=>{
 let now=START,release,oilCalls=0;
 const context=createMacroContext({now:()=>now,readQuote:async symbol=>{if(symbol==='^TNX')await new Promise(r=>release=r);if(symbol==='CL00Y.FUT')oilCalls++;return {symbol,price:100+oilCalls,quoteAt:now,sourceCheckedAt:now};}});
 const monitor=createMacroMonitor({now:()=>now,context,tickMs:100000,macro:{getMacro:async()=>({items:[]})},calendar:{getCalendar:async()=>({status:'disabled'}),snapshot:()=>({})}});
 try{await monitor.start();await flush();await flush();assert.equal(oilCalls,1);now+=30001;monitor.runDue();await flush();await flush();assert.equal(oilCalls,2);}finally{release?.();await monitor.settled();await monitor.stop();context.close();}
});
test('declared delayed quotes refresh their displayed value but never become live minute comparisons',async()=>{
 let now=START,value=100;const context=createMacroContext({now:()=>now,readQuote:async symbol=>({symbol,price:value,quoteAt:now-600000,sourceCheckedAt:now,feedDelayMinutes:10,delayed:true,src:'fixture'})});
 await context.getContext();now+=30000;value=101;const out=await context.getContext();assert.equal(out.factors[1].price,101);assert.equal(out.factors[1].status,'delayed');assert.equal(out.factors[1].fresh,false);assert.equal(out.factors[1].change,null);context.close();
});
test('macro frontend shows automatic checks and source delay without saying the feed is frozen',()=>{
 const sandbox={window:{PANEL_FORMAT:{esc:String,fmtTime8:()=> '09:20:00'}},URL,Date};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-macro-context.js',import.meta.url),'utf8'),sandbox);
 const ui=sandbox.window.PANEL_MACRO_CONTEXT.createMacroContext({document:{},network:{},root:{},status:{}});
 const html=ui.renderFactor({id:'wti',name:'WTI',price:101,unit:'美元/桶',status:'delayed',delayed:true,feedDelayMinutes:10,sourceCheckedAt:START,nextCheckAt:START+30000,diagnostics:[]});assert.match(html,/延迟.*10|10.*分钟/);assert.doesNotMatch(html,/等待同窗数据/);assert.match(html,/检查.*09:20:00/);
});
test('absolute provider cache expiry avoids an extra thirty-second cache-only cycle',async()=>{
 let now=START,calls=0;const context=createMacroContext({now:()=>now,readQuote:async symbol=>{calls++;return {symbol,price:100,sourceCheckedAt:now,quoteAt:null,nextPollAt:now+30200,pollAfterMs:30000};}});
 await context.getContext();assert.equal(context.snapshot().factors[0].nextCheckAt,START+30200);now+=30000;await context.getContext();assert.equal(calls,5);now+=1000;await context.getContext();assert.equal(calls,10);context.close();
});
test('shared catalogue age is not renewed by a second futures cache and pagination stays bounded',async()=>{
 let now=START,calls=0;const provider=createFuturesProvider({now:()=>now,httpsGet:async url=>{const u=new URL(url);if(u.hostname==='push2.eastmoney.com')throw Error('offline');calls++;return {status:200,body:JSON.stringify({total:201,list:u.searchParams.get('pageIndex')==='0'?[{dm:'NG00Y',p:4},{dm:'CL00Y',p:100+calls}]:[{dm:'CL27F',p:99}]})};}});
 await provider.getQuote('NG00Y.FUT');now+=10000;assert.equal((await provider.getQuote('CL00Y.FUT')).sourceCheckedAt,START);now=START+31000;assert.equal((await provider.getQuote('CL00Y.FUT')).sourceCheckedAt,now);assert.equal(calls,2);assert.equal((await provider.getQuote('CL27F.FUT')).price,99);assert.equal(calls,3);provider.close();
});
test('a successful catalogue fallback is refreshed without retrying the failing primary every cycle',async()=>{
 let now=START,direct=0,directory=0;const provider=createFuturesProvider({now:()=>now,httpsGet:async url=>{if(url.includes('push2.eastmoney')){direct++;throw Error('slow direct source');}directory++;return {status:200,body:JSON.stringify({total:1,list:[{dm:'CL00Y',p:100+directory}]})};}});
 await provider.getQuote('CL00Y.FUT');now+=31000;assert.equal((await provider.getQuote('CL00Y.FUT')).price,102);assert.equal(direct,1);now+=300001;await provider.getQuote('CL00Y.FUT');assert.equal(direct,2);provider.close();
});
test('a rejected out-of-order delayed quote preserves usable status without renewing its timestamps',async()=>{
 let now=START,older=false;const context=createMacroContext({now:()=>now,readQuote:async symbol=>({symbol,src:'same',price:older?99:101,quoteAt:older?START-610000:START-600000,sourceCheckedAt:now,feedDelayMinutes:10,delayed:true})});
 await context.getContext();now+=30001;older=true;const out=await context.getContext(),q=out.factors[1];assert.equal(q.price,101);assert.equal(q.quoteAt,START-600000);assert.equal(q.sourceCheckedAt,START);assert.equal(q.status,'delayed');assert.equal(q.error,null);assert.ok(q.diagnostics.some(d=>d.code==='MACRO_OLD_QUOTE'));
 now+=120000;assert.equal(context.snapshot().factors[1].status,'stale');context.close();
});
