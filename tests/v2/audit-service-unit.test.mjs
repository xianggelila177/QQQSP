import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../../',import.meta.url));
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
test('service provisioning creates a restrictive new unit and leaves customized units byte-identical',t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-unit-'));
  t.after(()=>{assert.ok(temporary.startsWith(path.join(os.tmpdir(),'qqqsp-unit-')));fs.rmSync(temporary,{recursive:true,force:true});});
  const target=path.join(temporary,'unit.service').replaceAll('\\','/');
  const run=()=>spawnSync(bash,['-c','set -euo pipefail; source ops/service-unit.sh; qqqsp_write_service_unit "$1" /opt/qqqsp-v2 /opt/node/bin/node 512M 768M','audit',target],{cwd:root,encoding:'utf8'});
  let result=run();assert.equal(result.status,0,result.stderr);
  const initial=fs.readFileSync(target,'utf8');
  assert.match(initial,/UMask=0077/);assert.match(initial,/WorkingDirectory=\/opt\/qqqsp-v2\/current/);
  const customized=initial.replace('MemoryMax=768M','MemoryMax=1024M')+'\nPrivateTmp=true\n';
  fs.writeFileSync(target,customized);result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(target,'utf8'),customized,'upgrade must not replace user settings');
});
