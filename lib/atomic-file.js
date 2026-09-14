import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

// Parents are administrator-configured (including release/shared links). The
// destination itself must be a regular file; temporary files are exclusive.
export async function ensureParent(file) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
}
export async function atomicWriteFile(file,body) {
  await ensureParent(file);
  const inspect=async()=>fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const old=await inspect();
  if(old&&!old.isFile())throw Object.assign(new Error('State target must be a regular file, not a link'),{code:'UNSAFE_STATE_TARGET'});
  const temporary=file+'.'+process.pid+'.'+randomBytes(8).toString('hex')+'.tmp';
  let handle;
  try{
    handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(body);await handle.sync();await handle.close();handle=null;
    const current=await inspect();
    if(current&&!current.isFile()||!!old!==!!current||old&&current&&(old.ino!==current.ino||old.dev!==current.dev||old.mtimeMs!==current.mtimeMs))throw Object.assign(new Error('State target changed during write'),{code:'STATE_TARGET_CHANGED'});
    await fs.rename(temporary,file);
  }finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
