// Static inventory, not a claim of exhaustive semantic or formal verification.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {sourceFiles} from './files.mjs';
const root=path.resolve(process.argv[2]||'.');
const runtime=sourceFiles(root).filter(file=>/\.(?:js|mjs)$/.test(file)&&(/^(?:lib\/|public\/modules\/)/.test(file)||['app.js','server.js','config.js','mkt.mjs','log.mjs','sent.mjs','public/app.js'].includes(file)));
const files=runtime.map(file=>{const raw=fs.readFileSync(path.join(root,file)),text=raw.toString('utf8');return {path:file,lines:text.split('\n').length-1,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),imports:[...text.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)].map(m=>m[1])};});
const graph=new Map(files.map(file=>[file.path,file.imports.filter(v=>v.startsWith('.')).map(v=>path.posix.normalize(path.posix.join(path.posix.dirname(file.path),v)))]));
const visited=new Set(),active=new Set(),cycles=[];
function visit(file,chain=[]){if(active.has(file)){cycles.push([...chain.slice(chain.indexOf(file)),file]);return;}if(visited.has(file)||!graph.has(file))return;active.add(file);for(const child of graph.get(file))visit(child,[...chain,file]);active.delete(file);visited.add(file);}
for(const file of graph.keys())visit(file);
console.log(JSON.stringify({scope:'production source modules excluding generated bundles; static ES imports only, not dynamic or window dependency analysis',files:files.length,lines:files.reduce((n,f)=>n+f.lines,0),bytes:files.reduce((n,f)=>n+f.bytes,0),staticImportCycles:cycles,entries:files},null,2));
