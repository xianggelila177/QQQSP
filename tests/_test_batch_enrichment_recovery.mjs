import assert from 'node:assert/strict';
import {providerCapabilities,tencentCodeFor} from '../lib/instruments.js';
import {createSnapshotService} from '../lib/snapshot-service.js';

const routing=()=>{
  for(const symbol of ['^DJI','^IXIC','^FTSE']){
    assert.equal(tencentCodeFor(symbol),null,symbol);
    assert.equal(providerCapabilities(symbol).batchGroup,null,symbol);
  }
  assert.equal(tencentCodeFor('^GSPC'),null);
  assert.equal(providerCapabilities('^GSPC').batchGroup,'index');
  assert.deepEqual(providerCapabilities('^GSPC').batchProviders,['naver-index']);
  assert.equal(tencentCodeFor('000300.SS'),'sh000300');
  assert.equal(providerCapabilities('000300.SS').batchGroup,'other');
  for(const symbol of ['AAPL','QQQ','SPY'])assert.equal(providerCapabilities(symbol).batchGroup,'us');
};
const originals={setTimeout,clearTimeout,setInterval,clearInterval},timers=new Map();let id=0;
globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms,once:true});return id;};
globalThis.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};
globalThis.clearTimeout=globalThis.clearInterval=key=>timers.delete(key);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const fire=async ms=>{for(const [key,t] of [...timers])if(t.ms===ms){if(t.once)timers.delete(key);t.fn();}await flush();};
async function scenario(mode){
  let now=1788840000000,phase=0,resolveEnrich;
  const q=(price,at=now)=>({symbol:'AAPL',price,quoteAt:at,currency:'USD',src:'fixture'});
  const svc=createSnapshotService({now:()=>now,sessionFor:()=> 'REGULAR',fetchBatch:async()=>{
    if(phase===0||mode==='fresh')return {quotes:[q(200)],pollAfterMs:2000};
    if(mode==='throw')throw new Error('provider unavailable');
    return {quotes:[],pollAfterMs:mode==='cooldown'?120000:2000};
  },enrich:()=>new Promise(resolve=>{resolveEnrich=resolve;})});
  try{
    svc.start();svc.getCachedQuote('AAPL');await fire(100);
    const originalTime=now;phase=1;now+=2000;await fire(2000);
    const old=mode==='older';resolveEnrich(q(100,old?originalTime-1:now));await flush();
    if(mode==='fresh')assert.equal(svc.getCachedQuote('AAPL').price,200,'fresh batch protected');
    else if(old){assert.equal(svc.getCachedQuote('AAPL').price,200);assert.equal(svc.getCachedQuote('AAPL').stale,true,'older Yahoo cannot roll price back');}
    else{
      assert.equal(svc.getCachedQuote('AAPL').price,100,'successful Yahoo replaces failed batch');
      assert.ok(!svc.getCachedQuote('AAPL').stale,'fallback fresh');
      now+=10000;await fire(2000);
      assert.ok(!svc.getCachedQuote('AAPL').stale,'repeated batch failure preserves current Yahoo fallback');
      now+=60001;
      if(mode!=='cooldown')await fire(2000);
      assert.equal(svc.getCachedQuote('AAPL').stale,true,'expired Yahoo fallback cannot hide outage');
      svc.stop();resolveEnrich(q(999,now));await flush();
      assert.notEqual(svc.getCachedQuote('AAPL').price,999,'stopped enrichment cannot revive snapshot');
    }
  }finally{svc.stop();}
}
try{
  if(process.argv.includes('--routing'))routing();
  else{for(const mode of ['missing','throw','fresh','older','cooldown'])await scenario(mode);routing();}
}finally{Object.assign(globalThis,originals);}
console.log('PASS verified index routing and bounded fresh Yahoo fallback for failed batches');
