import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

async function treeBytes(directory){
  let bytes=0;
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())continue; // shared/state and shared/logs are never traversed.
    if(entry.isDirectory())bytes+=await treeBytes(file);
    else if(entry.isFile())bytes+=(await fs.stat(file)).size;
  }
  return bytes;
}
export async function pruneReleases(root,{keepOld=3,maxBytes=536870912,dryRun=false}={}){
  if(!Number.isInteger(keepOld)||keepOld<0||keepOld>20||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Invalid release retention');
  const releases=path.resolve(root,'releases'),protectedPaths=new Set();
  for(const name of ['current','previous']){
    let target;try{target=await fs.realpath(path.join(root,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(path.dirname(target)!==releases)throw new Error(name+' does not reference an owned release');
    protectedPaths.add(target);
  }
  const list=[];
  for(const item of await fs.readdir(releases,{withFileTypes:true})){
    if(!item.isDirectory()||item.isSymbolicLink())continue;
    const file=path.join(releases,item.name),stat=await fs.lstat(file);
    list.push({path:file,modified:stat.mtimeMs,bytes:await treeBytes(file),protected:protectedPaths.has(file)});
  }
  list.sort((a,b)=>b.modified-a.modified||b.path.localeCompare(a.path));
  const optional=list.filter(x=>!x.protected),remove=new Set(optional.slice(keepOld));
  let bytes=list.filter(x=>!remove.has(x)).reduce((n,x)=>n+x.bytes,0);
  for(const entry of optional.slice(0,keepOld).reverse())if(bytes>maxBytes){remove.add(entry);bytes-=entry.bytes;}
  if(!dryRun)for(const entry of remove)await fs.rm(entry.path,{recursive:true});
  return {kept:list.filter(x=>!remove.has(x)).map(x=>x.path),removed:[...remove].map(x=>x.path),bytes,maxBytes,budgetExceeded:bytes>maxBytes,dryRun};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [root,keep='3',budget='536870912']=process.argv.slice(2);if(!root)throw new Error('Usage: node ops/prune-releases.mjs ROOT [KEEP_OLD] [MAX_BYTES]');console.log(JSON.stringify(await pruneReleases(root,{keepOld:Number(keep),maxBytes:Number(budget)})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
