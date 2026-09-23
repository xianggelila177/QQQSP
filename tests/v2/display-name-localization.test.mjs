import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {quoteDisplayName} from '../../lib/instruments.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';

const now=Date.parse('2026-09-14T07:10:00Z');
const fixture=name=>JSON.parse(readFileSync(new URL('../fixtures/fundamentals-live/'+name,import.meta.url),'utf8'));

test('Naver US Korean names use catalog names without changing Korean listings',()=>{
  const provider=createBatchProvider({now:()=>now});
  for(const [symbol,expected] of [['AAOI','应用光电'],['LITE','Lumentum']]){
    const row=fixture('naver-us.json').datas.find(item=>item.symbolCode===symbol);
    assert.equal(provider.parseNaverQuote(row,symbol,70000).displayName,expected);
  }
  const korean=fixture('naver-kr.json').datas[0];
  assert.equal(provider.parseNaverQuote(korean,'000660.KS',70000).displayName,korean.stockName);
  assert.equal(quoteDisplayName('NVDA','엔비디아'),'英伟达');
  assert.equal(quoteDisplayName('UNKNOWNCO','한국어 이름'),'UNKNOWNCO');
  assert.equal(quoteDisplayName('UNKNOWNCO','Example Corp'),'Example Corp');
});

test('cached Korean name is corrected before a quote reaches the panel',async()=>{
  const service=createSnapshotService({now:()=>now,env:{POLL_MS:1000},
    fetchBatch:async()=>({quotes:[{symbol:'AAOI',displayName:'어플라이드 옵토일렉트로닉스',
      price:107.02,quoteAt:now-1000,sourceCheckedAt:now,currency:'USD',src:'naver-us',marketState:'REGULAR'}],pollAfterMs:70000}),
    enrich:async()=>{throw new Error('history unavailable');}});
  try{
    service.start();service.getCachedQuote('AAOI');
    for(let i=0;i<100&&service.getCachedQuote('AAOI').price==null;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(service.getCachedQuote('AAOI').displayName,'应用光电');
  }finally{service.stop();}
});
