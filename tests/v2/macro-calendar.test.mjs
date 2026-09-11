import test from 'node:test';import assert from 'node:assert/strict';
import {createMacroCalendar} from '../../lib/providers/macro-calendar.js';
const release=Date.parse('2026-09-11T12:30:00Z');
const row={CalendarId:'demo',Date:'2026-09-11T12:30:00',Country:'United States',Event:'Core Inflation Rate MoM',Reference:'Aug',ReferenceDate:'2026-08-31T00:00:00',DateSpan:'0',Actual:'',Forecast:'0.3%',Previous:'0.3%',Revised:'0.2%',TEForecast:'0.4%',Unit:'%',Source:'BLS',SourceURL:'https://www.bls.gov/'};
test('no calendar credentials means zero external calls',async()=>{let count=0;const s=createMacroCalendar({httpsGet:async()=>{count++;}});assert.equal((await s.getCalendar()).status,'disabled');s.requestCalendar();assert.equal(count,0);});
test('consensus is captured before scheduled release and never overwritten by the model or a post-release revision',async()=>{
 let time=release-120000,data={...row};const calls=[];
 const s=createMacroCalendar({key:'fixture-key',now:()=>time,httpsGet:async(url,headers)=>{calls.push({url,headers});return {status:200,body:JSON.stringify([data])};}});
 let d=await s.getCalendar();assert.equal(d.items[0].actual,null);assert.equal(d.items[0].consensusCapturedAt,time);
 time=release+1000;data={...row,Actual:'0.2%',Forecast:'0.2%'};d=await s.getCalendar();const x=d.items[0];assert.equal(x.surprise,-0.1);assert.equal(x.consensus,'0.3%');assert.equal(x.currentConsensus,'0.2%');assert.equal(x.modelForecast,'0.4%');assert.equal(x.previousBeforeRevision,'0.2%');assert.equal(x.releaseAt,release);assert.ok(!calls[0].url.includes('fixture-key'));assert.equal(calls[0].headers.Authorization,'fixture-key');
});
test('missing consensus never falls back to model forecast; late start never claims a pre-release snapshot',async()=>{
 const s=createMacroCalendar({key:'fixture',now:()=>release+1000,httpsGet:async()=>({status:200,body:JSON.stringify([{...row,Actual:'0.2%',Forecast:''}])})});
 let x=(await s.getCalendar()).items[0];assert.equal(x.consensus,null);assert.equal(x.surprise,null);assert.equal(x.consensusBasis,'missing');
});
test('estimated time, missing reference, or foreign country cannot yield a confirmed comparable release',async()=>{
 const rows=[{...row,Actual:'0.2%',DateSpan:'1'},{...row,CalendarId:'b',Actual:'0.2%',Reference:''},{...row,Country:'China',Actual:'0.2%'}];
 const s=createMacroCalendar({key:'fixture',now:()=>release+1000,httpsGet:async()=>({status:200,body:JSON.stringify(rows)})});const d=await s.getCalendar();assert.equal(d.items.length,2);assert.ok(d.items.every(x=>x.surprise===null));
});
test('unauthorized keys stop repeated calls until restart; error does not expose secrets',async()=>{
 let calls=0;const s=createMacroCalendar({key:'not-a-real-secret',now:()=>release,httpsGet:async()=>{calls++;return {status:401,body:'not-a-real-secret'};}});let d=await s.getCalendar();assert.equal(d.status,'error');assert.ok(!JSON.stringify(d).includes('not-a-real-secret'));await s.getCalendar();assert.equal(calls,1);
});
