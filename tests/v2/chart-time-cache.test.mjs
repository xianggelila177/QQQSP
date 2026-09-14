import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecoveryStore} from '../../lib/recovery-store.js';
const now=Date.parse('2026-09-11T14:16:12Z');
async function roundtrip(t,source,contract){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-time-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'quotes.json');
 const store=createRecoveryStore({filePath:file,now:()=>now});
 store.load();store.remember({symbol:'LITE',price:928.34,quoteAt:now,ts:now,src:'tx-batch',currency:'USD',
  charts:{intraday:[{t:now/1000-14400,c:927,v:null}],daily30:[{t:now/1000-86400,o:920,h:935,l:919,c:928,v:100}]},
  slowFields:{intraday:{source,updatedAt:now,stale:false,...(contract?{timeContract:contract,timeBasis:'source-label',timeZone:'America/New_York'}:{})}}});
 await store.flush();const restored=createRecoveryStore({filePath:file,now:()=>now});restored.load();return restored.get('LITE');
}
test('REGRESSION old Nasdaq recovered line is invalidated without deleting prices or daily candles',async t=>{
 const q=await roundtrip(t,'nasdaq-intraday');assert.ok(q);assert.equal(q.price,928.34);assert.equal(q.charts.daily30.length,1);
 assert.equal(q.charts.intraday.length,0);assert.match(q.slowFields.intraday.error,/时间/);
});
test('CONTROL newly normalized Nasdaq chart can be recovered after restart',async t=>{
 const q=await roundtrip(t,'nasdaq-intraday','nasdaq-label-et-v2');assert.equal(q.charts.intraday.length,1);assert.equal(q.slowFields.intraday.timeContract,'nasdaq-label-et-v2');
});
test('CONTROL Yahoo/other epoch history is not shifted or deleted on upgrade',async t=>{
 const q=await roundtrip(t,'yahoo');assert.equal(q.charts.intraday.length,1);assert.equal(q.charts.intraday[0].t,now/1000-14400);
});

// Deployment diagnosis must not demand equality of a minute bar and a quote.
test('deployment time diagnostics separate legitimate stale history from a timezone contract failure',async()=>{
 const {describeChartTime}=await import('../../ops/chart-time-smoke.mjs');
 const at=Date.parse('2026-09-11T14:16:00Z');
 const q={symbol:'LITE',quoteAt:at,charts:{intraday:[{t:(at-3600000)/1000,c:100}]},slowFields:{intraday:{source:'nasdaq-intraday',timeContract:'nasdaq-label-et-v2',timeBasis:'source-label',stale:true}}};
 const result=describeChartTime(q);assert.equal(result.gapSeconds,3600);assert.equal(result.contractValid,true);assert.equal(result.cardBeijing,'2026-09-11 22:16:00');assert.equal(result.historyBeijing,'2026-09-11 21:16:00');assert.match(result.note,/陈旧/);
 const old=describeChartTime({...q,slowFields:{intraday:{source:'nasdaq-intraday'}}});assert.equal(old.contractValid,false);assert.match(old.note,/旧 Nasdaq/);
});
