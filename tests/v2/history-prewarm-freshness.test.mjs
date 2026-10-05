import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {fixtureAt,historyData} from './backend-repair-fixtures.mjs';

function periods(at,{daily={},weekly={}}={}){
  return Object.fromEntries(['daily','weekly','monthly','yearly'].map(period=>[period,{period,symbol:'NVDA',
    seriesId:'series',revision:'1',requestedCount:period==='yearly'?39:79,bars:[{t:fixtureAt/1000,c:100}],
    sourceCheckedAt:at,status:'ready',stale:false,...(period==='daily'?daily:period==='weekly'?weekly:{})}]));
}
function stub(prepare){return {cache:new Map(),exportState:()=>({schemaVersion:1,entries:[]}),prepare};}

test('fresh 79-bar daily prewarm remains ready after a long history cache expires',async t=>{
  let clock=fixtureAt;
  const history=createHistoryService({now:()=>clock,fetchChart:async symbol=>historyData(symbol)});
  await history.get('NVDA','daily',{count:80});clock+=61000;
  const worker=createHistoryPrewarm({history,now:()=>clock,tickMs:600000});
  t.after(async()=>{await worker.stop();history.close();});
  worker.retain(['NVDA']);await worker.start();await worker.settled();
  const bundle=worker.snapshot().entries[0];
  assert.equal(bundle.periods.daily.status,'ready');
  assert.equal(bundle.periods.weekly.status,'stale','near refresh must not renew unrelated long source timestamps');
  assert.equal(bundle.status,'stale');
  const value=worker.read('NVDA','daily',{count:79});
  assert.equal(value.returnedCount,79);
  assert.equal(value.status,'ready');assert.equal(value.stale,false);
  assert.equal(value.sourceCheckedAt,clock);
  assert.equal(bundle.refreshFailed,false);
});

test('another period error and cooldown cannot contaminate the daily read',async t=>{
  const worker=createHistoryPrewarm({now:()=>fixtureAt,tickMs:600000,
    history:stub(async()=>periods(fixtureAt,{weekly:{stale:true,status:'stale',errorCode:'WEEKLY_SOURCE_OFFLINE',retryAt:fixtureAt+600000}}))});
  t.after(()=>worker.stop());worker.retain(['NVDA']);await worker.start();await worker.settled();
  assert.equal(worker.snapshot().entries[0].error,'WEEKLY_SOURCE_OFFLINE');
  assert.equal(worker.snapshot().entries[0].nextAt,fixtureAt+60000,'long-period cooldown cannot postpone the next near daily refresh');
  const daily=worker.read('NVDA','daily',{count:79});
  assert.equal(daily.status,'ready');assert.equal(daily.stale,false);
  assert.equal(daily.errorCode,undefined);assert.equal(daily.retryAt,undefined);
});

test('a real whole-refresh failure retains daily bars and reports stale until successful recovery',async t=>{
  let clock=fixtureAt,failed=false;
  const worker=createHistoryPrewarm({now:()=>clock,tickMs:600000,history:stub(async()=>{
    if(failed)throw Object.assign(Error('offline'),{code:'SOURCE_OFFLINE',retryAt:clock+120000});
    return periods(clock);
  })});
  t.after(()=>worker.stop());worker.retain(['NVDA']);await worker.start();await worker.settled();
  const first=worker.read('NVDA','daily',{count:79});
  clock+=60000;failed=true;await worker.runDue();await worker.settled();
  const value=worker.read('NVDA','daily',{count:79});
  assert.equal(worker.snapshot().entries[0].refreshFailed,true);
  assert.equal(value.status,'stale');assert.equal(value.stale,true);
  assert.equal(value.errorCode,'SOURCE_OFFLINE');assert.equal(value.retryAt,clock+120000);
  assert.strictEqual(value.bars,first.bars);assert.equal(value.sourceCheckedAt,fixtureAt);
  clock+=120000;failed=false;await worker.runDue();await worker.settled();
  const recovered=worker.read('NVDA','daily',{count:79});
  assert.equal(worker.snapshot().entries[0].refreshFailed,false);
  assert.equal(recovered.status,'ready');assert.equal(recovered.stale,false);
  assert.equal(recovered.errorCode,undefined);assert.equal(recovered.sourceCheckedAt,clock);
});

test('daily own stale status, error and source age remain authoritative',async t=>{
  let clock=fixtureAt,ownFailure=true;
  const worker=createHistoryPrewarm({now:()=>clock,tickMs:600000,history:stub(async()=>periods(fixtureAt,
    ownFailure?{daily:{status:'stale',stale:true,errorCode:'DAILY_SOURCE_OFFLINE',retryAt:clock+60000}}:{}))});
  t.after(()=>worker.stop());worker.retain(['NVDA']);await worker.start();await worker.settled();
  const failed=worker.read('NVDA','daily',{count:79});
  assert.equal(failed.status,'stale');assert.equal(failed.errorCode,'DAILY_SOURCE_OFFLINE');
  assert.equal(worker.snapshot().entries[0].refreshFailed,false);
  clock+=120001;ownFailure=false;await worker.runDue();await worker.settled();
  const aged=worker.read('NVDA','daily',{count:79});
  assert.equal(worker.snapshot().entries[0].checkedAt,clock,'a new bundle does not renew its period source clock');
  assert.equal(aged.status,'stale');assert.equal(aged.stale,true);
  assert.equal(aged.sourceCheckedAt,fixtureAt);
});
