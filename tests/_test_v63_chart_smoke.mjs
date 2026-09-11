import assert from 'node:assert/strict';
import {chartFailures,waitForCharts} from '../ops/chart-smoke.mjs';
const good=['QQQ','SPY'].map(symbol=>({symbol,price:100,charts:{intraday:[{t:1,c:100}],daily30:[{t:1,c:99}]},slowFields:{intraday:{stale:false,updatedAt:Date.now()},daily30:{stale:false,updatedAt:Date.now()}}}));
assert.deepEqual(chartFailures(good),[]);
assert.match(chartFailures([{...good[0],charts:{intraday:[],daily30:good[0].charts.daily30}},good[1]]).join(),/intraday unavailable/);
assert.match(chartFailures([{...good[0],slowFields:{intraday:{stale:true}}},good[1]]).join(),/awaiting source recovery/);
let at=0,calls=0;
const checked=await waitForCharts('http://127.0.0.1:8567',{deadlineMs:5000,now:()=>at,sleep:async ms=>{at+=ms;},fetchImpl:async()=>({ok:true,json:async()=>++calls<3?[{symbol:'QQQ',pending:true}]:good})});
assert.equal(checked.ok,true);assert.equal(calls,3);
await assert.rejects(waitForCharts('http://127.0.0.1:8567',{deadlineMs:1000,now:()=>at,sleep:async ms=>{at+=ms;},fetchImpl:async()=>({ok:true,json:async()=>[]})}),/Chart acceptance failed/);
console.log('PASS chart smoke requires both complete current-source series and bounded recovery');

for(const change of [{stale:true},{staleInfo:{reason:'snapshot unavailable'}},{recovery:true},{slowFields:{}},{slowFields:{charts:{stale:true,updatedAt:Date.now()}}},{slowFields:{intraday:{stale:false,updatedAt:Date.now(),error:'timeout'}}},{charts:{...good[0].charts,intraday:[{t:0,c:100}]}},{charts:{...good[0].charts,intraday:[{t:1,c:-1}]}}])assert.ok(chartFailures([{...good[0],...change},good[1]]).length,'unsafe acceptance vector must fail');
