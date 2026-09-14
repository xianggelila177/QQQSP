import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-credential-kind-'));
try {
 const fifo=path.join(dir,'credential.fifo');assert.equal(spawnSync('mkfifo',[fifo]).status,0);
 const script=`import {createTransport} from ${JSON.stringify(pathToFileURL(path.resolve('lib/transport.js')).href)};try{createTransport({env:{YAHOO_RELAY:'http://127.0.0.1:8801',YAHOO_RELAY_TOKEN_FILE:${JSON.stringify(fifo)}}});process.exitCode=2;}catch(e){if(e.message!=='Unable to load configured Yahoo relay credential file')process.exitCode=3;}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:2000,encoding:'utf8',env:{PATH:process.env.PATH,LOG_FILE:path.join(dir,'log')}});
 assert.equal(result.error,undefined,'FIFO rejection must not hang waiting for a writer');
 assert.equal(result.status,0,result.stderr);
 console.log('PASS explicit credential FIFO rejected promptly with safe diagnostic');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
