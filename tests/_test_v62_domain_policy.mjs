import assert from 'node:assert/strict';
import {quoteStatus} from '../lib/http-diagnostics.js';
import {createSnapshotService} from '../lib/snapshot-service.js';
import {sentiOf} from '../sent.mjs';

const noon=Date.parse('2026-09-07T04:00:00Z');
const morning=Date.parse('2026-09-07T03:30:00Z');
const lunch={symbol:'600519.SS',price:100,marketState:'BREAK',quoteAt:morning,fetchedAt:noon};
assert.equal(quoteStatus(lunch,noon).status,'ok','fresh source and morning close remain usable during actual lunch');
assert.equal(quoteStatus({...lunch,quoteAt:morning-3600000},noon).status,'stale','old morning data remains stale');
assert.equal(quoteStatus({...lunch,fetchedAt:noon-60000},noon).status,'stale','lunch never hides stale source check');
assert.equal(quoteStatus({...lunch,marketState:'REGULAR',fetchedAt:noon+3660000},noon+3660000).status,'stale','strict freshness resumes after lunch');
for(const [plain,negated] of [['Fed rate cuts','Fed rules out rate cuts'],['Fed rate hikes','Fed rules out rate hikes']]) {
 assert.notEqual(sentiOf(plain),'中性');
 assert.equal(sentiOf(negated),'中性','negated topic cannot keep affirmative direction');
}

const timers=new Map();let tid=0;
const original={setTimeout,clearTimeout,setInterval,clearInterval};
globalThis.setTimeout=(fn,ms)=>{timers.set(++tid,{fn,ms,once:true});return tid;};
globalThis.setInterval=(fn,ms)=>{timers.set(++tid,{fn,ms});return tid;};
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
const fire=async ms=>{for(const [id,t] of [...timers])if(t.ms===ms){if(t.once)timers.delete(id);t.fn();}for(let i=0;i<30;i++)await Promise.resolve();};
const start=Date.parse('2026-09-07T14:00:00Z');let now=start,state='REGULAR',enriches=0;
const quote=symbol=>({symbol,price:100,quoteAt:now,fetchedAt:now,marketState:state});
const svc=createSnapshotService({now:()=>now,fetchBatch:async syms=>({quotes:syms.map(quote),pollAfterMs:2000}),enrich:async symbol=>{
 enriches++;
 if(symbol!=='AAPL')return new Promise(()=>{});
 return {...quote(symbol),charts:{intraday:[{t:now/1000,c:100}],daily30:[{t:now/1000,c:100}]},slowFields:{intraday:{updatedAt:now,source:'fixture',stale:false},daily30:{updatedAt:now,source:'fixture',stale:false}}};
}});
try {
 svc.start();svc.getCachedQuote('AAPL');await fire(100);
 const initial=svc.getCachedQuote('AAPL');
 now+=1000;svc.getCachedQuote('MSFT');svc.getCachedQuote('GOOG');await fire(100);
 now+=99000;svc.getCachedQuote('AAPL');await fire(2000);
 now+=31000;const queued=svc.getCachedQuote('AAPL');
 assert.equal(queued.slowFields.intraday.stale,true,'queued history expires without waiting for failure');
 assert.equal(queued.slowFields.intraday.updatedAt,start,'queue cannot move successful timestamp');
 assert.equal(queued.charts,initial.charts,'retain immutable last good chart');
 assert.equal(queued.slowFields.daily30.stale,false,'daily history has a separate budget');
} finally {svc.stop();timers.clear();}
now=start;state='CLOSED';enriches=0;
const idle=createSnapshotService({now:()=>now,sessionFor:()=>state,fetchBatch:async syms=>({quotes:syms.map(quote),pollAfterMs:70000}),enrich:async symbol=>{enriches++;return quote(symbol);}});
try {
 idle.start();idle.getCachedQuote('AAPL');await fire(100);
 assert.equal(enriches,1);
 for(let i=0;i<12;i++){now+=60000;idle.getCachedQuote('AAPL');await fire(2000);}
 assert.equal(enriches,1,'closed markets must not perform minute enrichment');
 state='REGULAR';now+=2000;await fire(2000);
 assert.equal(enriches,2,'opening session immediately restores enrichment');
} finally {idle.stop();Object.assign(globalThis,original);}
console.log('PASS v62 lunch, topic negation, queued freshness and closed enrichment budgets');
