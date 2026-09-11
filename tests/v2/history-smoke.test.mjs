import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHistory} from '../../ops/history-smoke.mjs';
import {parseNasdaqHistory} from '../../lib/providers/public-history.js';
import {usableHistory} from '../../lib/history-source.js';
test('deployment history acceptance checks all four periods and actual candles, not service readiness',async()=>{
 let calls=0;const result=await checkHistory('http://localhost:8568',{symbols:['NVDA'],fetchImpl:async url=>{calls++;return {ok:true,status:200,json:async()=>({symbol:'NVDA',period:url.searchParams.get('period'),status:'ready',source:'test',bars:[{t:1,o:100,h:105,l:99,c:102}]})};}});
 assert.equal(result.ok,true);assert.equal(calls,4);assert.deepEqual(result.checks.map(x=>x.period),['daily','weekly','monthly','yearly']);
});
test('deployment acceptance fails on empty or cooling history without repeatedly polling a failed symbol',async()=>{
 let calls=0;const result=await checkHistory('http://localhost:8568',{symbols:['NVDA'],fetchImpl:async()=>{calls++;return {ok:false,status:503,json:async()=>({error:'cooling',retryAt:Date.now()+60000})};}});
 assert.equal(result.ok,false);assert.equal(calls,1);assert.ok(result.checks[0].retryAt>Date.now());
});
test('legitimate pre-1970 daily dates are not rejected as invalid Unix timestamps',()=>{
 const data=parseNasdaqHistory({data:{symbol:'IBM',tradesTable:{rows:[{date:'06/01/1965',open:10,high:12,low:9,close:11}]}}},'IBM');
 assert.ok(data.timestamp[0]<0);assert.equal(usableHistory(data,'IBM','?interval=1d'),true);
});
