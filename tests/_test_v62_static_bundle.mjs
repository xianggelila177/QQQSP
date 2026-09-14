import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildStatic,STATIC_INPUTS} from '../scripts/build-static.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-assets-'));
try {
 fs.cpSync('public',path.join(temp,'public'),{recursive:true});
 const first=buildStatic(temp);
 assert.equal(first.inputs,STATIC_INPUTS.length);
 assert.ok(STATIC_INPUTS.indexOf('public/modules/panel-macro-context.js')<STATIC_INPUTS.indexOf('public/modules/panel-macro-controller.js'));
 for(const file of ['public/modules/panel-timeframes.js','public/modules/panel-history-store.js','public/modules/panel-sample-store.js']){
  assert.ok(STATIC_INPUTS.includes(file),'history module must ship independently');
  assert.ok(STATIC_INPUTS.indexOf(file)<STATIC_INPUTS.indexOf('public/modules/panel-chart-controller.js'),'history dependencies precede consumers');
 }
 const code=fs.readFileSync(path.join(temp,'public/panel.bundle.js'),'utf8');
 const layout=JSON.parse(fs.readFileSync(path.join(temp,'public/panel.bundle.layout.json'),'utf8'));
 for(const file of layout.files)assert.equal(code.slice(file.startOffset,file.endOffset),fs.readFileSync(path.join(temp,file.path),'utf8'));
 assert.equal(layout.files.at(-1).path,'public/app.js','composition runs last');
 const before=fs.readFileSync(path.join(temp,'public/panel.bundle.js'));
 buildStatic(temp);assert.deepEqual(fs.readFileSync(path.join(temp,'public/panel.bundle.js')),before);
 buildStatic(temp,{check:true});
 fs.appendFileSync(path.join(temp,STATIC_INPUTS[0]),'\n// changed input\n');
 assert.throws(()=>buildStatic(temp,{check:true}),/stale/i);
 assert.deepEqual(fs.readFileSync(path.join(temp,'public/panel.bundle.js')),before,'check mode cannot mutate shipped bytes');
 buildStatic(temp);buildStatic(temp,{check:true});
 console.log('PASS deterministic bundle, exact original-source ranges, and read-only freshness check');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
