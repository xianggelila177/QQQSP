import test from 'node:test';
import assert from 'node:assert/strict';
import {nextMarketTransitionAt,sessionCacheDiagnostics} from '../../lib/session-policy.js';
import {marketStateFor,calendarRegistry} from '../../mkt.mjs';
const at=Date.parse('2026-09-30T14:00:00Z');
for(const size of [128,129,200])test('R1 session cache retains a supported circular working set of '+size,()=>{
 const symbols=Array.from({length:size},(_,i)=>'S'+size+'X'+i);
 const first=symbols.map(s=>nextMarketTransitionAt(s,at));
 const before=sessionCacheDiagnostics().builds;
 assert.deepEqual(symbols.map(s=>nextMarketTransitionAt(s,at)),first);
 assert.equal(sessionCacheDiagnostics().builds-before,0,'warm second scan must not rebuild');
});
test('R1 contexts, half days, DST, calendar revisions and replacement days stay correct and bounded',()=>{
 for(const [symbol,text,venue] of [
  ['SPY','2026-11-27T17:59:00Z',''],['SPY','2026-03-06T23:59:00Z',''],['SPY','2026-11-01T23:59:00Z',''],
  ['^SOX','2026-09-30T13:29:00Z',''],['600000.SS','2026-09-30T03:29:00Z',''],['0700.HK','2026-09-30T03:59:00Z',''],
  ['7203.T','2026-09-30T02:29:00Z',''],['2330.TW','2026-09-30T05:29:00Z',''],['005930.KS','2026-09-30T06:29:00Z',''],
  ['SPY','2026-09-30T13:29:00Z',{venue:'NYSE',instrumentType:'EQUITY'}],['SPY','2026-09-30T13:29:00Z',{venue:'NASDAQ',instrumentType:'ETF'}]]){
  const time=Date.parse(text),transition=nextMarketTransitionAt(symbol,time,venue);
  assert.ok(transition>time);assert.notEqual(marketStateFor(symbol,null,transition-1,venue),marketStateFor(symbol,null,transition,venue));
  const builds=sessionCacheDiagnostics().builds;assert.equal(nextMarketTransitionAt(symbol,time,venue),transition);assert.equal(sessionCacheDiagnostics().builds,builds);
 }
 assert.equal(nextMarketTransitionAt('SPY',Date.parse('2027-01-04T12:00:00Z')),null);
 nextMarketTransitionAt('CLOCK',at);const before=sessionCacheDiagnostics();nextMarketTransitionAt('CLOCK',at+86400000);
 assert.equal(sessionCacheDiagnostics().entries,before.entries);assert.equal(sessionCacheDiagnostics().builds,before.builds+1);
 const version=calendarRegistry.version;
 try{calendarRegistry.version=version+'-test';nextMarketTransitionAt('CLOCK',at+86400000);assert.equal(sessionCacheDiagnostics().builds,before.builds+2);}finally{calendarRegistry.version=version;}
 for(let i=0;i<900;i++)nextMarketTransitionAt('BOUND'+i,at);
 assert.equal(sessionCacheDiagnostics().entries,sessionCacheDiagnostics().maxEntries);
});
