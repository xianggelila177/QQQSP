import {adminAuthorized} from './http-auth.js';
import {readJsonBody} from './api-body.js';
import {send} from './http-response.js';
import {contextError} from './api-error.js';
export function createKeyAdminHandler({keys,token='',origin=''}={}){
 let active=0;
 return async(req,res)=>{
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  const fail=(code,status)=>send(req,res,status,headers,JSON.stringify({status:'unavailable',error:{code}}));
  if(!['GET','POST'].includes(req.method)){fail('METHOD_NOT_ALLOWED',405);return;}
  if(!token||!adminAuthorized(req,token)){req.resume();fail('ADMIN_AUTH_REQUIRED',403);return;}
  if(req.headers.origin){let same=false;try{same=new URL(req.headers.origin).host===req.headers.host;}catch{}
   if(!same&&req.headers.origin!==origin){req.resume();fail('ORIGIN_NOT_ALLOWED',403);return;}}
  if(req.method==='GET'){send(req,res,200,headers,JSON.stringify(keys.list()));return;}
  if(!/^application\/json(?:\s*;.*)?$/i.test(String(req.headers['content-type']||''))||req.headers['content-encoding']){req.resume();fail('UNSUPPORTED_MEDIA_TYPE',415);return;}
  if(active>=2){req.resume();fail('ADMIN_BUSY',503);return;}
  active++;const c=new AbortController(),timer=setTimeout(()=>c.abort(contextError('CONTEXT_TIMEOUT',503)),10000);
  const close=()=>{if(!res.writableEnded)c.abort(contextError('REQUEST_CANCELLED',499));};res.once('close',close);
  try{const input=await readJsonBody(req,c.signal);c.signal.throwIfAborted();const out=await keys.mutate(input);send(req,res,200,headers,JSON.stringify(out));}
  catch(e){if(!res.destroyed)fail(/^KEY_|^BAD_KEY_|^BODY_TOO_|^BAD_JSON|^CONTEXT_|^REQUEST_/.test(e.code||'')?e.code:'KEY_OPERATION_FAILED',e.statusCode||500);}
  finally{active--;clearTimeout(timer);res.off('close',close);}
 };
}
