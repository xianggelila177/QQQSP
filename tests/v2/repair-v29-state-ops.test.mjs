import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createRecoveryStore} from '../../lib/recovery-store.js';
import {createRedundancy} from '../../lib/redundancy.js';
import {createBoundedWriter} from '../../lib/bounded-writer.js';
import {atomicWriteFile} from '../../lib/atomic-file.js';
import {pruneReleases} from '../../ops/prune-releases.mjs';
import {loadConfig} from '../../config.js';
import {UPSTREAM_ROLES} from '../../lib/source-registry.js';
import {dailyData,fixtureNow} from './history-v28-fixture.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp29-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const history=()=>createHistoryService({now:()=>fixtureNow,fetchChart:async s=>dailyData(s)});
function quote(symbol='NVDA') {return {symbol,currency:'USD',price:110,quoteAt:fixtureNow,sourceCheckedAt:fixtureNow,fetchedAt:fixtureNow,src:'test',charts:{intraday:[{t:fixtureNow/1000-60,o:109,h:111,l:108,c:110,v:1}],daily30:[{t:fixtureNow/1000-86400,o:109,h:111,l:108,c:110,v:1}]}};}
test('R05 corrupted checkpoint metadata skips only the bad entry without TypeError',async()=>{
 const source=history();await source.prepare('NVDA');await source.prepare('MRVL');const valid=source.exportState();source.close();
 const changes=[m=>m.from=null,m=>m.through='2026-02-30',m=>m.fullCheckedAt=null,m=>m.warnings={},m=>m.warnings=[null],m=>m.sourceEvents=[],m=>m.sourceEvents={splits:{bad:null}},m=>m.originReached='yes',m=>m.identity.exchangeTimeZone=null];
 for(const change of changes){const state=structuredClone(valid);change(state.entries[0].meta);const restored=history();restored.restore(state);assert.equal(restored.cache.has('NVDA'),false);assert.equal(restored.cache.has('MRVL'),true);assert.ok((await restored.get('MRVL','daily',{cacheOnly:true})).bars.length);assert.equal(restored.diagnostics().restoreSkipped.total,1);restored.close();}
 const old=history();old.restore({schemaVersion:0,entries:valid.entries});assert.equal(old.cache.size,0);assert.equal(old.diagnostics().restoreSkipped.reasons.schema,1);old.close();
});
test('R06 recovery creates its own nested directory, atomically persists 0600 and restarts',async t=>{
 const dir=await temp(t),file=path.join(dir,'new','nested','quotes.json');const store=createRecoveryStore({filePath:file,now:()=>fixtureNow});store.load();assert.equal(store.remember(quote()),true);assert.equal(await store.flush(),true);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const reloaded=createRecoveryStore({filePath:file,now:()=>fixtureNow+1000});reloaded.load();assert.equal(reloaded.get('NVDA').price,110);
});
test('R06 recovery and shared atomic writer refuse symlink targets without modifying their referent',async t=>{
 const dir=await temp(t),target=path.join(dir,'protected'),link=path.join(dir,'link');await fs.writeFile(target,'sentinel');await fs.symlink(target,link);
 const store=createRecoveryStore({filePath:link,now:()=>fixtureNow});store.load();store.remember(quote());assert.equal(await store.flush(),false);await assert.rejects(atomicWriteFile(link,'wrong'));assert.equal(await fs.readFile(target,'utf8'),'sentinel');
});
test('R09 immutable recovery bars retain identity while caller metadata remains independent',async t=>{
 const file=path.join(await temp(t),'quotes.json'),store=createRecoveryStore({filePath:file,now:()=>fixtureNow});store.load();store.remember(quote());const a=store.get('NVDA'),b=store.get('NVDA');assert.notEqual(a,b);assert.equal(a.charts.daily30,b.charts.daily30);assert.ok(Object.isFrozen(a.charts.daily30[0]));assert.throws(()=>a.charts.daily30[0].c=1,TypeError);a.price=1;assert.equal(store.get('NVDA').price,110);
});
test('R09 a healthy quote never materializes a recovery fallback',async()=>{
 let reads=0;const recovery={enabled:false,load(){},flush:async()=>true,get(){reads++;return quote();},has:()=>true,needsHistory:()=>false,diagnostics:()=>({})};
 const fx={getFxRates:async()=>({}),fxSnapshotFor:()=>({rates:{USD:7},fxStale:false}),fxMetadata:()=>({})};const service=createRedundancy({getQuote:async()=>quote(),recovery,fx,now:()=>fixtureNow});
 for(let n=0;n<25;n++)assert.equal((await service.getCachedQuote('NVDA')).price,110);assert.equal(reads,0);await service.stop();
});
test('R10 near-term preparation precedes idle long-range expansion for every subscribed security',async()=>{
 let clock=fixtureNow;const calls=[];const h={cache:new Map(),exportState:()=>({schemaVersion:1,entries:[]}),prepare:async(symbol,options)=>{calls.push([symbol,options.tier]);return {};}};
 const worker=createHistoryPrewarm({history:h,now:()=>clock,tickMs:600000,expandAfterMs:5000});worker.retain(['NVDA','MRVL']);await worker.start();await worker.settled();await worker.runDue();assert.deepEqual(calls,[['NVDA','near'],['MRVL','near']]);clock+=5001;await worker.runDue();await worker.runDue();assert.deepEqual(calls.slice(2),[['NVDA','long'],['MRVL','long']]);await worker.stop();
});
test('R11 durable symbols and independent live-owner leases are merged, bounded and released independently',()=>{
 const h={cache:new Map(),exportState:()=>({schemaVersion:1,entries:[]})};const worker=createHistoryPrewarm({history:h,maxSymbols:3});worker.retain(['QQQ','SPY']);const a=worker.lease('phone',['AAPL']),b=worker.lease('desktop',['NVDA']);assert.deepEqual(worker.status().watchlist,['QQQ','SPY','AAPL']);assert.deepEqual(worker.status().overflow,['NVDA']);a();assert.deepEqual(worker.status().watchlist,['QQQ','SPY','NVDA']);b();assert.equal(worker.status().owners,0);assert.deepEqual(worker.status().persistentWatchlist,['QQQ','SPY']);worker.retain([]);assert.deepEqual(worker.status().watchlist,[]);
});
test('R14 registered health roles include both default Sina hosts',()=>{assert.ok(UPSTREAM_ROLES['hq.sinajs.cn']);assert.ok(UPSTREAM_ROLES['quotes.sina.cn']);assert.equal(Object.keys(UPSTREAM_ROLES).length,new Set(Object.keys(UPSTREAM_ROLES)).size);});
test('R15 accepted configuration preserves deadlines, enrichment and disk path, rejecting invalid budgets',()=>{
 const cfg=loadConfig({HTTP_SEARCH_DEADLINE_MS:'1234',HTTP_REQUEST_DEADLINE_MS:'2345',ENRICH_OPEN_MS:'12345',DISK_PATH:'/tmp',HTTP_QUEUE_MAX:'0'});assert.equal(cfg.HTTP_SEARCH_DEADLINE_MS,1234);assert.equal(cfg.HTTP_REQUEST_DEADLINE_MS,2345);assert.equal(cfg.ENRICH_OPEN_MS,12345);assert.equal(cfg.DISK_PATH,'/tmp');assert.equal(cfg.HTTP_QUEUE_MAX,0);assert.throws(()=>loadConfig({CACHE_BUDGET_BYTES:'1048576'}));
});
test('R17 a deliberately slow log sink has a hard byte bound and drains after pressure ends',async()=>{
 let release;const held=new Promise(r=>release=r),written=[];const writer=createBoundedWriter(async text=>{await held;written.push(text);},{maxBytes:64});for(let i=0;i<1000;i++)writer.enqueue('12345678');const during=writer.diagnostics();assert.equal(during.bytes,64);assert.equal(during.dropped,992);assert.equal(during.active,true);release();await writer.idle();assert.equal(written.length,8);assert.equal(writer.diagnostics().bytes,0);
});
test('R17 sink errors are counted without preventing later queued records from draining',async()=>{let n=0;const writer=createBoundedWriter(async()=>{if(++n===1)throw Error('slow disk failed');});writer.enqueue('first');writer.enqueue('next');await writer.idle();assert.equal(writer.diagnostics().errors,1);assert.equal(writer.diagnostics().written,1);});
test('R18 release retention protects current/previous and shared data under count and disk pressure',async t=>{
 const root=await temp(t);await fs.mkdir(path.join(root,'releases'));await fs.mkdir(path.join(root,'shared'));await fs.writeFile(path.join(root,'shared','state'),'keep');
 for(let i=0;i<8;i++){const dir=path.join(root,'releases','v'+i);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'app'),Buffer.alloc(100));await fs.symlink(path.join(root,'shared'),path.join(dir,'state'));await fs.utimes(dir,1000+i,1000+i);}
 await fs.symlink('releases/v7',path.join(root,'current'));await fs.symlink('releases/v6',path.join(root,'previous'));
 const out=await pruneReleases(root,{keepOld:2,maxBytes:350});assert.equal(out.kept.length,3);assert.equal(out.removed.length,5);assert.equal(await fs.readFile(path.join(root,'shared','state'),'utf8'),'keep');await fs.stat(path.join(root,'previous','app'));
 const tight=await pruneReleases(root,{keepOld:0,maxBytes:100});assert.equal(tight.kept.length,2);assert.equal(tight.budgetExceeded,true);assert.deepEqual((await fs.readdir(path.join(root,'releases'))).sort(),['v6','v7']);
});
test('R18 retention refuses an anchor outside its owned release directory',async t=>{const root=await temp(t);await fs.mkdir(path.join(root,'releases'));await fs.mkdir(path.join(root,'outside'));await fs.symlink('outside',path.join(root,'current'));await assert.rejects(pruneReleases(root),/owned release/);});
