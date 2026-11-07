import {randomBytes,randomUUID} from 'node:crypto';
import {readSchwabToken,atomicSchwabJson,withSchwabTokenLock,schwabFailure} from './schwab-token-store.js';

export const SCHWAB_RENEW_AFTER_MS=6*86400000;
export const SCHWAB_AUTH_LIFETIME_ESTIMATE_MS=7*86400000;
export function createSchwabAuthorization(credentials){
  let redirect;
  try{redirect=new URL(credentials.SCHWAB_REDIRECT_URI);}catch{throw schwabFailure('SCHWAB_REDIRECT_CONFIG');}
  if(redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.hash||redirect.search)throw schwabFailure('SCHWAB_REDIRECT_CONFIG');
  const state=randomBytes(32).toString('hex'),url=new URL('https://api.schwabapi.com/v1/oauth/authorize');
  url.search=new URLSearchParams({response_type:'code',client_id:credentials.SCHWAB_CLIENT_ID,redirect_uri:redirect.href,state});
  return {url:url.href,redirect:redirect.href,state};
}
export function parseSchwabCallback(value,authorization){
  let url;try{url=new URL(value);}catch{return null;}
  const target=new URL(authorization.redirect);
  if(url.origin!==target.origin||url.pathname!==target.pathname)return null;
  if(url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==authorization.state)throw schwabFailure('SCHWAB_AUTH_STATE_MISMATCH');
  if(url.searchParams.has('error'))throw schwabFailure('SCHWAB_AUTH_DENIED');
  const codes=url.searchParams.getAll('code');
  if(codes.length!==1||!codes[0]||codes[0].length>8192)throw schwabFailure('SCHWAB_AUTH_BAD_CALLBACK');
  return codes[0];
}
export async function exchangeSchwabAuthorization({code,authorization,credentials,tokenFile,now=Date.now,fetchImpl=fetch}){
  return withSchwabTokenLock(tokenFile,async()=>{
    const old=await readSchwabToken(tokenFile).catch(()=>({}));let response,data;
    try{
      response=await fetchImpl('https://api.schwabapi.com/v1/oauth/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
        headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(credentials.SCHWAB_CLIENT_ID+':'+credentials.SCHWAB_CLIENT_SECRET).toString('base64')},
        body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:authorization.redirect})});
      const reader=response.body.getReader(),parts=[];let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw new Error();parts.push(value);}}
      finally{await reader.cancel().catch(()=>{});}
      data=JSON.parse(Buffer.concat(parts).toString('utf8'));
    }catch{throw schwabFailure('SCHWAB_AUTH_EXCHANGE_FAILED');}
    if(!response.ok)throw schwabFailure('SCHWAB_AUTH_EXCHANGE_REJECTED');
    if(typeof data.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token||
      !Number.isFinite(data.expires_in)||data.expires_in<=0)throw schwabFailure('SCHWAB_BAD_TOKEN_RESPONSE');
    const at=now(),count=Number(old.qqqsp_authorization?.successful_authorizations)||0;
    const audit={authorized_at_ms:at,renew_at_ms:at+SCHWAB_RENEW_AFTER_MS,expires_at_estimate_ms:at+SCHWAB_AUTH_LIFETIME_ESTIMATE_MS,
      generation:randomUUID(),successful_authorizations:count+1};
    const updated={...data,created_at:at/1000,refreshed_at_ms:at,expires_at_ms:at+data.expires_in*1000,
      qqqsp_authorization:audit,...(old.qqqsp_refresh_audit?{qqqsp_refresh_audit:old.qqqsp_refresh_audit}:{})};
    await atomicSchwabJson(tokenFile,updated);
    return {authorizedAt:at,renewAt:audit.renew_at_ms,expiresAt:updated.expires_at_ms,
      authorizationExpiresAtEstimate:audit.expires_at_estimate_ms,successfulAuthorizations:count+1};
  },{now,waitMs:8000});
}
export function schwabRenewalDecision(token,state={},now=Date.now(),{force=false}={}){
  const raw=Number(token?.qqqsp_authorization?.authorized_at_ms)||(Number(token?.created_at)||0)*1000;
  const at=raw>0&&raw<=now?raw:0,renewAt=at?at+SCHWAB_RENEW_AFTER_MS:0;
  const base={authorizedAt:at,renewAt,authorizationExpiresAtEstimate:at?at+SCHWAB_AUTH_LIFETIME_ESTIMATE_MS:0};
  if(force)return {...base,action:'authorize'};
  if(!at)return {...base,action:'wait',status:'BOOTSTRAP_REQUIRED',requiresUserAction:true,nextAttemptAt:0};
  if(state.requiresUserAction&&state.authorizedAt===at)return {...base,action:'wait',status:state.status,requiresUserAction:true,nextAttemptAt:0};
  if(now<renewAt)return {...base,action:'wait',status:'READY',requiresUserAction:false,nextAttemptAt:renewAt};
  if(state.authorizedAt===at&&state.nextAttemptAt>now)return {...base,action:'wait',status:state.status,requiresUserAction:false,nextAttemptAt:state.nextAttemptAt};
  return {...base,action:'authorize'};
}
