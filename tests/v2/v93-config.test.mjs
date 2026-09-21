import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,symlink} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {parseEnv} from 'node:util';
import {initializeConfig} from '../../scripts/init-config.mjs';
test('v93 first-run configuration creates independent private keys and refuses overwrite/symlinks',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qqqsp-v93-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));const dest=path.join(dir,'.env');await initializeConfig(dest);
 const original=await readFile(dest,'utf8'),env=parseEnv(original);assert.ok(/^[A-Za-z0-9_-]{43}$/.test(env.LLM_API_KEY));assert.ok(env.STATS_TOKEN!==env.LLM_API_KEY);assert.equal(env.HOST,'127.0.0.1');
 if(process.platform!=='win32')assert.equal((await stat(dest)).mode&0o777,0o600);
 await assert.rejects(initializeConfig(dest));assert.equal(await readFile(dest,'utf8'),original);
 if(process.platform!=='win32'){const link=path.join(dir,'link');await symlink(dest,link);await assert.rejects(initializeConfig(link));assert.equal(await readFile(dest,'utf8'),original);}
});
