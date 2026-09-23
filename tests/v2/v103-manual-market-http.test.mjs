import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHttp} from '../../lib/http.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';

test('forced source read publishes a newer quote into the shared snapshot',async t=>{
  let clock=Date.parse('2026-09-23T10:00:00Z'),price=100,calls=0;
  const service=createSnapshotService({now:()=>clock,env:{POLL_MS:1000},sessionFor:()=> 'PRE',
    fetchBatch:async(symbols,{force})=>{
      assert.equal(force,true);calls++;
      return {quotes:symbols.map(symbol=>({symbol,price,currency:'USD',src:'fixture',marketState:'PRE',quoteAt:clock,sourceCheckedAt:clock}))};
    }});
  service.start();t.after(()=>service.stop());
  assert.equal((await service.forceRefresh(['AAOI'])).outcomes.AAOI,'updated');
  assert.equal(service.getCachedQuote('AAOI').price,100);
  clock+=5000;price=101;
  assert.equal((await service.forceRefresh(['AAOI'])).outcomes.AAOI,'updated');
  assert.equal(service.getCachedQuote('AAOI').price,101);
  assert.equal(calls,2);
});

test('manual market endpoint checks origin, triggers one source refresh, and enforces cooldown',async t=>{
  let calls=0;
  const layer=createHttp({forceRefreshQuotes:async symbols=>{
    calls++;
    return {checkedAt:Date.now(),outcomes:{QQQ:'updated'},quotes:symbols.map(symbol=>({symbol,price:100,quoteAt:Date.now(),sourceCheckedAt:Date.now()}))};
  }},{env:{PORT:0,PUBLIC_ORIGIN:'https://qqqsp.example'},monitorCore:false});
  layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
  const url='http://127.0.0.1:'+layer.httpServer.address().port+'/api/market/refresh?symbols=QQQ';
  assert.equal((await fetch(url,{method:'POST'})).status,403);
  const headers={Origin:'https://qqqsp.example','X-QQQSP-Refresh':'1'};
  const first=await fetch(url,{method:'POST',headers});
  assert.equal(first.status,200);
  const payload=await first.json();
  assert.equal(payload.quotes[0].symbol,'QQQ');
  assert.equal(payload.outcomes.QQQ,'updated');
  assert.equal(calls,1);
  const second=await fetch(url,{method:'POST',headers});
  assert.equal(second.status,429);
  assert.equal(calls,1);
});
