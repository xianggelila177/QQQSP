import {readFile,writeFile,rename,unlink,open,stat} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const API='https://api.schwabapi.com';
const failure=(code,retryAt=0)=>Object.assign(new Error('Schwab source unavailable: '+code),{code,retryAt,statusCode:503});

// A single owner refreshes the token. No upstream body, URL with credentials,
// token, or filesystem error is exposed by diagnostics or errors.
export function createSchwabClient({envFile,tokenFile,now=Date.now,fetchImpl=fetch,minGapMs=750}={}){
  let refreshJob=null,next=0,active=0,closed=false,controller=new AbortController();
  let status='not-checked',retryAt=0,lastSuccessAt=null,requests=0,refreshes=0,expiresAt=null;
  const denied=new Map();
  async function readToken(){
    try{const raw=JSON.parse(await readFile(tokenFile,'utf8'));return raw.token?{...raw.token,created_at:raw.creation_timestamp}:raw;}
    catch{throw failure('SCHWAB_AUTH_REQUIRED',now()+60000);}
  }
  async function jsonResponse(response){
    const reader=response.body?.getReader();if(!reader)throw failure('SCHWAB_BAD_RESPONSE');
    let bytes=0;const chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024)throw failure('SCHWAB_RESPONSE_TOO_LARGE');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('SCHWAB_BAD_RESPONSE');}
  }
  const expiry=t=>Number(t.expires_at_ms)||(Number(t.expires_at)||0)*1000||0;
  async function refresh(rejectedToken){
    if(refreshJob)return refreshJob;
    refreshJob=(async()=>{
      let lock,temp;
      try{
        // An abandoned lock can only be reclaimed after the bounded request has expired.
        try{lock=await open(tokenFile+'.lock','wx',0o600);}
        catch(e){if(e.code!=='EEXIST')throw failure('SCHWAB_TOKEN_STORAGE');
          const s=await stat(tokenFile+'.lock');if(now()-s.mtimeMs>120000){await unlink(tokenFile+'.lock');lock=await open(tokenFile+'.lock','wx',0o600);}
          else throw failure('SCHWAB_REFRESH_BUSY',now()+1000);}
        const old=await readToken();
        if(expiry(old)>now()+120000&&(!rejectedToken||old.access_token!==rejectedToken))return old;
        if(!old.refresh_token)throw failure('SCHWAB_AUTH_REQUIRED',now()+300000);
        let credentials;try{credentials=parseEnv(await readFile(envFile,'utf8'));}catch{throw failure('SCHWAB_CONFIG_MISSING',now()+60000);}
        if(!credentials.SCHWAB_CLIENT_ID||!credentials.SCHWAB_CLIENT_SECRET)throw failure('SCHWAB_CONFIG_MISSING',now()+60000);
        const r=await fetchImpl(API+'/v1/oauth/token',{method:'POST',redirect:'error',
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)]),
          headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(credentials.SCHWAB_CLIENT_ID+':'+credentials.SCHWAB_CLIENT_SECRET).toString('base64')},
          body:new URLSearchParams({grant_type:'refresh_token',refresh_token:old.refresh_token})});
        const data=await jsonResponse(r);
        if(!r.ok)throw failure(data.error==='invalid_grant'?'SCHWAB_AUTH_REQUIRED':'SCHWAB_REFRESH_FAILED',now()+300000);
        if(typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(data.expires_in)||data.expires_in<=0)
          throw failure('SCHWAB_BAD_TOKEN_RESPONSE',now()+60000);
        const updated={...old,...data,refresh_token:data.refresh_token||old.refresh_token,
          created_at:old.created_at||null,refreshed_at_ms:now(),expires_at_ms:now()+data.expires_in*1000};
        temp=tokenFile+'.'+process.pid+'.tmp';
        await writeFile(temp,JSON.stringify(updated)+'\n',{mode:0o600,flag:'wx'});
        const file=await open(temp,'r+');try{await file.sync();}finally{await file.close();}
        await rename(temp,tokenFile);temp=null;refreshes++;expiresAt=updated.expires_at_ms;return updated;
      }finally{if(temp)await unlink(temp).catch(()=>{});if(lock){await lock.close();await unlink(tokenFile+'.lock').catch(()=>{});}}
    })().finally(()=>{refreshJob=null;});
    return refreshJob;
  }
  async function access(rejectedToken){
    const token=await readToken();expiresAt=expiry(token)||null;
    return !token.access_token||expiry(token)<=now()+120000||token.access_token===rejectedToken?refresh(rejectedToken):token;
  }
  async function request(path,{signal}={}){
    if(!/^\/(quotes|pricehistory)\?/.test(path))throw failure('SCHWAB_PATH_UNSUPPORTED');
    if(closed)throw failure('STOPPED');
    const family=path.split('?')[0];
    if(retryAt>now())throw failure(status,retryAt);
    if((denied.get(family)||0)>now())throw failure('SCHWAB_DATASET_DENIED',denied.get(family));
    if(active>=8)throw failure('SCHWAB_QUEUE_FULL',now()+1000);
    active++;
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(10000),...(signal?[signal]:[])]);
    try{
      let token=await access();
      for(let attempt=0;attempt<2;attempt++){
        const wait=Math.max(0,next-now());next=Math.max(next,now())+minGapMs;
        if(wait)await delay(wait,null,{signal:combined});
        combined.throwIfAborted();requests++;
        const r=await fetchImpl(API+'/marketdata/v1'+path,{redirect:'error',signal:combined,
          headers:{Accept:'application/json',Authorization:'Bearer '+token.access_token}});
        if(r.status===401){await r.body?.cancel();if(!attempt){token=await access(token.access_token);continue;}
          throw failure('SCHWAB_AUTH_REQUIRED',now()+300000);}
        if(r.status===429){const h=r.headers.get('retry-after'),seconds=Number(h);
          const until=h&&Number.isFinite(seconds)?now()+seconds*1000:Date.parse(h);
          await r.body?.cancel();throw failure('SCHWAB_RATE_LIMITED',Math.max(now()+60000,until||0));}
        if(r.status===403){await r.body?.cancel();denied.set(family,now()+300000);throw failure('SCHWAB_DATASET_DENIED');}
        if(!r.ok){await r.body?.cancel();throw failure('SCHWAB_HTTP_'+r.status,now()+30000);}
        const data=await jsonResponse(r);lastSuccessAt=now();status='ready';retryAt=0;return data;
      }
    }catch(e){
      if(signal?.aborted)throw signal.reason;
      const error=e.code?.startsWith('SCHWAB_')?e:failure(closed?'STOPPED':'SCHWAB_NETWORK',now()+30000);
      status=error.code;retryAt=error.retryAt||0;throw error;
    }finally{active--;}
  }
  return {request,diagnostics:()=>({enabled:true,status,retryAt,lastSuccessAt,requests,refreshes,expiresAt,active,reauthorizationRequired:status==='SCHWAB_AUTH_REQUIRED'}),
    close(){closed=true;controller.abort();},reopen(){if(closed){closed=false;controller=new AbortController();}}};
}
