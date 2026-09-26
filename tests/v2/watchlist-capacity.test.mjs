import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter,once} from 'node:events';
import {createHttp} from '../../lib/http.js';
import {parseCv} from '../../lib/http-charts.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createQuoteSamples} from '../../lib/quote-samples.js';
import {createSampleStore} from '../../lib/sample-store.js';
import {createRecoveryStore} from '../../lib/recovery-store.js';
import {createSse} from '../../lib/sse.js';
import {loadConfig} from '../../config.js';
const symbols=Array.from({length:100},(_,i)=>'S'+i),clock=Date.parse('2026-09-17T14:00:00Z');
const quote=symbol=>({symbol,price:100,quoteAt:clock,sourceCheckedAt:clock,src:'fixture',currency:'USD',marketState:'REGULAR',priceSession:'REGULAR'});
const next=()=>new Promise(resolve=>setImmediate(resolve));
const history=()=>({cache:new Map(),exportState:()=>({}),restore(){},prepare:async()=>{throw Object.assign(Error('fixture unavailable'),{code:'UNAVAILABLE'});}});
test('13 and 100 quote/history symbols succeed, 101 and oversized POST remain rejected',async t=>{
 const prewarm=createHistoryPrewarm({history:history(),now:()=>clock});
 const layer=createHttp({getCachedQuote:quote,historyPrewarm:prewarm},{env:{PORT:0},now:()=>clock,monitorCore:false});
 layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());const origin='http://127.0.0.1:'+layer.httpServer.address().port;
 for(const n of [13,100]){const requested=symbols.slice(0,n);const r=await fetch(origin+'/api/market?symbols='+requested.join(','));assert.equal(r.status,200);assert.equal((await r.json()).length,n);
 const save=await fetch(origin+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:requested})});assert.equal(save.status,200);assert.equal((await save.json()).persistentWatchlist.length,n);
 const bundle=await fetch(origin+'/api/history/bundle?symbols='+requested.join(','));assert.equal(bundle.status,200);assert.equal((await bundle.json()).entries.length,n);}
 assert.equal((await fetch(origin+'/api/market?symbols='+[...symbols,'OVER'].join(','))).status,400);
 const post=body=>fetch(origin+'/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post({symbols:[...symbols,'OVER']})).status,400);
 assert.equal((await post({symbols,extra:'x'.repeat(4096)})).status,413);
});
test('browser storage and chart version hints retain all 100 entries',async()=>{
 const context={window:{}};vm.runInNewContext(await fs.readFile(new URL('../../public/modules/panel-state.js',import.meta.url),'utf8'),context);
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const state=context.window.PANEL_STATE.createState(storage);state.saveWatchlist('w',symbols);assert.equal(state.loadWatchlist('w').length,100);
 const cv=symbols.map(s=>s+':123:456').join(';');assert.equal(parseCv(cv).size,100);assert.equal(parseCv(cv+';OVER:123:456').size,0);
});
test('100 durable memberships survive restart; background collection retains more than 50 and accepts replacement',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const statePath=path.join(dir,'history.json');const a=createHistoryPrewarm({history:history(),statePath,now:()=>clock});a.retain(symbols);await a.persist();
 const b=createHistoryPrewarm({history:history(),statePath,now:()=>clock,tickMs:60000});await b.start();assert.equal(b.status().persistentWatchlist.length,100);await b.stop();
 let list=symbols,watched=[];const engine={watch:s=>{watched=s;return()=>{};},read:s=>s.map(quote),subscribe:()=>()=>{}};
 const directory=path.join(dir,'samples'),sampler=createQuoteSamples({engine,getWatchlist:()=>list,directory,now:()=>clock,tickMs:60000});await sampler.start();assert.equal(watched.length,100);assert.equal(sampler.diagnostics().symbols,100);await sampler.stop();
 const store=createSampleStore({directory,now:()=>clock});await store.restore();for(const s of symbols)assert.equal(store.snapshot(s).points.length,1,s);
 assert.equal(store.accept(quote('REPLACEMENT')),true,'removed-symbol retention leaves space for new membership');
});
test('recovery snapshot retains all 100 symbols after restart',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery100-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const filePath=path.join(dir,'quotes.json');
 const a=createRecoveryStore({filePath,now:()=>clock});a.load();for(const s of symbols)a.remember(quote(s));await a.flush();
 const b=createRecoveryStore({filePath,now:()=>clock});b.load();for(const s of symbols)assert.equal(b.get(s)?.price,100,s);
});
test('100 large quote/history snapshots drain without 1 MiB disconnect or missing symbols',async()=>{
 class Response extends EventEmitter{writableLength=0;destroyed=false;frames=[];writeHead(){}flushHeaders(){}end(){this.emit('close');}destroy(){this.destroyed=true;this.emit('close');}write(frame){this.frames.push(frame);this.writableLength+=Buffer.byteLength(frame);setImmediate(()=>{this.writableLength=0;this.emit('drain');});return false;}}
 const bars=Array.from({length:390},(_,i)=>({t:clock/1000+i*60,c:123.456789,o:120,h:124,l:119,v:12345}));
 const engine={read:s=>s.map(symbol=>({...quote(symbol),charts:{intraday:bars}})),watch:()=>()=>{},subscribe:()=>()=>{}};
 const hp={snapshot:s=>({serverNow:clock,entries:s.map(symbol=>({symbol,periods:{daily:{bars}}}))}),lease:()=>()=>{},subscribe:()=>()=>{}};
 const stream=createSse({engine,historyPrewarm:hp,now:()=>clock}),res=new Response();stream.open({method:'GET'},res,symbols,'');
 for(let i=0;i<600;i++)await next();
 const events=res.frames.filter(f=>f.startsWith('event:')).map(f=>JSON.parse(f.split('\ndata: ')[1]));
 assert.equal(res.destroyed,false);assert.equal(new Set(events.flatMap(e=>e.quotes||[]).map(q=>q.symbol)).size,100);assert.equal(new Set(events.flatMap(e=>e.entries||[]).map(q=>q.symbol)).size,100);stream.close();
});
test('capacity configuration supports 100 histories and three full extended-session sample days within bounded budgets',()=>{
 const config=loadConfig();assert.ok(config.HISTORY_MAX_SYMBOLS>=100);assert.ok(config.SAMPLES_MAX_BYTES>=96*1024*1024);assert.throws(()=>loadConfig({SAMPLES_MAX_BYTES:129*1024*1024}));
});
test('worst valid 100-symbol URL preserves ampersands and membership below proxy request-line limit',async()=>{
 const context={window:{}};vm.runInNewContext(await fs.readFile(new URL('../../public/modules/panel-live-store.js',import.meta.url),'utf8'),context);
 const long=Array.from({length:100},(_,i)=>'A&'+String(i).padStart(11,'0')+'.NS');
 const cv=long.map(s=>s+':281474976710655:281474976710655').join(';');
 for(const route of ['/api/stream','/api/market?t=1']){const raw=context.window.PANEL_LIVE_STORE.symbolsUrl(route,long,cv),url=new URL(raw,'https://example.test');assert.ok(raw.length<6500);assert.deepEqual(url.searchParams.get('symbols').split(','),long);assert.equal(url.searchParams.has('cv'),false);}
});
test('100-history warming prepares every symbol without automatic wide expansion',async()=>{
 let time=clock;const expanded=new Set(),prepared=new Set();const periods=Object.fromEntries(['daily','weekly','monthly','yearly'].map(period=>[period,{period,revision:'1',bars:[]}]));
 const h={...history(),prepare:async(s,{tier})=>{prepared.add(s);if(tier==='long')expanded.add(s);return periods;}};
 const worker=createHistoryPrewarm({history:h,now:()=>time,tickMs:600000,expandAfterMs:0});worker.retain(symbols);await worker.start();await worker.settled();
 try{for(let i=0;i<350;i++){time+=1000;await worker.runDue();}assert.equal(prepared.size,100);assert.equal(expanded.size,0);}finally{await worker.stop();}
});
test('news batches preserve the existing 12-symbol admission and serial upstream demand',async()=>{
 const context={window:{PANEL_FORMAT:{}}};vm.runInNewContext(await fs.readFile(new URL('../../public/modules/panel-news-controller.js',import.meta.url),'utf8'),context);
 const calls=[];let active=0,peak=0;
 const controller=context.window.PANEL_NEWS_CONTROLLER.createNewsController({network:{request:async(_,url)=>{peak=Math.max(peak,++active);const list=new URL(url,'https://example.test').searchParams.get('symbols').split(',');calls.push(list);await next();active--;return {ok:true,json:async()=>Object.fromEntries(list.map(s=>[s,[]])),headers:{}};}},client:{decodeNewsMetadata:()=>({})},getWatchlist:()=>symbols,getCards:()=>[]});
 assert.equal(await controller.refreshNews(),true);assert.equal(peak,1);assert.ok(calls.every(batch=>batch.length<=12));assert.deepEqual(calls.flat(),symbols);
});
test('retired sample reserve is bounded and cannot block replacement active symbols',()=>{
 const store=createSampleStore({now:()=>clock,maxSymbols:3});store.retain(['S0','S1']);store.accept(quote('S0'));store.accept(quote('S1'));
 store.retain(['S1','S2']);assert.equal(store.accept(quote('S2')),true);assert.equal(store.snapshot('S0').points.length,1);
 store.retain(['S1','S3']);assert.equal(store.accept(quote('S3')),true);assert.equal(store.snapshot('S1').points.length,1);assert.equal(store.snapshot('S3').points.length,1);
 assert.equal(store.diagnostics().symbols,3);assert.equal(store.diagnostics().retiredEvicted,1);assert.match(store.snapshot('S0').capacityError,/提前清理/);
});
test('real HTTP streams deliver all 100 large snapshots on cold connect and reconnect',async t=>{
 const bars=Array.from({length:390},(_,i)=>({t:clock/1000+i*60,c:123.456789,o:120,h:124,l:119,v:12345}));
 let watched=0;const engine={read:list=>list.map(symbol=>({...quote(symbol),charts:{intraday:bars}})),watch:list=>{watched+=list.length;return()=>{watched-=list.length;};},subscribe:()=>()=>{},diagnostics:()=>({active:[]})};
 const hp={snapshot:list=>({serverNow:clock,entries:list.map(symbol=>({symbol,periods:{daily:{bars}}}))}),lease:()=>()=>{},subscribe:()=>()=>{}};
 const layer=createHttp({engine,historyPrewarm:hp,getCachedQuote:quote},{env:{PORT:0},now:()=>clock,monitorCore:false});layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
 for(let round=0;round<2;round++){
   const controller=new AbortController(),url='http://127.0.0.1:'+layer.httpServer.address().port+'/api/stream?symbols='+symbols.join(',');
   const response=await fetch(url,{signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader(),quotes=new Set(),histories=new Set();let carry='';
   try{while(quotes.size<100||histories.size<100){const part=await reader.read();assert.equal(part.done,false);carry+=new TextDecoder().decode(part.value);let end;while((end=carry.indexOf('\n\n'))>=0){const frame=carry.slice(0,end);carry=carry.slice(end+2);if(!frame.startsWith('event:'))continue;const value=JSON.parse(frame.split('\ndata: ')[1]);for(const q of value.quotes||[])quotes.add(q.symbol);for(const e of value.entries||[])histories.add(e.symbol);}}
     assert.equal(watched,100);assert.equal(layer.diagnostics().streams.slowClosed,0);
   }finally{controller.abort();await reader.cancel().catch(()=>{});}
   for(let wait=0;wait<20&&watched;wait++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(watched,0);
 }
});
