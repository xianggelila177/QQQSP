import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
const run=promisify(execFile);
test('release smoke commands read the local VERSION; macro default check does not request macro sources',async t=>{
 let calls=0;
 const app=createApplication({env:{PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},telemetry:createTelemetry(),upstream:async()=>{calls++;return {status:429,headers:{'retry-after':'60'},body:''};}});
 t.after(()=>app.stop());app.start();await once(app.httpServer,'listening');
 const origin='http://127.0.0.1:'+app.httpServer.address().port,initial=calls;
 const macro=await run(process.execPath,[new URL('../../ops/macro-smoke.mjs',import.meta.url).pathname,origin],{timeout:15000});
 assert.match(macro.stdout,/没有主动读取宏观源/);assert.equal(calls,initial);
 const futures=await run(process.execPath,[new URL('../../ops/futures-smoke.mjs',import.meta.url).pathname,origin],{timeout:15000});
 assert.match(futures.stdout,/期货验收通过/);
});
