import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRecoveryStore} from '../lib/recovery-store.js';
import {createRedundancy} from '../lib/redundancy.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-history-retain-'));
let now=Date.now();const originalAt=now-60000;
const prior={symbol:'QQQ',price:100,currency:'USD',quoteAt:originalAt,fetchedAt:originalAt,src:'yahoo',charts:{intraday:[{t:originalAt/1000,c:100,v:5}],daily30:[{t:originalAt/1000,c:99}]},slowFields:{intraday:{source:'yahoo',updatedAt:originalAt,stale:false},daily30:{source:'yahoo',updatedAt:originalAt,stale:false}}};
const fx={getFxRates:async()=>({USD:7}),fxMetadata:()=>({fxStale:false,fxSource:'fixture',fxAsOf:now}),fxFallbackRates:()=>({USD:7})};
let app;
try{
 const filePath=path.join(dir,'last-good.json');const seed=createRecoveryStore({filePath,now:()=>now});seed.load();seed.remember(prior);await seed.flush();
 const recovery=createRecoveryStore({filePath,now:()=>now});
 let mode='partial';const complete=[{t:now/1000,c:120,v:20}];
 app=createRedundancy({recovery,fx,now:()=>now,getQuote:async symbol=>({symbol,price:120,currency:'USD',quoteAt:now,fetchedAt:now,src:mode==='partial'?'naver-us':'yahoo',charts:{intraday:mode==='partial'?[]:complete,daily30:[{t:now/1000,c:119}]},slowFields:{intraday:{source:'yahoo',updatedAt:mode==='partial'?null:now,stale:mode==='partial'}}})});
 const partial=await app.getCachedQuote('QQQ');
 assert.equal(partial.price,120,'fast price must never roll back to history quote');
 assert.deepEqual(partial.charts.intraday,prior.charts.intraday,'cached intraday retained independently');
 assert.equal(partial.charts.daily30[0].c,119,'fresh available family wins');
 assert.equal(partial.slowFields.intraday.stale,true);assert.equal(partial.slowFields.intraday.updatedAt,originalAt);
 assert.notEqual(partial.recovery,true,'only history is recovered, not whole quote');
 await app.stop();
 const persisted=createRecoveryStore({filePath,now:()=>now});assert.equal(persisted.load(),true);assert.equal(persisted.get('QQQ').charts.intraday.length,1,'partial quote cannot erase last-good history on disk');
 mode='full';now+=31000;app.start();
 const full=await app.getCachedQuote('QQQ');assert.deepEqual(full.charts.intraday,complete);assert.equal(full.slowFields.intraday.stale,false);
 await app.stop();
 console.log('PASS partial cold-start retains history independently, persists it, and replaces it on recovery');
}finally{await app?.stop();await fs.rm(dir,{recursive:true,force:true});}

const extraDir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-retain-contract-'));
try {
 for(const [name,bars,metadata] of [
  ['malformed',[{t:'bad',c:null}],{source:'primary',updatedAt:now,stale:false}],
  ['terminal',[],{source:'primary',updatedAt:now,status:'no-history',retryable:false,stale:false}],
  ['retry',[],{source:'primary',updatedAt:now,status:'failed',retryable:true,retryAt:now+120000,error:'rate limited',stale:true}],
 ]) {
  const filePath=path.join(extraDir,name+'.json');
  const seed=createRecoveryStore({filePath,now:()=>now});seed.load();seed.remember(prior);await seed.flush();
  const persistence=createRecoveryStore({filePath,now:()=>now});
  const current=createRedundancy({recovery:persistence,fx,now:()=>now,getQuote:async()=>({...prior,price:120,quoteAt:now,fetchedAt:now,charts:{intraday:bars,daily30:prior.charts.daily30},slowFields:{intraday:metadata}})});
  try {
   const result=await current.getCachedQuote('QQQ');
   assert.equal(result.price,120);assert.deepEqual(result.charts.intraday,prior.charts.intraday,name);
   assert.equal(result.slowFields.intraday.updatedAt,originalAt);assert.equal(result.slowFields.intraday.source,'yahoo');assert.equal(result.slowFields.intraday.stale,true);
   if(name==='terminal'){assert.equal(result.slowFields.intraday.status,'no-history');assert.equal(result.slowFields.intraday.retryable,false);assert.equal(result.slowFields.intraday.error,undefined);}
   if(name==='retry'){assert.equal(result.slowFields.intraday.retryAt,metadata.retryAt);assert.equal(result.slowFields.intraday.error,'rate limited');assert.equal(result.slowFields.intraday.status,'failed');}
  }finally{await current.stop();}
  const reload=createRecoveryStore({filePath,now:()=>now});reload.load();assert.equal(reload.get('QQQ').charts.intraday.length,1,name+' persists usable history');
 }
 console.log('PASS malformed-family backup protection and terminal/retry metadata preservation');
}finally{await fs.rm(extraDir,{recursive:true,force:true});}
