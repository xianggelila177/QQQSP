import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
const run=promisify(execFile);
test('release smoke commands read the local VERSION; macro check reads monitor cache, not additional macro sources',async t=>{
 let calls=0;
 const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',MACRO_STATE_PATH:'',PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},telemetry:createTelemetry(),upstream:async()=>{calls++;return {status:429,headers:{'retry-after':'60'},body:''};}});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');await app.services.macroMonitor.settled();
 const origin='http://127.0.0.1:'+app.httpServer.address().port,initial=calls;
 const macro=await run(process.execPath,[fileURLToPath(new URL('../../ops/macro-smoke.mjs',import.meta.url)),origin],{timeout:15000});
 assert.match(macro.stdout,/不额外触发采集/);assert.equal(calls,initial);
 const futures=await run(process.execPath,[fileURLToPath(new URL('../../ops/futures-smoke.mjs',import.meta.url)),origin],{timeout:15000});
 assert.match(futures.stdout,/期货验收通过/);
});
