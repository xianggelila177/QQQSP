import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createTestSandbox} from './support/isolation.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests');
const retired=JSON.parse(fs.readFileSync(path.join(dir,'retired-v72.json'),'utf8')).files;
for(const [file,item] of Object.entries(retired)){
 if(!fs.existsSync(path.join(dir,file))||!item.reason||!item.replacement?.every(p=>fs.existsSync(path.join(root,p))))throw new Error('无效迁移说明：'+file);
}
const all=fs.readdirSync(dir).filter(f=>/^_test_.*\.(mjs|sh)$/.test(f)&&f!=='_test_log_rotate_child.mjs').sort();
const files=all.filter(f=>!retired[f]),failed=[];
console.log(`保留回归：${files.length} 文件；显式退役：${Object.keys(retired).length} 文件（不计为通过，见 tests/retired-v72.json）。`);
for(const file of files){
 const sandbox=createTestSandbox(root);
 try{
  sandbox.env.NODE_OPTIONS='--import='+pathToFileURL(path.join(dir,'support/no-network.mjs')).href;
  const result=spawnSync(file.endsWith('.sh')?'/bin/bash':process.execPath,[path.join(dir,file)],{cwd:root,env:sandbox.env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const ok=result.status===0&&!result.error;console.log((ok?'PASS ':'FAIL ')+file);
  if(!ok){failed.push(file);console.error([result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\n').slice(-14000));}
 }finally{sandbox.cleanup();}
}
console.log(`REGRESSION_PASS_FILES=${files.length-failed.length} REGRESSION_FAIL_FILES=${failed.length} RETIRED_FILES=${Object.keys(retired).length}`);
const core=fs.readdirSync(path.join(dir,'v2')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join(dir,'v2',f));
const result=spawnSync(process.execPath,['--test',...core],{cwd:root,stdio:'inherit',timeout:120000});
if(result.status!==0||result.error)failed.push('v2-core');
if(failed.length)console.error('FAILED: '+failed.join(', '));
process.exitCode=failed.length?1:0;
