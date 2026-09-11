import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createMacroFixture} from './macro-fixture.mjs';
test('production HTTP macro routes join the real feed parsers, evidence engine and lazy five-factor service',async t=>{
 const f=createMacroFixture();const app=createApplication({env:{PORT:0,PUBLIC_SOURCE_REDUNDANCY:'1',TE_API_KEY:'fixture-key',LOG_FILE:''},now:f.now,upstream:f.upstream,telemetry:createTelemetry()});t.after(()=>app.stop());
 assert.equal(f.calls.length,0);app.start();await once(app.httpServer,'listening');const base='http://127.0.0.1:'+app.httpServer.address().port;
 const news=await (await fetch(base+'/api/macro')).json();assert.ok(news.items.length>5);assert.equal(news.analysisVersion,1);
 assert.ok(news.items.some(x=>x.assessment.event==='oil-supply-loss'));assert.ok(news.items.some(x=>x.assessment.event==='inflation-surprise'));
 assert.ok(news.items.some(x=>x.src.startsWith('EIA')&&x.assessment.evidenceTier==='official'));assert.ok(news.items.some(x=>x.src.startsWith('BLS')));
 assert.equal(f.calls.filter(x=>x.includes('yahoo.com')).length,0,'macro news cannot burn Yahoo quote quota');
 assert.equal(f.calls.filter(x=>x.includes('push2.eastmoney.com')).length,0,'news endpoint alone cannot activate factor reads');
 let d=await (await fetch(base+'/api/macro/context?symbols=UNTRUSTED')).json();assert.equal(d.factors.length,5);await app.services.macroContext.getContext();await app.services.macroCalendar.getCalendar();
 d=await (await fetch(base+'/api/macro/context')).json();assert.ok(d.factors.every(x=>x.price>0));assert.equal(d.comparison,'waiting');assert.equal(d.calendar.items[0].status,'scheduled');
 const n=f.calls.length;await fetch(base+'/api/macro/context');assert.equal(f.calls.length,n,'no extra upstream calls within cache window');
 f.advance();await app.services.macroContext.getContext();await app.services.macroCalendar.getCalendar();d=await (await fetch(base+'/api/macro/context')).json();assert.equal(d.comparison,'comparable');assert.equal(d.calendar.items[0].surprise,-0.1);assert.ok(!JSON.stringify(d).includes('fixture-key'));assert.ok(d.observations.join(' ').includes('不能确认资金'));
});
