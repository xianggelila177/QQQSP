import {createApiKeys} from './api-keys.js';
import {createKeyAdminHandler} from './api-key-admin.js';
import {createMarketAuxRoutes,MARKET_AUX_PATHS} from './api-market-routes.js';
import {adminAuthorized} from './http-auth.js';
import {publicSourceHealth} from './source-health-public.js';
import {createMarketDetailService,parseDetailQuery,buildMarketDetail} from './market-detail.js';
import {buildMarketContext} from './market-context-format.js';
import {filterRecentNews,combineNewsQuality} from './news-policy.js';
import {METRIC_CATALOG} from './metric-catalog.js';
import {createMarketContextHttp,createContextLimiter,CONTEXT_PATH} from './market-context-http.js';
import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
// HTTP composition: request handlers consume explicit domain services.
// Infrastructure policies and state live in independently testable factories.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyMarket,marketKeyFor} from './instruments.js';
import {catalogSearch} from './catalog-search.js';
import {canonicalSearchQuery,equityDirectoryInfo} from './equity-directory.js';
import {canonicalSymbol} from './symbol-canonical.js';
import {futureInstrumentFor} from './futures-instruments.js';
import { marketDirectory } from './market-registry.js';
import {symbolValid} from './symbol-validation.js';
import {historyQuery,historyError} from './history-contract.js';
import {ALIAS,ALIAS_SYM,IDX_NAME} from './search.js';
import {createTelemetry} from '../log.mjs';
import {createStreamBudget} from './stream-budget.js';
import {createSse} from './sse.js';
import {createMacroSse} from './macro-sse.js';
import {createAdmission,boundedInt,safeError,withDeadline,settleWithin} from './http-admission.js';
import {send,createStaticService} from './http-response.js';
import {chartRevision,parseCv,applyChartVersions} from './http-charts.js';
import {UPSTREAM_ROLES,diskDiagnostics,createBusinessMonitor,quoteStatus} from './http-diagnostics.js';

export {chartRevision,symbolValid};
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAX_SYMBOLS=MAX_WATCHLIST_SYMBOLS;
function parseSymbols(raw,defaults,max=MAX_SYMBOLS) {
  if(raw==null) return {symbols:defaults.slice(0,max)};
  if(String(raw)==='') return {symbols:[]};
  const values=String(raw).split(',').map(canonicalSymbol);
  if(values.length>max) return {error:`at most ${max} symbols are allowed`};
  if(values.some(s=>!symbolValid(s))) return {error:'invalid symbol'};
  return {symbols:[...new Set(values)]};
}
const fallbackServices={classifyMarket,ALIAS,ALIAS_SYM,IDX_NAME};

