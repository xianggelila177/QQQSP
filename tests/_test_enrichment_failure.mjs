import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSnapshotService} from '../lib/snapshot-service.js';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
for(const [name,failure] of [
  ['rejection',()=>{throw new Error('fixture offline');}],
  ['unusable response',()=>({symbol:'QQQ',price:null,error:'provider unavailable'})],
  ['empty response',()=>null],
  ['stale provider cache',()=>({symbol:'QQQ',price:100,quoteAt:900000,stale:true})],
  ['identity mismatch',()=>({symbol:'SPY',price:999,quoteAt:2000000})],
]) {
  test('failed '+name+' marks retained slow fields stale without degrading a healthy batch price',async()=>{
    const originals={setInterval,clearInterval,setTimeout,clearTimeout};let tick,time=1000000,phase=0;
    globalThis.setInterval=fn=>(tick=fn,1);globalThis.clearInterval=()=>{};
    globalThis.setTimeout=()=>2;globalThis.clearTimeout=()=>{};
    const metadata=(updatedAt=time)=>({source:'yahoo',updatedAt,stale:false});
    const svc=createSnapshotService({now:()=>time,fetchBatch:async()=>({quotes:[{symbol:'QQQ',price:200+phase,quoteAt:time,priceSession:'POST',src:'naver-us'}]}),enrich:async()=>{
      if(phase===1)return failure();
      return {symbol:'QQQ',price:100,quoteAt:time-60000,src:'yahoo',fetchedAt:time,week52High:250,week52Low:80,
        charts:{intraday:[{t:1,c:100}],daily30:[{t:1,c:100}]},fxMap:{USD:7},fxAsOf:time-1000,fxStale:false,currency2cny:7,
        slowFields:{charts:metadata(),daily30:metadata(),intraday:metadata(),week52Range:metadata(),fx:metadata(time-1000)}};
    }});
    try {
      svc.start();svc.getCachedQuote('QQQ');tick();await flush();
      const successful=svc.getCachedQuote('QQQ');
      phase=1;time+=61000;svc.getCachedQuote('QQQ');tick();await flush();
      const failed=svc.getCachedQuote('QQQ');
      assert.equal(failed.price,201);assert.equal(failed.quoteAt,time);assert.equal(failed.priceSession,'POST');
      assert.equal(failed.stale,undefined);assert.equal(failed.staleInfo,undefined);
      assert.equal(failed.charts,successful.charts);assert.equal(failed.fxMap,successful.fxMap);
      assert.equal(failed.fxAsOf,successful.fxAsOf);assert.equal(failed.currency2cny,7);
      assert.equal(failed.week52High,250);assert.equal(failed.week52Low,80);
      for(const key of ['charts','daily30','intraday','week52Range','fx']) {
        assert.equal(failed.slowFields[key].stale,true,key+' freshness');
        assert.ok(failed.slowFields[key].error,key+' error');
        assert.equal(failed.slowFields[key].updatedAt,successful.slowFields[key].updatedAt,key+' successful timestamp');
        assert.equal(failed.slowFields[key].source,'yahoo');
        assert.equal(successful.slowFields[key].stale,false,'previously returned metadata is immutable by convention');
      }
      assert.equal(failed.fxStale,true);
      phase=2;time+=61000;svc.getCachedQuote('QQQ');tick();await flush();
      const recovered=svc.getCachedQuote('QQQ');assert.equal(recovered.price,202);assert.equal(recovered.fxStale,false);
      for(const key of ['charts','daily30','intraday','week52Range','fx']) {
        assert.equal(recovered.slowFields[key].stale,false,key+' recovered freshness');
        assert.equal(recovered.slowFields[key].error,undefined,key+' recovered error');
        assert.equal(recovered.slowFields[key].updatedAt,key==='fx'?time-1000:time,key+' recovered successful timestamp');
      }
    }finally{svc.stop();Object.assign(globalThis,originals);}
  });
}
