// Macro service behavior uses explicit source fixtures; no default transport.
import assert from 'node:assert/strict';
import { MACRO_MAX_AGE, createMacroService } from '../lib/macro.js';

assert.equal(MACRO_MAX_AGE, 48 * 3600e3);
const topics=[];
let yahooCalls=0,flashCalls=0;
const now=Date.parse('2026-09-05T12:00:00Z');
const service=createMacroService({
  now:()=>now,
  googleNewsTopic:async topic=>{topics.push(topic.id);return [];},
  yahooNews:async()=>{yahooCalls++;return [];},
  httpsGet:async url=>{
    assert.equal(new URL(url).hostname,'zhibo.sina.com.cn');
    flashCalls++;
    return {status:200,body:JSON.stringify({result:{data:{feed:{list:[]}}}})};
  },
});
const data=await service.getMacro();
assert.deepEqual(data.items,[]);
assert.equal(Array.isArray(data.topics),true);
assert.deepEqual(topics,['inflation','treasury','oil','fed','gold']);
assert.equal(yahooCalls,5);
assert.equal(flashCalls,1);
assert.equal(data.stale,false);
assert.equal(data.error,undefined);
assert.equal(data.updatedAt,now);
console.log('RESULT: PASS');
