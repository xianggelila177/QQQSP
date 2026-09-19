import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {send} from './http-response.js';
import {parseContextQuery,contextError} from './market-context-service.js';
export const CONTEXT_PATH='/api/v1/market-context';
const BODY_LIMIT=8192,RESPONSE_LIMIT=2*1024*1024;
const messages={UNAUTHORIZED:'A dedicated read-only API key is required.',BAD_CONTEXT_QUERY:'Invalid query. Check symbol, include and supported ranges.',BAD_JSON:'Request must contain valid JSON.',BODY_TOO_LARGE:'Request body exceeds 8 KiB.',UNSUPPORTED_MEDIA_TYPE:'Content-Type must be application/json without Content-Encoding.',CONTEXT_RATE_LIMITED:'Rate limit exceeded. Honor Retry-After.',CONTEXT_BUSY:'Query capacity exhausted. Try again later.',CONTEXT_TIMEOUT:'Query deadline expired while waiting.',STOPPED:'Service is stopping.',RESULT_TOO_LARGE:'Response exceeds 2 MiB. Reduce include, daily_bar_count or sample_trading_days.',SOURCE_UNAVAILABLE:'Requested data is currently unavailable.',METHOD_NOT_ALLOWED:'Use POST for this read-only query.',INTERNAL_ERROR:'Unable to assemble the requested data.'};
export function createContextLimiter({now=()=>performance.now()}={}){
 let tokens=3,at=now(),accepted=[];
 return {consume(){const time=now();tokens=Math.min(3,tokens+Math.max(0,time-at)/3000);at=time;accepted=accepted.filter(t=>t>time-60000);
  const wait=Math.max(accepted.length>=20?accepted[0]+60000-time:0,tokens<1?(1-tokens)*3000:0);
  if(wait>0)return {ok:false,retryAfter:Math.max(1,Math.ceil(wait/1000))};tokens--;accepted.push(time);return {ok:true};
 }};
}
function readBody(req,signal){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,done=false;
  const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);signal.removeEventListener('abort',abort);};
  const finish=(e,value)=>{if(done)return;done=true;cleanup();if(e){req.resume();reject(e);}else resolve(value);};
  const data=chunk=>{bytes+=chunk.length;if(bytes>BODY_LIMIT)finish(contextError('BODY_TOO_LARGE',413));else chunks.push(chunk);};
  const end=()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(contextError('BAD_JSON'));}};
  const error=()=>finish(contextError('REQUEST_CANCELLED',499)),abort=()=>finish(signal.reason);
  req.on('data',data);req.once('end',end);req.once('error',error);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
}
export function createMarketContextHttp({service,apiKey='',clock=()=>performance.now()}={}){
 const digest=value=>createHash('sha256').update(value).digest(),expected=digest(apiKey),limiter=createContextLimiter({now:clock});
 return async function handle(req,res,cors={}){
  const requestId=randomUUID(),startedAt=clock(),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId,...cors};
  const fail=(code,status,extra={})=>send(req,res,status,{...headers,...extra},JSON.stringify({schema_version:1,request_id:requestId,status:'unavailable',error:{code,message:messages[code]||messages.INTERNAL_ERROR}}));
  if(req.method==='OPTIONS'){send(req,res,204,{...headers,Allow:'POST, OPTIONS','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'},'');return;}
  if(req.method!=='POST'){fail('METHOD_NOT_ALLOWED',405,{Allow:'POST, OPTIONS'});return;}
  const auth=String(req.headers.authorization||''),match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth);
  const duplicate=(req.rawHeaders||[]).filter((x,i)=>i%2===0&&x.toLowerCase()==='authorization').length>1;
  if(!apiKey||!match||duplicate||!timingSafeEqual(expected,digest(match?.[1]||''))){req.resume();fail('UNAUTHORIZED',401,{'WWW-Authenticate':'Bearer realm="market-context"'});return;}
  const type=String(req.headers['content-type']||'');
  if(!/^application\/json(?:\s*;.*)?$/i.test(type)||req.headers['content-encoding']){req.resume();fail('UNSUPPORTED_MEDIA_TYPE',415);return;}
  if(Number(req.headers['content-length']||0)>BODY_LIMIT){req.resume();fail('BODY_TOO_LARGE',413);return;}
  const quota=limiter.consume();if(!quota.ok){req.resume();fail('CONTEXT_RATE_LIMITED',429,{'Retry-After':String(quota.retryAfter)});return;}
  const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort(contextError('REQUEST_CANCELLED',499));};
  res.once('close',cancel);
  const bodyTimer=setTimeout(()=>controller.abort(contextError('CONTEXT_TIMEOUT',503)),15000);
  try{
   const query=parseContextQuery(await readBody(req,controller.signal));clearTimeout(bodyTimer);
   const out=await service.query(query,{signal:controller.signal,requestId,startedAt});
   const body=JSON.stringify(out);if(Buffer.byteLength(body)>RESPONSE_LIMIT){fail('RESULT_TOO_LARGE',422);return;}
   send(req,res,out.status==='unavailable'?503:200,{...headers,...(out.status==='unavailable'?{'Retry-After':'5'}:{})},body);
  }catch(error){
   if(res.destroyed)return;
   const code=Object.hasOwn(messages,error.code)?error.code:'INTERNAL_ERROR';
   const status=code==='INTERNAL_ERROR'?500:error.statusCode||503;
   fail(code,status,status===503?{'Retry-After':'5'}:{});
  }finally{clearTimeout(bodyTimer);res.off('close',cancel);}
 };
}
