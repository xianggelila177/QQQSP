import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {send} from './http-response.js';
import {parseContextQuery,contextFromSearch} from './context-query.js';
import {contextError} from './api-error.js';
import {createContextLimiter,quotaHeaders} from './api-rate-limit.js';
import {createApiKeys,requireScopes} from './api-keys.js';
import {readJsonBody} from './api-body.js';
import {semanticEtag,etagMatches,encodeCsv,lifecycleHeaders,authenticatedCors} from './api-representation.js';
export {createContextLimiter} from './api-rate-limit.js';
export const CONTEXT_PATH='/api/v1/market-context';
const RESPONSE_LIMIT=2*1024*1024;
const messages={UNAUTHORIZED:'需要有效的独立只读密钥。',KEY_ROTATED:'旧密钥的24小时轮换宽限期已结束。',KEY_EXPIRED:'密钥已到期。',INSUFFICIENT_SCOPE:'密钥权限不足。',BAD_CONTEXT_QUERY:'参数无效，请检查证券代码、分区及范围。',BAD_JSON:'请求必须是合法的UTF-8 JSON。',BODY_TOO_LARGE:'请求正文超过8 KiB。',UNSUPPORTED_MEDIA_TYPE:'Content-Type必须为application/json，且不支持Content-Encoding。',CONTEXT_RATE_LIMITED:'查询额度不足，请遵循Retry-After。',CONTEXT_BUSY:'执行或正文读取容量已满。',CONTEXT_TIMEOUT:'查询预算已到期。',STOPPED:'服务正在停止。',RESULT_TOO_LARGE:'响应超过2 MiB，请减小查询范围。',CSV_METADATA_TOO_LARGE:'CSV元数据过大，请使用JSON或缩小范围。',SOURCE_UNAVAILABLE:'请求的数据暂不可用。',METHOD_NOT_ALLOWED:'请求方法不受支持。',PRECONDITION_FAILED:'条件请求不满足；304仅用于GET/HEAD。',INTERNAL_ERROR:'数据组装失败。'};
export function createMarketContextHttp({service,apiKey='',clock=()=>performance.now(),now=Date.now,parseQuery=parseContextQuery,scopeQuery=value=>value,schemaVersion=1,limiter:sharedLimiter,keys:sharedKeys,bodyBudget={active:0},allowGet=false,lifecycle={}}={}){
 const limiter=sharedLimiter||createContextLimiter({now:clock,wallNow:now}),keys=sharedKeys||createApiKeys({apiKey,now});
 return async function handle(req,res,cors={}){
  const requestId=randomUUID(),startedAt=clock(),safe=['GET','HEAD'].includes(req.method);
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':safe?'private, no-cache':'no-store','X-Request-Id':requestId,...lifecycleHeaders(lifecycle),...authenticatedCors(cors),
   'Access-Control-Expose-Headers':'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Burst-Remaining, Retry-After, ETag, X-API-Key-Status, X-Key-Expires-At, X-QQQSP-Metadata, X-QQQSP-Metadata-Encoding, Deprecation, Sunset, Link'};
  const fail=(code,status,extra={})=>send(req,res,status,{...headers,...extra,'Cache-Control':'no-store'},JSON.stringify({schema_version:schemaVersion,request_id:requestId,status:'unavailable',error:{code,message:messages[code]||messages.INTERNAL_ERROR}}));
  const methods=allowGet?'GET, HEAD, POST, OPTIONS':'POST, OPTIONS';
  if(req.method==='OPTIONS'){send(req,res,204,{...headers,Allow:methods,'Access-Control-Allow-Methods':methods,'Access-Control-Allow-Headers':'Content-Type, Authorization, If-None-Match'},'');return;}
  if(req.method!=='POST'&&!(safe&&allowGet)){fail('METHOD_NOT_ALLOWED',405,{Allow:methods});return;}
  let principal;
  try{principal=keys.authenticate(req);}catch(e){req.resume();fail(e.code,e.statusCode,{'WWW-Authenticate':'Bearer realm="market-context"'});return;}
  if(principal.status==='rotating'){headers['X-API-Key-Status']='rotating';headers['X-Key-Expires-At']=new Date(principal.expiresAt).toISOString();}
  if(!safe&&(!/^application\/json(?:\s*;.*)?$/i.test(String(req.headers['content-type']||''))||req.headers['content-encoding'])){req.resume();fail('UNSUPPORTED_MEDIA_TYPE',415);return;}
  if(Number(req.headers['content-length']||0)>8192){req.resume();fail('BODY_TOO_LARGE',413);return;}
  if(bodyBudget.active>=6){req.resume();fail('CONTEXT_BUSY',503,{'Retry-After':'1'});return;}
  bodyBudget.active++;
  const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort(contextError('REQUEST_CANCELLED',499));};res.once('close',cancel);
  const timer=setTimeout(()=>controller.abort(contextError('CONTEXT_TIMEOUT',503)),15000);let reading=true;
  try{
   if(safe&&(Number(req.headers['content-length']||0)>0||req.headers['transfer-encoding']))throw contextError('BAD_CONTEXT_QUERY');
   const query=safe?contextFromSearch(new URL(req.url,'http://local').searchParams):parseQuery(await readJsonBody(req,controller.signal));
   reading=false;bodyBudget.active--;clearTimeout(timer);
   const normalized=scopeQuery(query);requireScopes(principal,normalized.include||['quote','fundamentals']);
   const quota=limiter.consume(normalized.symbols?.length||1,principal.family);Object.assign(headers,quotaHeaders(quota));
   if(!quota.ok){fail('CONTEXT_RATE_LIMITED',429,{'Retry-After':String(quota.retryAfter)});return;}
   const out=await service.query(query,{signal:controller.signal,requestId,startedAt});
   const json=JSON.stringify(out);if(Buffer.byteLength(json)>RESPONSE_LIMIT)throw contextError('RESULT_TOO_LARGE',422);
   // Authorization is always checked before a cache hit; no public/shared caching.
   const tag=semanticEtag(out);if(safe)headers.ETag=tag;
   if(out.status!=='unavailable'&&etagMatches(req.headers['if-none-match'],tag)){
    if(safe)send(req,res,304,headers,'');else fail('PRECONDITION_FAILED',412);return;
   }
   let body=json;
   if(query.format==='csv'&&out.status!=='unavailable'){const csv=encodeCsv(out);body=csv.body;Object.assign(headers,csv.headers);if(Buffer.byteLength(body)>RESPONSE_LIMIT)throw contextError('RESULT_TOO_LARGE',422);}
   send(req,res,out.status==='unavailable'?503:200,{...headers,...(out.status==='unavailable'?{'Retry-After':'5','Cache-Control':'no-store'}:{})},body);
  }catch(error){
   if(res.destroyed)return;
   const code=Object.hasOwn(messages,error.code)?error.code:'INTERNAL_ERROR',status=code==='INTERNAL_ERROR'?500:error.statusCode||503;
   fail(code,status,status===503?{'Retry-After':'5'}:{});
  }finally{if(reading)bodyBudget.active--;clearTimeout(timer);res.off('close',cancel);}
 };
}
