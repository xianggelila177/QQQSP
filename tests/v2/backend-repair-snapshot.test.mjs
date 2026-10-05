import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {providerCapabilities} from '../../lib/instruments.js';
import {quote,fixtureAt,turn} from './backend-repair-fixtures.mjs';

test('snapshot ticks reuse bounded provider groups while still observing live stream/session changes',async t=>{
  let tick,clock=fixtureAt,state='CLOSED',stream=true;
  const calls=[];
  t.mock.method(globalThis,'setInterval',fn=>{tick=fn;return {unref(){}};});
  const service=createSnapshotService({now:()=>clock,env:{POLL_MS:2000},sessionFor:()=>state,streamAvailable:()=>stream,
    fetchBatch:async (symbols,{group})=>{calls.push({symbols,group});return {quotes:symbols.map(s=>quote(s))};}});
  t.after(()=>service.stop());service.start();
  const symbols=['NVDA','TSM','2330.TW','7203.T','005930.KS','0700.HK','^GSPC',...Array.from({length:193},(_,i)=>'SNAP'+i)];
  for(const symbol of symbols)service.getCachedQuote(symbol);
  tick();await turn();assert.equal(calls.length,0);
  const builds=service.diagnostics().groupBuilds;
  for(let i=0;i<10;i++)tick();
  assert.equal(service.diagnostics().groupBuilds-builds,0,'unchanged membership must not repeat symbol-to-provider classification');
  // Stream coverage and market state remain dynamic; caching a group must not
  // cache a due decision or suppress fallback at the next tick.
  stream=false;state='REGULAR';tick();await turn();
  assert.equal(calls.flatMap(c=>c.symbols).length,200);
  for(const call of calls)for(const symbol of call.symbols)assert.equal(call.group,providerCapabilities(symbol).batchGroup);
  const first=calls.length;clock+=2000;tick();await turn();assert.ok(calls.length>first);
  service.retain(['TSM','2330.TW']);const retained=service.diagnostics().groupBuilds;
  service.getCachedQuote('NVDA');tick();await turn();
  assert.equal(service.diagnostics().groupBuilds-retained,1,'removed members release their classification');
  assert.equal(service.diagnostics().active,3);
  service.stop();service.start();service.getCachedQuote('TSM');
  const restarted=service.diagnostics().groupBuilds;tick();await turn();assert.equal(service.diagnostics().groupBuilds-restarted,1);
});
