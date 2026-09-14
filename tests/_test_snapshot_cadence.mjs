import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSnapshotService} from '../lib/snapshot-service.js';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

for(const mode of ['success','failure','suppressed']) {
  test('enrichment-only cadence stays honest across '+mode+' refresh',async()=>{
    const originals={setInterval,clearInterval,setTimeout,clearTimeout};
    let tick,time=1788600000000,calls=0,release;
    globalThis.setInterval=fn=>(tick=fn,1);globalThis.clearInterval=()=>{};
    globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
    const quote=()=>({symbol:'^KS11',price:3000+calls,quoteAt:time-86400000,fetchedAt:time,src:'yahoo',pollAfterMs:2000});
    const service=createSnapshotService({now:()=>time,fetchBatch:async()=>{throw new Error('unsupported batch must not run');},enrich:async()=>{
      calls++;
      if(calls>1&&mode==='failure')throw new Error('fixture offline');
      if(calls>1&&mode==='suppressed')return new Promise(resolve=>{release=resolve;});
      return quote();
    }});
    try {
      service.start();service.getCachedQuote('^KS11');tick();await flush();
      const initial=service.getCachedQuote('^KS11');
      assert.equal(initial.checkIntervalMs,60000);
      assert.equal(initial.pollAfterMs,2000,'provider hint remains a separate field');
      time+=46000;tick();await flush();const healthy=service.getCachedQuote('^KS11');
      assert.equal(calls,1,'scheduled enrichment has not become due after46seconds');
      assert.equal(healthy.checkIntervalMs,60000);assert.equal(healthy.stale,undefined);
      assert.equal(healthy.fetchedAt,initial.fetchedAt);assert.equal(healthy.quoteAt,initial.quoteAt);assert.equal(healthy.price,initial.price);
      time+=14000;tick();await flush();const result=service.getCachedQuote('^KS11');
      assert.equal(calls,2);assert.equal(result.checkIntervalMs,60000);
      if(mode==='success') {
        assert.equal(result.fetchedAt,time);assert.equal(result.price,3002);assert.equal(result.stale,undefined);
      }else{
        assert.equal(result.fetchedAt,initial.fetchedAt,'attempts cannot advance successfulchecktime');
        assert.equal(result.quoteAt,initial.quoteAt);assert.equal(result.price,initial.price);
        if(mode==='failure'){assert.equal(result.stale,true);assert.equal(result.staleInfo.reason,'quote unavailable');}
        else {
          time+=61000;service.getCachedQuote('^KS11');tick();await flush();
          const waiting=service.getCachedQuote('^KS11');assert.equal(calls,2,'pendingwork cannot silentlystartreplacementchecks');
          assert.equal(waiting.fetchedAt,initial.fetchedAt);assert.equal(waiting.sourceCheckedAt,undefined);
          assert.equal(time-waiting.fetchedAt,121000,'age remains available to freshnessconsumers while refreshisheld');
        }
      }
    }finally{service.stop();release?.(quote());await flush();Object.assign(globalThis,originals);}
  });
}

test('batch-supported quotes do not inherit the enrichment-only check interval',async()=>{
  const originals={setInterval,clearInterval,setTimeout,clearTimeout};let tick;
  globalThis.setInterval=fn=>(tick=fn,1);globalThis.clearInterval=()=>{};globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
  const service=createSnapshotService({fetchBatch:async()=>({quotes:[{symbol:'QQQ',price:100,quoteAt:1788600000000,pollAfterMs:70000}]}),enrich:async()=>({symbol:'QQQ',price:99,quoteAt:1788590000000})});
  try{service.start();service.getCachedQuote('QQQ');tick();await flush();const q=service.getCachedQuote('QQQ');assert.equal(q.price,100);assert.equal(q.pollAfterMs,70000);assert.equal(q.checkIntervalMs,undefined);}finally{service.stop();Object.assign(globalThis,originals);}
});
