// A real CLI process must exit1 on an uncaught error, allowing systemd recovery.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTestSandbox} from './support/isolation.mjs';
const sandbox=createTestSandbox(fileURLToPath(new URL('..',import.meta.url)));
process.on('exit',()=>sandbox.cleanup());
const preload='setTimeout(()=>{throw new Error("fixture uncaught");},300);';
const env={...sandbox.env,PORT:'0',SYMBOLS:'!',LOG_LEVEL:'error'};
if(process.env.NODE_V8_COVERAGE)env.NODE_V8_COVERAGE=process.env.NODE_V8_COVERAGE;
const res=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server.js'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8',timeout:5000});
assert.equal(res.status,1,res.stderr);assert.match(res.stdout+res.stderr,/\[uncaught\]/);
console.log('PASS direct CLI exits1 and reports uncaught error');
