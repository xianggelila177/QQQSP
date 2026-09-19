import {buildContextDocs} from './build-context-docs.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import zlib from 'node:zlib';
import {checkVersion} from './version.mjs';import {buildStatic} from './build-static.mjs';import {syncExample} from './env-example.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if((Number(process.versions.node.split('.')[0])<22 || Number(process.versions.node.split('.')[0])===22 && Number(process.versions.node.split('.')[1])<16))throw new Error('需要 Node.js 22.16 或更新版本（推荐 24）');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(['node_modules','.git','logs','state','__pycache__'].includes(e.name)?[]:walk(path.join(dir,e.name))):[path.join(dir,e.name)]);}
let count=0;for(const f of walk(root)){if(!/\.(?:mjs|js|sh)$/.test(f))continue;const shell=f.endsWith('.sh');if(shell&&process.platform==='win32')continue;const r=spawnSync(shell?'bash':process.execPath,shell?['-n',f]:['--check',f],{encoding:'utf8'});if(r.status!==0||r.error)throw new Error(f+'\n'+(r.stderr||r.error));count++;}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));if(Object.keys(pkg.dependencies||{}).length)throw new Error('禁止 npm 运行时依赖');
for(const dir of ['lib','public/modules'])for(const file of walk(path.join(root,dir)).filter(f=>/\.js$/.test(f))){const src=fs.readFileSync(file,'utf8');if(/process\.env|\b(?:const|let|var)\s+defaultService\b|export\s+function\s+init(?:Http|Transport)\b|__upstream/.test(src))throw new Error('隐式全局依赖：'+file);}
buildContextDocs(root,{check:true});checkVersion(root);buildStatic(root,{check:true});syncExample(root,{check:true});
for(const name of ['index.html','panel.bundle.js','style.css','sw.js','manifest.webmanifest','icon.svg']){const file=path.join(root,'public',name),raw=fs.readFileSync(file);if(!zlib.brotliDecompressSync(fs.readFileSync(file+'.br')).equals(raw)||!zlib.gunzipSync(fs.readFileSync(file+'.gz')).equals(raw))throw new Error('预压缩资源不一致：'+name);}
console.log('CHECK PASS：'+count+' 个脚本语法，版本/构建/预压缩/配置一致，零运行时依赖，无默认服务单例。');