export function createHttp(deps,options={}) {
  const env=options.env||{},now=options.now||(()=>Date.now());
  const telemetry=options.telemetry||createTelemetry();
  const services=Object.freeze({...fallbackServices,...deps});
  const symbols=(env.SYMBOLS||'QQQ,SPY').split(',').map(canonicalSymbol).filter(symbolValid).slice(0,MAX_SYMBOLS);
  const contextLimiter=createContextLimiter({wallNow:now});
  const apiKeys=createApiKeys({apiKey:env.LLM_API_KEY||'',file:env.LLM_KEY_STORE_PATH||'',now});
  const bodyBudget={active:0},lifecycle={deprecation:env.API_V1_DEPRECATION_AT||'',sunset:env.API_V1_SUNSET_AT||''};
  const keyAdmin=createKeyAdminHandler({keys:apiKeys,token:env.STATS_TOKEN||'',origin:env.PUBLIC_ORIGIN||''});
  const contextHandler=services.marketContext?createMarketContextHttp({service:services.marketContext,keys:apiKeys,limiter:contextLimiter,bodyBudget,allowGet:true,lifecycle,now}):null;
  const detailHandler=services.marketContext?createMarketContextHttp({service:createMarketDetailService(services.marketContext),keys:apiKeys,limiter:contextLimiter,bodyBudget,parseQuery:value=>{parseDetailQuery(value);return value;},scopeQuery:parseDetailQuery,schemaVersion:2,now}):null;
  const publicPath=options.publicPath||path.join(ROOT,'public');
  const requestDeadline=boundedInt(env.HTTP_REQUEST_DEADLINE_MS,20000,1,300000);
  const searchDeadline=boundedInt(env.HTTP_SEARCH_DEADLINE_MS,12000,1,300000);
  const admission=createAdmission({env,now});
  const historyAdmission=createAdmission({env:{...env,HTTP_ACTIVE_MAX:env.HTTP_HISTORY_ACTIVE_MAX??4,HTTP_QUEUE_MAX:env.HTTP_HISTORY_QUEUE_MAX??16},now});
  const quoteAdmission=createAdmission({env:{...env,HTTP_ACTIVE_MAX:env.HTTP_QUOTE_ACTIVE_MAX??8,HTTP_QUEUE_MAX:env.HTTP_QUOTE_QUEUE_MAX??16},now});
  const streamBudget=createStreamBudget({maxConnections:env.SSE_MAX_CONNECTIONS??32,maxBufferedBytes:env.SSE_MAX_BUFFER_BYTES??8388608});
  const marketAux=createMarketAuxRoutes({keys:apiKeys,limiter:contextLimiter,engine:services.engine,advanced:services.advancedMarketData,budget:streamBudget,now,lifecycle});
  const macroSse=deps.macroMonitor?createMacroSse({monitor:deps.macroMonitor,budget:streamBudget}):null;
  const sse=deps.engine?createSse({engine:deps.engine,historyPrewarm:deps.historyPrewarm,samples:deps.samples,now,budget:streamBudget}):null;
  async function runRequest(req,res,queue,ms,handler){
    const quota=queue.consume(req,queue===quoteAdmission?'snapshot':'expensive');
    if(!quota.ok){send(req,res,429,{'Content-Type':'application/json','Retry-After':String(quota.retryAfter)},JSON.stringify({code:'REQUEST_QUOTA_EXCEEDED'}));return;}
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableEnded)controller.abort(Object.assign(new Error('Client disconnected'),{code:'REQUEST_CANCELLED',statusCode:499}));};
    res.once('close',cancel);
    try{return await queue.run(handler,{signal:controller.signal,deadlineAt:now()+ms});}
    finally{res.removeListener('close',cancel);}
  }
  const monitor=createBusinessMonitor({symbols,now});
  const visitorMonitor=createBusinessMonitor({symbols:[],now});
  const staticService=createStaticService();
  const origin=env.PUBLIC_ORIGIN||'';
  let version='unknown';try{version=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();}catch{}
  let probeTimer=null,probeEpoch=0,probePending=false;
  const record=quotes=>{
    visitorMonitor.record(quotes);
    // Historical injected HTTP tests have no core probe. Production readiness
    // comes only from independent core probes, never visitor admission failures.
    if(options.monitorCore===false) monitor.record(quotes);
    telemetry.countQuoteOutcomes?.(quotes);
  };
  const businessState=()=>{
    if(!services.engine)return {...visitorMonitor.diagnostics(),ready:monitor.diagnostics().ready,core:monitor.diagnostics().core};
    const core=services.engine.read(services.engine.diagnostics().active,{lease:false}).map(q=>({symbol:q.symbol,...quoteStatus(q,now())}));
    const counts={ok:0,pending:0,stale:0,error:0};for(const q of core)counts[q.status]++;
    return {ready:core.length>0&&core.every(q=>q.usable),core,active:core.length,counts,usableRatio:core.length?counts.ok/core.length:0,oldestQuoteAgeMs:Math.max(0,...core.map(q=>q.ageMs||0))};
  };
  async function probeCore() {
    if(probePending) return;
    probePending=true;
    const epoch=probeEpoch;
    try {
      const quotes=await Promise.all(symbols.map(async symbol=>{
        try{return await withDeadline(Promise.resolve().then(()=>services.getCachedQuote(symbol)),requestDeadline);}
        catch(error){return {symbol,error:safeError(error.code||error.message)};}
      }));
      if(epoch===probeEpoch) monitor.record(quotes);
    } finally {probePending=false;}
  }
  function diagnostics() {
    return {version,business:businessState(),streams:streamBudget.diagnostics(),admission:{...admission.diagnostics(),quotes:quoteAdmission.diagnostics(),history:historyAdmission.diagnostics()}};
  }
  function healthPayload() {
    const upstream={};
    for(const [host,role] of Object.entries(UPSTREAM_ROLES)) {
      const recent=telemetry.recentUpstream(host);
      upstream[role]={role,host,...recent,status:!recent.calls?'idle':recent.errRate>0.5?'down':recent.errRate>0.1?'degraded':'ok'};
    }
    const disk=diskDiagnostics(env),business=businessState();
    return {ok:true,ready:!disk.critical,dataReady:business.ready,version,uptime:Math.round((now()-telemetry.stats.startedAt)/1000),services:upstream,business,disk};
  }
  async function newsResponse(req,res,url,cors,signal) {
    const parsed=parseSymbols(url.searchParams.get('symbols'),symbols,12);
    if(parsed.error) {send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
    const arr=parsed.symbols,out={},meta={};
    for(const symbol of arr) services.activateNews(symbol);
    const tasks=arr.map(symbol=>services.requestNews(symbol,{signal}));
    const results=await settleWithin(tasks,requestDeadline);
    for(let i=0;i<arr.length;i++) {
      const symbol=arr[i],result=results[i];
      if(result?.__error) {
        out[symbol]=[];meta[symbol]={updatedAt:null,stale:true,error:safeError(result.__error.code||result.__error.message)};
      } else {
        const checked=filterRecentNews(Array.isArray(result)?result:result?.items,now());
        out[symbol]=checked.items;
        const quality=combineNewsQuality(checked.quality,result?.quality);
        meta[symbol]={updatedAt:result?.updatedAt??null,stale:Boolean(result?.stale),quality:{policy:quality.policy,window_ms:quality.window_ms,rejected_items:quality.rejected_items},...(result?.error?{error:safeError(result.error)}:{})};
      }
    }
    const headers={'Content-Type':'application/json',...cors,'Cache-Control':'no-store','Access-Control-Expose-Headers':'X-News-Meta, X-News-Meta-Encoding'};
    if(Object.keys(meta).length) {headers['X-News-Meta']=Buffer.from(JSON.stringify(meta)).toString('base64url');headers['X-News-Meta-Encoding']='base64url-json';}
    send(req,res,200,headers,JSON.stringify(out));
  }
  async function searchResponse(req,res,url,cors,signal) {
    const q=canonicalSearchQuery(url.searchParams.get('q')||'').slice(0,80);
    if(!q) {send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},'[]');return;}
    const idx=services.ALIAS_SYM[q.toLowerCase()];
    let out=idx?[{symbol:idx,name:services.IDX_NAME[idx]||idx,exch:'Index',type:'INDEX',market:services.classifyMarket(idx,'','','INDEX')}]:[];
    const local=catalogSearch(q);out=out.concat(local);
    const more=url.searchParams.get('more')==='1';
    // Numeric local codes overlap across venues (9766 exists in JP/HK).
    // Keep the directory hit but still ask providers for other confirmed venues.
    const exactLocal=!/^\d{4,6}$/.test(q)&&(!!idx||local.some(x=>x.exact||x.matchType==='related'));
    const futuresQuery=local.length>0&&local.every(x=>x.type==='FUTURE');
    const yahooTerm=futuresQuery?(local.find(x=>x.symbol.endsWith('=F'))?.symbol||q):services.ALIAS[q.toLowerCase()]||q;
    const sources=exactLocal&&!more?[]:[
      ['yahoo',yahooTerm&&services.yahooSearch,()=>services.yahooSearch(yahooTerm,{signal})],
      ['tencent',!futuresQuery&&services.tencentSuggest,()=>services.tencentSuggest(q,{signal})],
      ['naver',!futuresQuery&&services.koreanSearch,()=>services.koreanSearch(q,{signal})],
      ['futures',services.futuresSearch,()=>services.futuresSearch(q,{signal})],
    ].filter(([,enabled])=>enabled);
    const results=await settleWithin(sources.map(([, ,load])=>Promise.resolve().then(load)),searchDeadline);
    const bySource=Object.fromEntries(sources.map(([id],i)=>[id,results[i]]));
    const {yahoo:ys,tencent:ts,naver:ks,futures:fs}=bySource;
    if(Array.isArray(fs))out=out.concat(fs);
    if(Array.isArray(ks))out=out.concat(ks);
    const ya=Array.isArray(ys)?ys.filter(x=>x&&x.symbol!==idx&&(!futuresQuery||x.type==='FUTURE')):[],tx=Array.isArray(ts)?ts.filter(x=>x&&x.symbol!==idx):[];
    const seen=new Set();out=out.concat(ya,tx).map(row=>({...row,symbol:canonicalSearchQuery(row.symbol).toUpperCase()})).filter(x=>symbolValid(x.symbol)&&
      (!(x.type==='INDEX'||x.symbol.startsWith('^'))||marketKeyFor(x.symbol))&&(x.type!=='FUTURE'||futureInstrumentFor(x.symbol))&&!seen.has(x.symbol)&&seen.add(x.symbol)).slice(0,60);
    const sourceStatus=Object.fromEntries(sources.map(([id],i)=>[id,Array.isArray(results[i])?{status:'available',count:results[i].length}:{status:'unavailable',code:/^[A-Z_]+$/.test(results[i]?.__error?.code||'')?results[i].__error.code:'SEARCH_SOURCE_UNAVAILABLE'}]));
    const failed=Object.values(sourceStatus).some(row=>row.status==='unavailable');
    const status=out.length?(failed?'partial':'available'):(failed?'unavailable':'empty');
    const metadata={status,sources:sourceStatus,directory:{...equityDirectoryInfo,count:equityDirectoryInfo.count},resultCount:out.length};
    send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store',
      'X-Search-Status':status,'X-Search-Meta':Buffer.from(JSON.stringify(metadata)).toString('base64url'),'X-Search-Meta-Encoding':'base64url-json',
      'Access-Control-Expose-Headers':'X-Search-Status, X-Search-Meta, X-Search-Meta-Encoding'},JSON.stringify(out));
  }
  async function historyResponse(req,res,url,cors,signal){
    try{
      const query=historyQuery(url.searchParams.get('symbol'),url.searchParams.get('period'),{count:url.searchParams.get('count')??url.searchParams.get('limit')??undefined,before:url.searchParams.get('before'),seriesId:url.searchParams.get('seriesId')});
      if(!symbolValid(query.symbol))throw historyError('BAD_HISTORY_QUERY','Invalid symbol');
      if(!services.history?.get)throw historyError('HISTORY_UNSUPPORTED','History service unavailable',503);
      const value=services.historyPrewarm?.read(query.symbol,query.period,query) || await services.history.get(query.symbol,query.period,{...query,signal});
      send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(value));
    }catch(error){
      const code=error.code||'HISTORY_SOURCE_UNAVAILABLE';
      const status=error.statusCode||(['RATE_LIMITED','HISTORY_RATE_LIMITED'].includes(code)?429:['HISTORY_TIMEOUT','DEADLINE_EXCEEDED','DEADLINE'].includes(code)?504:503);
      if(!res.destroyed)send(req,res,status,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store',...(error.retryAt?{'Retry-After':String(Math.max(1,Math.ceil((error.retryAt-now())/1000)))}:{})},JSON.stringify({schemaVersion:1,status:'error',code,error:safeError(error.message),...(error.retryAt?{retryAt:error.retryAt}:{})}));
    }
  }
  async function saveHistoryWatchlist(req,res,cors,signal){
    const requestOrigin=String(req.headers.origin||'');
    const host=String(req.headers.host||'');
    let sameOrigin=false;try{sameOrigin=new URL(requestOrigin).host===host;}catch{}
    if(requestOrigin&&!sameOrigin&&requestOrigin!==origin){send(req,res,403,{'Content-Type':'application/json',...cors},JSON.stringify({error:'origin not allowed'}));return;}
    if(!String(req.headers['content-type']||'').startsWith('application/json')){send(req,res,415,{'Content-Type':'application/json',...cors},JSON.stringify({error:'application/json required'}));return;}
    const parts=await new Promise((resolve,reject)=>{
      let bytes=0;const chunks=[];
      const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',fail);signal.removeEventListener('abort',abort);};
      const fail=error=>{cleanup();req.resume();reject(error);};
      const abort=()=>fail(signal.reason);
      const data=part=>{bytes+=part.length;if(bytes>4096){fail(Object.assign(new Error('watchlist too large'),{statusCode:413,code:'BODY_TOO_LARGE'}));return;}chunks.push(part);};
      const end=()=>{cleanup();resolve(chunks);};
      if(signal.aborted){reject(signal.reason);return;}
      req.on('data',data);req.once('end',end);req.once('error',fail);signal.addEventListener('abort',abort,{once:true});
    });
    let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:'invalid JSON'}));return;}
    if(!body||typeof body!=='object'||!Array.isArray(body.symbols)||body.symbols.some(s=>typeof s!=='string')||body.symbols.length>MAX_SYMBOLS){send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:'invalid watchlist'}));return;}
    const parsed=parseSymbols(body.symbols.join(','),[]);
    if(parsed.error){send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
    signal.throwIfAborted();services.historyPrewarm.retain(parsed.symbols);
    await services.historyPrewarm.persist();
    services.samples?.runDue();
    const status=services.historyPrewarm.status();send(req,res,status.saveError?503:200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(status));
  }
  async function marketResponse(req,res,url,cors) {
    let defaults;
    if(['/api/market','/api/quote'].includes(url.pathname)) defaults=symbols;
    else {const symbol=canonicalSymbol(url.pathname.slice(5).split(',')[0]);if(symbolValid(symbol))defaults=[symbol];}
    const raw=url.searchParams.get('symbols');
    if(!defaults && raw==null) {send(req,res,404,{'Content-Type':'text/plain',...cors},'Not found');return;}
    const parsed=parseSymbols(raw,defaults||symbols);
    if(parsed.error) {send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
    const quotes=await Promise.all(parsed.symbols.map(async symbol=>{
      try{return await withDeadline(Promise.resolve().then(()=>services.getCachedQuote(symbol)),requestDeadline);}
      catch(error){return {symbol,error:safeError(error.message),code:safeError(error.code||(error.statusCode&&`HTTP_${error.statusCode}`),'QUOTE_UNAVAILABLE')};}
    }));
    record(quotes);
    send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store','X-Server-Now-Ms':String(now())},JSON.stringify(applyChartVersions(quotes,parseCv(url.searchParams.get('cv')))));
  }
  const server=http.createServer(async(req,res)=>{
    const started=now();let url;
    try {url=new URL(req.url,`http://${req.headers.host||'127.0.0.1'}`);}
    catch {send(req,res,400,{'Content-Type':'application/json'},JSON.stringify({error:'bad request target'}));return;}
    const p=url.pathname;
    const cors={Vary:'Origin',...(origin&&String(req.headers.origin||'')===origin?{'Access-Control-Allow-Origin':origin}:{})};
    for(const [key,value] of Object.entries(cors))res.setHeader(key,value);
    res.on('finish',()=>{
      const ms=now()-started;telemetry.countReq(p,ms,res.statusCode);
      const quiet=['/api/market','/api/news','/api/macro','/healthz','/readyz'].includes(p)&&res.statusCode<400;
      (quiet?telemetry.log.debug:telemetry.log.info)('[req]',{m:req.method,p,st:res.statusCode,ms});
    });
    try {
      if(p==='/api/v2/market-detail'&&detailHandler){await detailHandler(req,res,cors);return;}
      if(p==='/api/admin/keys'){await runRequest(req,res,admission,requestDeadline,()=>keyAdmin(req,res));return;}
      if(MARKET_AUX_PATHS.has(p)){await marketAux.handle(req,res,url,cors);return;}
      if(p===CONTEXT_PATH&&contextHandler){await contextHandler(req,res,cors);return;}
      const length=Number(req.headers['content-length']||0);
      if(!Number.isFinite(length)||length>2*1024*1024) {send(req,res,413,{'Content-Type':'application/json',...cors},JSON.stringify({error:'request body too large'}));return;}
      if(req.method==='POST'&&p==='/api/history/watchlist'&&services.historyPrewarm){if(!adminAuthorized(req,env.STATS_TOKEN||'')){req.resume();send(req,res,401,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({code:'ADMIN_REQUIRED',error:'修改服务器自选需要管理员密钥；本地浏览器自选不受影响'}));return;}await runRequest(req,res,admission,requestDeadline,signal=>saveHistoryWatchlist(req,res,cors,signal));return;}
      if(!['GET','HEAD','OPTIONS'].includes(req.method)) {send(req,res,405,{'Content-Type':'application/json',Allow:'GET, HEAD, OPTIONS',...cors},JSON.stringify({error:'method not allowed'}));return;}
      if(req.method==='OPTIONS') {send(req,res,204,{...cors,Allow:p==='/api/history/watchlist'?'POST, OPTIONS':'GET, HEAD, OPTIONS','Access-Control-Allow-Methods':p==='/api/history/watchlist'?'GET, HEAD, OPTIONS, POST':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Admin-Token','Cache-Control':'no-store'},'');return;}
      const contextDocs={'/api/v1/openapi.json':'market-context.openapi.json','/api/v1/market-context.schema.json':'market-context.schema.json','/api/v2/openapi.json':'market-detail.openapi.json','/api/v2/market-detail.schema.json':'market-detail.schema.json'};
      if(contextDocs[p]){await staticService.serve(req,res,path.join(publicPath,contextDocs[p]),'.json','no-cache, must-revalidate');return;}
      if(p==='/healthz'||p==='/readyz') {
        const payload=healthPayload();send(req,res,p==='/readyz'&&!payload.ready?503:200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(payload));return;
      }
      if(p==='/api/stats') {
        if(!adminAuthorized(req,env.STATS_TOKEN||'')){send(req,res,404,{'Content-Type':'text/plain',...cors},'Not found');return;}
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({uptime:Math.round((now()-telemetry.stats.startedAt)/1000),req:telemetry.stats.req,upstream:telemetry.stats.upstream,quote:telemetry.stats.quote,business:businessState(),outcomes:telemetry.stats.business,admission:diagnostics().admission,streams:streamBudget.diagnostics(),runtime:telemetry.runtimeMetrics?.(),version,caches:services.cacheSizes?.()||{},rssMB:+(process.memoryUsage().rss/1048576).toFixed(1),disk:diskDiagnostics(env)}));return;
      }
      if(p==='/api/macro/stream'&&macroSse){macroSse.open(req,res,cors);return;}
      if(p==='/api/macro/snapshot'&&services.macroMonitor){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.macroMonitor.snapshot()));return;}
      if(p==='/api/macro/status'&&services.macroMonitor){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.macroMonitor.status()));return;}
      if(p==='/api/stream'&&sse){const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);if(parsed.error){send(req,res,400,{'Content-Type':'application/json'},JSON.stringify({error:parsed.error}));return;}sse.open(req,res,parsed.symbols,url.searchParams.get('cv'),url.searchParams.get('history')!=='off',cors);return;}
      if(p==='/api/sources'){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(publicSourceHealth(services.sourceHealth?.()||{})));return;}
      if(p==='/api/v2/field-catalog'){send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'public, max-age=300'},JSON.stringify({schema_version:2,fields:METRIC_CATALOG}));return;}
      if(p==='/api/detail'&&services.engine){
        await runRequest(req,res,quoteAdmission,requestDeadline,()=>{
          const query=parseDetailQuery({symbol:url.searchParams.get('symbol'),max_wait_ms:0});
          const quote=services.engine.read([query.symbol],{lease:false})[0];
          const context=buildMarketContext({query,requestId:'browser-cache',generatedAt:now(),quote});
          send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(buildMarketDetail(context,query)));
        });return;
      }
      if(p==='/api/samples'&&services.samples){
        await runRequest(req,res,admission,requestDeadline,()=>{
          const symbol=canonicalSymbol(url.searchParams.get('symbol'));
          if(!symbolValid(symbol)){send(req,res,400,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({code:'BAD_SAMPLE_SYMBOL'}));return;}
          send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(services.samples.snapshot(symbol)));
        });return;
      }
      if(p==='/api/news') {await runRequest(req,res,admission,requestDeadline,signal=>newsResponse(req,res,url,cors,signal));return;}
      if(p==='/api/markets') {send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'public, max-age=300'},JSON.stringify(marketDirectory()));return;}
      if(p==='/api/search') {await runRequest(req,res,admission,searchDeadline,signal=>searchResponse(req,res,url,cors,signal));return;}
      if(p==='/api/history/status'&&services.historyPrewarm){send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(services.historyPrewarm.status()));return;}
      if(p==='/api/history/bundle'&&services.historyPrewarm){
        const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);
        if(parsed.error){send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(services.historyPrewarm.snapshot(parsed.symbols)));return;
      }
      if(p==='/api/history') {await runRequest(req,res,historyAdmission,env.HISTORY_TOTAL_DEADLINE_MS??20000,signal=>historyResponse(req,res,url,cors,signal));return;}
      if(p==='/api/macro/context'&&services.getMacroContext) {
        const out=await runRequest(req,res,admission,requestDeadline,()=>services.getMacroContext());
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(out));return;
      }
      if(p==='/api/macro') {
        const out=await runRequest(req,res,admission,requestDeadline,()=>services.getMacro());
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(out));return;
      }
      const legacySymbolRoute=/^\/api\/[A-Z0-9^][A-Z0-9.&^=\-]{0,15}$/.test(p) && symbolValid(p.slice(5));
      if(p==='/api/market'||p==='/api/quote'||legacySymbolRoute) {await runRequest(req,res,quoteAdmission,requestDeadline,()=>marketResponse(req,res,url,cors));return;}
      if(p.startsWith('/api/')) {send(req,res,404,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({error:'unknown API route'}));return;}
      const file=path.normalize(p==='/'?'/index.html':p).replace(/^(\.\.[\/])+/, '/').replace(/^\/+/, '/');
      const abs=path.join(publicPath,file);
      if(!abs.startsWith(publicPath+path.sep)) {send(req,res,403,{'Content-Type':'text/plain'},'Forbidden');return;}
      const html=['/','/index.html'].includes(p);
      const cacheControl=html?'no-cache, must-revalidate':url.searchParams.has('v')?'public, max-age=31536000, immutable':'public, max-age=300';
      await staticService.serve(req,res,abs,path.extname(abs).toLowerCase(),cacheControl);
    } catch(error) {
      if(['ENOENT','EISDIR'].includes(error.code)) {send(req,res,404,{'Content-Type':'text/plain',...cors},'Not found');return;}
      telemetry.log.error('[route err]',{p,err:safeError(error.code||error.message)});
      const status=error.statusCode||(error.code==='DEADLINE_EXCEEDED'?504:error.code==='CAPACITY_EXCEEDED'?503:500);
      send(req,res,status,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store',...(status===503?{'Retry-After':'1'}:{})},JSON.stringify({code:status===500?'INTERNAL_ERROR':safeError(error.code),error:status===500?'internal error':safeError(error.message)}));
    }
  });
  function startListen() {
    if(server.listening) return server;
    marketAux.reopen();
    for(const queue of [admission,historyAdmission,quoteAdmission])queue.reopen();
    server.listen(boundedInt(env.PORT,8567,0,65535),env.HOST||'127.0.0.1',()=>{
      telemetry.log.info('[boot]',{msg:`Market panel on http://127.0.0.1:${server.address().port}`,symbols,version});
      if(options.monitorCore!==false) {probeEpoch++;void probeCore();probeTimer=setInterval(()=>void probeCore(),10000);probeTimer.unref?.();}
    });
    return server;
  }
  async function stop() {
    for(const queue of [admission,historyAdmission,quoteAdmission])queue.close();
    marketAux.close();await apiKeys.flush();macroSse?.close();sse?.close();probeEpoch++;clearInterval(probeTimer);probeTimer=null;
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
  }
  return Object.freeze({httpServer:server,startListen,stop,staticCache:staticService.cache,diagnostics});
}
