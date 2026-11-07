import {readFile,writeFile,open,rename,unlink,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

export const schwabFailure=(code,retryAt=0)=>Object.assign(new Error('Schwab source unavailable: '+code),{code,retryAt,statusCode:503});
export async function readSchwabToken(file){
  try{const raw=JSON.parse(await readFile(file,'utf8'));return raw.token?{...raw.token,created_at:raw.creation_timestamp}:raw;}
  catch{throw schwabFailure('SCHWAB_AUTH_REQUIRED');}
}
export async function readSchwabCredentials(file){
  try{const c=parseEnv(await readFile(file,'utf8'));
    if(!c.SCHWAB_CLIENT_ID||!c.SCHWAB_CLIENT_SECRET)throw new Error();return c;
  }catch{throw schwabFailure('SCHWAB_CONFIG_MISSING');}
}
export async function atomicSchwabJson(file,value){
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
    const handle=await open(temp,'r+');try{await handle.sync();}finally{await handle.close();}
    await rename(temp,file);
  }catch{throw schwabFailure('SCHWAB_TOKEN_STORAGE');}
  finally{await unlink(temp).catch(()=>{});}
}
// Browser interaction never holds this short transaction lock. Both ordinary
// refresh and authorization-code exchange acquire it for exchange + persistence.
export async function withSchwabTokenLock(file,action,{now=Date.now,waitMs=0}={}){
  const path=file+'.lock',deadline=Date.now()+waitMs;let lock;
  try{
    for(;;){
      try{lock=await open(path,'wx',0o600);break;}
      catch(error){
        if(error.code!=='EEXIST')throw schwabFailure('SCHWAB_TOKEN_STORAGE');
        const info=await stat(path).catch(()=>null);
        if(!info)continue;
        if(now()-info.mtimeMs>120000){await unlink(path).catch(()=>{});continue;}
        if(Date.now()>=deadline)throw schwabFailure('SCHWAB_REFRESH_BUSY',now()+1000);
        await delay(100);
      }
    }
    return await action();
  }finally{if(lock){await lock.close();await unlink(path).catch(()=>{});}}
}
export async function readSchwabRenewalState(file){
  try{
    const raw=JSON.parse(await readFile(file,'utf8')),out={};
    if(typeof raw.status==='string'&&/^[A-Z_]+$/.test(raw.status))out.renewalStatus=raw.status;
    for(const [input,output] of Object.entries({authorizedAt:'authorizationAt',renewAt:'renewAt',nextAttemptAt:'renewalNextAttemptAt',lastSuccessAt:'lastAuthorizationAt'}))
      if(Number.isFinite(raw[input]))out[output]=raw[input];
    if(typeof raw.requiresUserAction==='boolean')out.renewalRequiresUserAction=raw.requiresUserAction;
    return out;
  }catch{return {};}
}
