import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';
import {createFundamentalsProvider} from '../../lib/providers/fundamentals.js';
import {createFundamentalsService} from '../../lib/fundamentals-service.js';
const fixture=name=>fs.readFileSync(new URL('../fixtures/fundamentals-live/'+name,import.meta.url));
const now=Date.parse('2026-09-14T07:10:00Z');
const batch=createBatchProvider({now:()=>now});
const tx=()=>batch.parseTencentBatch(fixture('tencent.raw').toString('latin1'),['161128.SZ','AAOI','LITE']);
const settle=async service=>{for(let i=0;i<100&&service.diagnostics().inflight;i++)await new Promise(r=>setTimeout(r,5));assert.equal(service.diagnostics().inflight,0);};

test('live Naver responses retain exact regular-session turnover money and currency',()=>{
  for(const [file,symbol,amount] of [['naver-kr.json','000660.KS',6407051000000],['naver-us.json','AAOI',530156000],['naver-us.json','LITE',3189593000]]){
    const row=JSON.parse(fixture(file)).datas.find(r=>r.symbolCode===symbol.split('.')[0]);
    const q=batch.parseNaverQuote(row,symbol,70000),m=buildBasicMetrics(q);
    assert.equal(m.fields.turnoverAmount.value,amount,symbol);
    assert.equal(m.fields.turnoverAmount.currency,q.currency);
    assert.equal(m.fields.turnoverAmount.asOf,Date.parse(row.localTradedAt));
    assert.notEqual(m.fields.turnoverAmount.asOf,q.quoteAt);
    row.accumulatedTradingValueRaw='0';assert.equal(batch.parseNaverQuote(row,symbol,70000).turnoverAmount,0);
    delete row.accumulatedTradingValueRaw;
    assert.equal(batch.parseNaverQuote(row,symbol,70000).turnoverAmount,null,'never parse rounded/localized display value');
  }
});
test('Tencent mainland lots become shares; exact amount and LOF identity reach metrics without Yahoo',()=>{
  const q=tx()[0];assert.equal(q.volume,16662900);assert.equal(q.volumeUnit,'shares');
  assert.equal(q.instrumentType,'MUTUALFUND');assert.equal(q.turnoverAmount,118143660);
  const service=createFundamentalsService({now:()=>now});
  const m=service.decorate(q).fundamentals;
  assert.equal(m.fields.sharesOutstanding.value,478788557);
  assert.equal(m.fields.turnoverRate.value,16662900/478788557*100);
  assert.equal(m.fields.priceToBook.status,'not-applicable');
});
test('Tencent US equity financial fields survive even with no Yahoo record',()=>{
  const service=createFundamentalsService({now:()=>now});
  for(const [q,pb,shares] of [[tx()[1],5.36,84906289],[tx()[2],17.91,89700000]]){
    const m=service.decorate(q).fundamentals;
    assert.equal(m.fields.priceToBook.value,pb);assert.equal(m.fields.sharesOutstanding.value,shares);
    assert.ok(m.fields.turnoverAmount.value>0);assert.ok(m.fields.turnoverRate.value>0);
  }
});
test('public financial source works during Yahoo rate limiting without waiting on Yahoo',async()=>{
  let yahooCalls=0;
  const provider=createFundamentalsProvider({fetchPublicFundamentals:async symbol=>({symbol,source:'public-fixture',fields:{priceToBook:{value:5.33}}}),fetchYahooSummary:async()=>{yahooCalls++;throw Object.assign(new Error('429'),{code:'RATE_LIMITED'});}});
  assert.equal((await provider('AAOI')).fields.priceToBook.value,5.33);assert.equal(yahooCalls,0);
});
test('snapshot financial facts refresh after a minute rather than the six-hour statement TTL',async t=>{
  let clock=now,calls=0;
  const service=createFundamentalsService({now:()=>clock,fetchFundamentals:async symbol=>({symbol,source:'public-fixture',refreshAfterMs:60000,fields:{priceToBook:{value:++calls,status:'available'}}})});
  t.after(()=>service.stop());service.start();const q={symbol:'AAOI',price:100,instrumentType:'EQUITY'};
  service.decorate(q);await settle(service);assert.equal(service.decorate(q).fundamentals.fields.priceToBook.value,1);
  clock+=60001;service.decorate(q);await settle(service);assert.equal(service.decorate(q).fundamentals.fields.priceToBook.value,2);
});
