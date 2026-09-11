import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSinaQuotes,createSinaQuotes,sinaCode,wallTimestamp,sinaExtendedTime} from '../../lib/providers/sina-quotes.js';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {createHostGate} from '../../lib/host-gate.js';
import {minimumGap} from '../../lib/source-registry.js';
const now=Date.parse('2026-09-10T14:00:00Z');
import {sinaRow} from './source-fixtures.mjs';

test('Sina builds one HTTPS batch, parses data without eval and distinguishes website time from trade time',async()=>{
 let calls=[];const source=createSinaQuotes({now:()=>now,httpsGet:async(url,headers)=>{calls.push({url,headers});return {status:200,body:sinaRow('NVDA')+sinaRow('LITE',{price:900})};}});
 const q=await source(['NVDA','LITE']);assert.equal(calls.length,1);assert.match(calls[0].url,/list=gb_nvda,gb_lite$/);assert.ok(calls[0].headers.Referer);
 assert.equal(q.length,2);assert.equal(q[0].price,100);assert.equal(q[0].quoteAt,Date.parse('2026-09-10T13:59:00Z'));assert.equal(q[0].sourceCheckedAt,now);assert.equal(q[0].providerUpdatedAt,now-1000);assert.equal(q[0].quoteTimePrecision,'minute');assert.equal(q[0].pollAfterMs,1000);
 assert.equal(parseSinaQuotes(sinaRow('AAPL'),['NVDA'],{now}).length,0);
});
test('Sina extended trade selects its own timestamp and regular reference, never request time',()=>{
 const q=parseSinaQuotes(sinaRow('NVDA',{date:'2026-09-10 19:00:00',trade:'Sep 09 04:00PM EDT',ext:'Sep 10 07:00AM EDT',extPrice:103}),['NVDA'],{now})[0];
 assert.equal(q.price,103);assert.equal(q.priceSession,'PRE');assert.equal(q.regularPrice,100);assert.equal(q.ext.pre.change,3);assert.equal(q.quoteAt,Date.parse('2026-09-10T11:00:00Z'));assert.equal(q.ohlcConsistent,false);
});
test('Sina rejects malformed, future and missing trade times; EST/EDT and year boundary are explicit',()=>{
 assert.equal(parseSinaQuotes('var hq_str_gb_nvda="bad";', ['NVDA'],{now}).length,0);
 assert.equal(parseSinaQuotes(sinaRow('NVDA',{trade:''}), ['NVDA'],{now}).length,0);
 assert.equal(parseSinaQuotes(sinaRow('NVDA',{trade:'Sep 11 09:59AM EDT'}), ['NVDA'],{now}).length,0);
 assert.equal(wallTimestamp('2026-01-05 16:00:00','NVDA'),Date.parse('2026-01-05T21:00:00Z'));
 assert.equal(sinaExtendedTime('Dec 31 04:00PM EST',Date.parse('2027-01-01T01:00:00Z')),Date.parse('2026-12-31T21:00:00Z'));
 assert.equal(sinaCode('000660.KS'),null);assert.equal(sinaCode('SKHY'),'gb_skhy');assert.equal(sinaCode('0700.HK'),'rt_hk00700');
});
test('Chinese and Hong Kong Sina records preserve separate currencies and identity',()=>{
 const cn=Array(33).fill('');Object.assign(cn,{0:'Moutai',1:98,2:99,3:100,4:101,5:97,8:2000,30:'2026-09-10',31:'14:00:00'});
 const hk=Array(19).fill('');Object.assign(hk,{0:'Tencent',1:'Tencent',2:398,3:399,4:402,5:395,6:400,12:9000,17:'2026/09/10',18:'14:00'});
 const quotes=parseSinaQuotes(`var hq_str_sh600519="${cn.join(',')}";var hq_str_rt_hk00700="${hk.join(',')}";`,['600519.SS','0700.HK'],{now});
 assert.deepEqual(quotes.map(q=>[q.symbol,q.price,q.currency]),[['600519.SS',100,'CNY'],['0700.HK',400,'HKD']]);
});
test('Tencent HK batch cannot accidentally use USD; source polling floor is 1s',()=>{
 const f=Array(90).fill('');Object.assign(f,{1:'Tencent',2:'00700',3:400,4:399,5:398,6:100,30:'20260910140000',33:402,34:395});
 const provider=createBatchProvider({now:()=>now,pollMs:1000});const q=provider.parseTencentBatch(`v_hk00700="${f.join('~')}";`,['0700.HK'])[0];
 assert.equal(q.currency,'HKD');assert.equal(q.market,'港股');assert.equal(q.exchangeName,'HKEX');
 for(const host of ['hq.sinajs.cn','qt.gtimg.cn','polling.finance.naver.com'])assert.equal(minimumGap(host),1000);
});
test('429 Retry-After suppresses queued siblings; closing and reopening do not bypass cooldown',async()=>{
 let time=now,calls=0;const gate=createHostGate({now:()=>time,minGap:()=>0});
 const work=()=>{calls++;return {status:429,headers:{'retry-after':'120'}};};
 await gate.run('https://hq.sinajs.cn/list=gb_nvda',work);
 await assert.rejects(gate.run('https://hq.sinajs.cn/list=gb_lite',work),e=>e.status===429&&e.retryAt===now+120000);
 gate.close();gate.reopen();time+=60000;await assert.rejects(gate.run('https://hq.sinajs.cn/list=gb_nvda',work));assert.equal(calls,1);
 time+=60000;await gate.run('https://hq.sinajs.cn/list=gb_nvda',()=>{calls++;return {status:200};});assert.equal(calls,2);gate.close();
});
