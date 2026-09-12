import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createMacroFixture} from './macro-fixture.mjs';
test('production HTTP reads server-owned macro snapshots; real parsers, separate factor collection and consensus capture',async t=>{
 const f=createMacroFixture();const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',PORT:0,MACRO_STATE_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'1',TE_API_KEY:'fixture-key',LOG_FILE:''},now:f.now,upstream:f.upstream,telemetry:createTelemetry()});t.after(()=>app.stop());
 assert.equal(f.calls.length,0,'construction is side-effect free');app.start();await once(app.httpServer,'listening');await app.services.macroMonitor.settled();const base='http://127.0.0.1:'+app.httpServer.address().port;
 const before=f.calls.length,news=await (await fetch(base+'/api/macro')).json();assert.ok(news.items.length>5);assert.equal(news.analysisVersion,1);
 assert.ok(news.items.some(x=>x.assessment.event==='oil-supply-loss'));assert.ok(news.items.some(x=>x.assessment.event==='inflation-surprise'));
 assert.ok(news.items.some(x=>x.src.startsWith('EIA')&&x.assessment.evidenceTier==='official'));assert.ok(news.items.some(x=>x.src.startsWith('BLS')));
 assert.equal(f.calls.length,before,'HTTP news read cannot start extra quote or news requests');
 assert.ok(!f.calls.some(x=>/yahoo\.com/.test(x)&&/search|crumb/.test(x)),'macro news cannot burn Yahoo authentication/search quota');
 let d=await (await fetch(base+'/api/macro/context?symbols=UNTRUSTED')).json();assert.equal(d.factors.length,5);assert.ok(d.factors.every(x=>x.price>0));assert.equal(d.comparison,'waiting');assert.equal(d.calendar.items[0].status,'scheduled');
 await fetch(base+'/api/macro/context');assert.equal(f.calls.length,before,'read routes use shared cache only');
 f.advance();app.services.macroMonitor.runDue();await app.services.macroMonitor.settled();d=await (await fetch(base+'/api/macro/context')).json();assert.equal(d.comparison,'comparable');assert.equal(d.calendar.items[0].surprise,-0.1);assert.ok(!JSON.stringify(d).includes('fixture-key'));assert.ok(d.observations.join(' ').includes('不能确认资金'));
});
