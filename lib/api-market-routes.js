import {randomUUID} from 'node:crypto';
import {createTaskQueue} from './task-queue.js';
import {marketStatus,tradingCalendar,parseCalendarQuery} from './market-calendar-api.js';
import {parseContextQuery} from './context-query.js';
import {requireScopes} from './api-keys.js';
import {quotaHeaders} from './api-rate-limit.js';
import {createApiQuoteStream} from './api-quote-stream.js';
import {send} from './http-response.js';
import {contextError} from './api-error.js';
import {semanticEtag,etagMatches,lifecycleHeaders,authenticatedCors} from './api-representation.js';
export const MARKET_AUX_PATHS=new Set(['/api/v1/market-status','/api/v1/trading-calendar','/api/v1/movers','/api/v1/quote-stream','/api/v1/capabilities']);
const parameters=params=>{const out={};for(const [k,v] of params){if(Object.hasOwn(out,k))throw contextError('BAD_CONTEXT_QUERY');out[k]=v;}return out;};
export function parseMoversQuery(q){
 if(Object.keys(q).some(k=>!['market','range','top'].includes(k))||q.market&&q.market!=='us'||q.range&&q.range!=='1d'||q.top!==undefined&&!/^\d+$/.test(String(q.top)))throw contextError('BAD_CONTEXT_QUERY');
 const top=Number(q.top??10);if(!Number.isInteger(top)||top<1||top>50)throw contextError('BAD_CONTEXT_QUERY');return {market:q.market||'us',range:'1d',top};
}
export function createMarketAuxRoutes({keys,limiter,engine,advanced,budget,now=Date.now,lifecycle={}}={}){
 const stream=createApiQuoteStream({engine,keys,budget,now}),queue=createTaskQueue({maxActive:1,maxQueued:2,now});let lifetime=new AbortController();
 async function handle(req,res,url,cors={}){
  const requestId=randomUUID(),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-cache','X-Request-Id':requestId,...lifecycleHeaders(lifecycle),...authenticatedCors(cors),
   'Access-Control-Expose-Headers':'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, ETag, X-API-Key-Status, X-Key-Expires-At'};
  const fail=(code,status=503)=>send(req,res,status,{...headers,'Cache-Control':'no-store',...(status===429||status===503?{'Retry-After':'5'}:{})},JSON.stringify({schema_version:1,request_id:requestId,status:'unavailable',error:{code,message:code}}));
  if(req.method==='OPTIONS'){send(req,res,204,{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Authorization, If-None-Match, Last-Event-ID'},'');return;}
  if(!['GET','HEAD'].includes(req.method)||url.pathname.endsWith('quote-stream')&&req.method!=='GET'){fail('METHOD_NOT_ALLOWED',405);return;}
  const c=new AbortController(),timer=setTimeout(()=>c.abort(contextError('CONTEXT_TIMEOUT',503)),15000);const signal=AbortSignal.any([c.signal,lifetime.signal]);
  const cancel=()=>{if(!res.writableEnded)c.abort(contextError('REQUEST_CANCELLED',499));};res.once('close',cancel);
  try{
   const principal=keys.authenticate(req),q=parameters(url.searchParams),path=url.pathname;let normalized=q,scopes=['quote-only'],cost=1;
   if(path.endsWith('market-status'))normalized=parseCalendarQuery(q);
   else if(path.endsWith('trading-calendar')){normalized=parseCalendarQuery(q,'calendar');scopes=['history'];}
   else if(path.endsWith('movers'))normalized=parseMoversQuery(q);
   else if(path.endsWith('quote-stream')){
    if(Object.keys(q).some(k=>k!=='symbols')||!q.symbols)throw contextError('BAD_CONTEXT_QUERY');normalized=parseContextQuery({symbols:q.symbols.split(','),include:['quote']});cost=normalized.symbols.length;
   }else if(Object.keys(q).length)throw contextError('BAD_CONTEXT_QUERY');
   requireScopes(principal,scopes);const quota=limiter.consume(cost,principal.family);Object.assign(headers,quotaHeaders(quota));
   if(!quota.ok){send(req,res,429,{...headers,'Retry-After':String(quota.retryAfter),'Cache-Control':'no-store'},JSON.stringify({schema_version:1,request_id:requestId,status:'unavailable',error:{code:'CONTEXT_RATE_LIMITED',message:'查询额度不足。'}}));return;}
   if(principal.status==='rotating'){headers['X-API-Key-Status']='rotating';headers['X-Key-Expires-At']=new Date(principal.expiresAt).toISOString();}
   if(path.endsWith('quote-stream')){clearTimeout(timer);stream.open(req,res,normalized.symbols,principal,headers);return;}
   let result;
   if(path.endsWith('market-status'))result=marketStatus(normalized,{now:now()});
   else if(path.endsWith('trading-calendar'))result=tradingCalendar(normalized);
   else if(path.endsWith('capabilities'))result={schema_version:1,status:'complete',data:advanced?.capabilities?.()||{},limits:{symbols:10,window_units:20,window_seconds:60,burst_requests:3,request_bytes:8192,response_bytes:2097152},scopes:principal.scopes};
   else result=await queue.run(s=>advanced?.movers?advanced.movers(normalized,{signal:s}):Promise.reject(contextError('MARKET_DATA_NOT_CONFIGURED',503)),{signal});
   result={...result,request_id:requestId};const body=JSON.stringify(result);if(Buffer.byteLength(body)>2097152)throw contextError('RESULT_TOO_LARGE',422);
   headers.ETag=semanticEtag(result);if(etagMatches(req.headers['if-none-match'],headers.ETag)){send(req,res,304,headers,'');return;}
   send(req,res,200,headers,body);
  }catch(e){if(res.headersSent){res.destroy();return;}if(!res.destroyed)fail(/^(?:BAD_CONTEXT_QUERY|UNAUTHORIZED|KEY_ROTATED|KEY_EXPIRED|INSUFFICIENT_SCOPE|MARKET_DATA_NOT_CONFIGURED|SOURCE_[A-Z_]+|RESULT_TOO_LARGE|CONTEXT_[A-Z_]+|CALENDAR_OUTSIDE_COVERAGE|STOPPED)$/.test(e.code||'')?e.code:'SOURCE_UNAVAILABLE',e.statusCode||503);}
  finally{clearTimeout(timer);res.off('close',cancel);}
 }
 return {handle,close(){lifetime.abort(contextError('STOPPED',503));queue.close();stream.close();},reopen(){if(lifetime.signal.aborted)lifetime=new AbortController();queue.reopen();},diagnostics:()=>({queue:queue.diagnostics(),stream:stream.diagnostics()})};
}
