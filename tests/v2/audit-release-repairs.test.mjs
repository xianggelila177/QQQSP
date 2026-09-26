import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STATIC_INPUTS,validateStaticDependencies} from '../../scripts/build-static.mjs';
import {syncReadmeVersion} from '../../scripts/version.mjs';
import {createApiQuoteStream} from '../../lib/api-quote-stream.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
function temporary(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-release-audit-')));t.after(()=>{assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});return dir;}

test('both packaging entry points exclude private config and reject CRLF shell',t=>{
  const dir=temporary(t),source=path.join(dir,'source');
  function put(name,text){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  for(const name of ['package.py','package-release.py'])put('scripts/'+name,fs.readFileSync(path.join(root,'scripts',name)));
  for(const name of ['server.js','app.js','public/panel.bundle.js','public/index.html','部署说明.md'])put(name,'audit fixture');
  put('package.json','{"version":"audit"}');put('VERSION','108\n');put('.gitattributes','*.sh text eol=lf\n');put('.env.example','EXAMPLE=\n');put('start.sh','#!/bin/sh\nexit 0\n');
  for(const name of ['private/market-context.env','outputs/private.json','docs/private/config.json','data/feed.env','certificate.p12','docs/evidence/debug.json'])put(name,'SYNTHETIC_NOT_A_SECRET');
  for(const entry of ['package.py','package-release.py']){
    const target=path.join(dir,entry+'.zip');
    const out=spawnSync('python',[path.join(source,'scripts',entry),target],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);
    const listing=spawnSync('python',['-c','import zipfile,json,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',target],{encoding:'utf8'});
    const names=JSON.parse(listing.stdout);assert.ok(names.some(n=>n.endsWith('/.env.example')));assert.ok(names.some(n=>n.endsWith('/.gitattributes')));
    assert.equal(names.some(n=>/private|outputs|evidence|\.p12$|feed\.env$/.test(n)),false);
  }
  put('start.sh','#!/bin/sh\r\nexit 0\r\n');
  const bad=spawnSync('python',[path.join(source,'scripts/package.py'),path.join(dir,'bad.zip')],{encoding:'utf8'});
  assert.notEqual(bad.status,0);assert.match(bad.stderr,/Shell source must use LF/);
});

test('bundle rejects missing globals, duplicate providers and eager order drift',()=>{
  const sources=STATIC_INPUTS.map(file=>({file,source:fs.readFileSync(path.join(root,file),'utf8')}));validateStaticDependencies(sources);
  assert.throws(()=>validateStaticDependencies(sources.map((s,i)=>i===0?{...s,source:s.source+';window.PANEL_UNKNOWN.run();'}:s)),/Missing browser module/);
  assert.throws(()=>validateStaticDependencies(sources.map((s,i)=>i===0?{...s,source:s.source+';window.PANEL_FORMAT={};'}:s)),/Duplicate browser module/);
  const reordered=[...sources],a=reordered.findIndex(s=>s.file.endsWith('panel-format.js')),b=reordered.findIndex(s=>s.file.endsWith('panel-fundamentals.js'));
  [reordered[a],reordered[b]]=[reordered[b],reordered[a]];assert.throws(()=>validateStaticDependencies(reordered),/Browser module order/);
});

test('README version is checked and generated from VERSION',t=>{
  const dir=temporary(t);fs.writeFileSync(path.join(dir,'README.md'),'静态资源版本 **99**。');fs.writeFileSync(path.join(dir,'VERSION'),'108');
  assert.throws(()=>syncReadmeVersion(dir,{check:true}),/stale/);syncReadmeVersion(dir);syncReadmeVersion(dir,{check:true});assert.match(fs.readFileSync(path.join(dir,'README.md'),'utf8'),/\*\*108\*\*/);
});

test('API stream rejects quote capacity before headers and releases its budget',()=>{
  let released=0,headers=0;
  const engine={watch(){throw Object.assign(new Error('capacity'),{code:'QUOTES_CAPACITY_EXCEEDED',statusCode:503});}};
  const stream=createApiQuoteStream({engine,keys:{},budget:{acquire:()=>true,release(){released++;}}});
  assert.throws(()=>stream.open({}, {writeHead(){headers++;}}, ['NVDA'],{family:'fixture'},{}),{code:'QUOTES_CAPACITY_EXCEEDED'});
  assert.equal(headers,0);assert.equal(released,1);assert.equal(stream.diagnostics().connections,0);stream.close();
});
