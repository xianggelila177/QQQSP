// Reproductions of the v2.5 screenshot: run this unchanged against 2.5 first.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import {createTransport} from '../../lib/transport.js';
import {createMacroQuoteReader,parseSinaMacro} from '../../lib/providers/macro-quotes.js';
import {createMacroContext} from '../../lib/macro-context.js';
const START=Date.parse('2026-09-11T13:39:00Z');
const failure=()=>{throw Object.assign(new Error('unavailable'),{code:'EAI_AGAIN'});};
const sina='var hq_str_hf_CL="99.16,0,99,100,100,98,21:39:00,98,98,200,0,0,2026-09-11,WTI原油,0";var hq_str_hf_OIL="104.3,0,104,105,106,100,21:39:00,102,103,300,0,0,2026-09-11,布伦特原油,0";var hq_str_DINIW="21:39:00,98.4,98.4,98.5,0,98.6,99,98,98.6,美元指数,2026-09-11";';
const response=body=>({status:200,headers:{},body});

test('R26-01: transport decodes gzip before provider text parsing',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Encoding':'gzip'});res.end(gzipSync(sina));});server.listen(0,'127.0.0.1');await once(server,'listening');
 const tr=createTransport({log:{warn(){},debug(){}}});t.after(async()=>{await tr.close();await new Promise(r=>server.close(r));});
 const r=await tr.httpsGet('http://127.0.0.1:'+server.address().port);assert.equal(parseSinaMacro(r.body,START).size,3,'compressed successful response must not become an empty batch');
});
test('R26-02: Sina macro uses the canonical query-list endpoint',async t=>{
 const reader=createMacroQuoteReader({now:()=>START,futures:{getQuote:failure},fetchChart:failure,httpsGet:async url=>{const u=new URL(url);return u.hostname==='hq.sinajs.cn'&&u.searchParams.get('list')?.includes('DINIW')?response(sina):{status:404,headers:{},body:''};}});t.after(()=>reader.close());
 assert.equal((await reader.readQuote('DX-Y.NYB')).price,98.4);
});
test('R26-03: all realtime routes failing can expose named daily references, not blank or fake futures',async t=>{
 const ids={DCOILBRENTEU:109.51,DTWEXBGS:118.0732,DGS10:4.83,DCOILWTICO:99.16};
 const reader=createMacroQuoteReader({now:()=>START,futures:{getQuote:failure},fetchChart:failure,httpsGet:async url=>{const u=new URL(url);if(u.hostname==='fred.stlouisfed.org'){const names=u.searchParams.get('id').split(',');return response('observation_date,'+names.join(',')+'\n2026-09-09,'+names.map(k=>ids[k]).join(',')+'\n');}throw Object.assign(new Error('DNS failed'),{code:'EAI_AGAIN'});}});t.after(()=>reader.close());
 const q=await reader.readQuote('BZ=F');assert.equal(q.daily,true);assert.equal(q.symbol,'DCOILBRENTEU');assert.equal(q.quoteAt,null);assert.match(q.displayName,/现货.*日度/);
 const d=await reader.readQuote('DX-Y.NYB');assert.equal(d.symbol,'DTWEXBGS');assert.equal(d.daily,true);assert.match(d.displayName,/广义/);assert.match(d.feedCoverage,/DXY/);
});
test('R26-04: a daily fallback is not pinned ahead of a recovered intraday source',async t=>{
 let clock=START,available=false;
 const reader=createMacroQuoteReader({now:()=>clock,futures:{getQuote:failure},fetchChart:async symbol=>{if(!available)failure();return {meta:{symbol,instrumentType:'INDEX',regularMarketPrice:4.9,regularMarketTime:clock/1000}};},httpsGet:async url=>url.includes('bond.finance.sina')?response(JSON.stringify({result:{data:[['2026-09-10',4,5,4,4.9499,0]]}})):{status:503,headers:{},body:''}});t.after(()=>reader.close());
 assert.equal((await reader.readQuote('^TNX')).daily,true);clock+=61000;available=true;
 const q=await reader.readQuote('^TNX');assert.equal(q.symbol,'^TNX','primary recovery must not wait for the daily cache TTL/preferred lock');assert.notEqual(q.daily,true);
});
test('R26-05: factor cadence uses request start instead of adding network delay to 30 seconds',async()=>{
 let clock=START,count=0;
 const service=createMacroContext({now:()=>clock,readQuote:async symbol=>{count++;await Promise.resolve();clock=START+2000;return {symbol,price:100,quoteAt:null,sourceCheckedAt:clock,pollAfterMs:30000};}});
 await service.getContext();assert.equal(count,5);clock=START+30000;await service.getContext();assert.equal(count,10);service.close();
});
test('R26-06: publish a ready factor while another provider is still pending',async()=>{
 let finish;const wait=new Promise(r=>finish=r);const published=[];
 const service=createMacroContext({now:()=>START,readQuote:async symbol=>{if(symbol==='^TNX')await wait;return {symbol,price:100,quoteAt:START,sourceCheckedAt:START};}});
 const off=service.subscribe?.(s=>published.push(s));const loading=service.getContext();await new Promise(r=>setTimeout(r,10));
 const partial=published.some(s=>s.factors.filter(f=>f.price!==null).length>=3&&s.factors.some(f=>f.id==='rates'&&f.price===null));finish();await loading;off?.();service.close();assert.ok(partial,'one slow factor must not block usable factor delivery');
});
test('R26-07: a fresh observation window can compare event-timestamped and untimestamped feeds without relabelling event time',async()=>{
 let clock=START;
 const service=createMacroContext({now:()=>clock,readQuote:async symbol=>({symbol,price:symbol==='CL00Y.FUT'?100-(clock-START)/60000:100+(clock-START)/60000,quoteAt:symbol==='CL00Y.FUT'?clock:null,sourceCheckedAt:clock,src:'fixture'})});
 await service.getContext();clock+=30000;await service.getContext();clock+=30000;const out=await service.getContext();service.close();
 assert.equal(out.comparison,'observations');assert.equal(out.comparisonBasis,'observation');assert.equal(out.factors.find(f=>f.id==='nq').quoteAt,null);assert.match(out.observations.join(' '),/不是成交时间/);
});
test('R26-08: diagnostics survive a total failure even with no previous successful quote',async()=>{
 const diagnostics=[{source:'sina:OIL',status:'error',code:'EAI_AGAIN',retryAt:START+60000}];
 const service=createMacroContext({now:()=>START,readQuote:async()=>{throw Object.assign(new Error('all candidates failed'),{diagnostics,retryAt:START+60000});}});
 const out=await service.getContext();service.close();assert.equal(out.factors[2].diagnostics[0]?.code,'EAI_AGAIN');
});
test('R26-09: unavailable factor never says wait-for-window in frontend',()=>{
 const elements={macroCalendar:{},macroObservation:{}};const root={},status={};const s={window:{PANEL_FORMAT:{esc:String,fmtTime8:String}},URL,Date};
 vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-macro-context.js',import.meta.url),'utf8'),s);
 const ui=s.window.PANEL_MACRO_CONTEXT.createMacroContext({document:{getElementById:k=>elements[k]},root,status,network:{},isOpen:()=>true});
 root.innerHTML=ui.renderFactor({name:'布伦特原油',symbol:'BZ=F',unit:'美元/桶',price:null,status:'error',error:'DNS',nextCheckAt:START+60000,diagnostics:[]});
 assert.doesNotMatch(root.innerHTML,/等待同窗数据/);assert.match(root.innerHTML,/重试|请求失败|来源暂不可用/);
});
test('R26-10: a lower-quality stale result must not overwrite the last good observation',async()=>{
 let clock=START,stale=false;
 const service=createMacroContext({now:()=>clock,readQuote:async symbol=>({symbol,price:stale?99:101,sourceCheckedAt:stale?START-3600000:clock,quoteAt:null,stale,src:'same'})});
 await service.getContext();clock+=30000;stale=true;const out=await service.getContext();service.close();assert.equal(out.factors[0].price,101,'do not regress to the stale upstream cache');
});
test('R26-11: UTF-8 returned through latin1 transport must not silently remove the dollar index',()=>{
 const bytes=Buffer.from(sina,'utf8').toString('latin1');assert.equal(parseSinaMacro(bytes,START).get('DINIW')?.price,98.4);
});
