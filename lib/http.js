// HTTP composition: request handlers consume explicit domain services.
// Infrastructure policies and state live in independently testable factories.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyMarket} from './instruments.js';
import {catalogSearch} from './catalog-search.js';
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
const MAX_SYMBOLS=12;
function parseSymbols(raw,defaults) {
  if(raw==null) return {symbols:defaults.slice(0,MAX_SYMBOLS)};
  if(String(raw)==='') return {symbols:[]};
  const values=String(raw).split(',').map(s=>s.trim().toUpperCase());
  if(values.length>MAX_SYMBOLS) return {error:`at most ${MAX_SYMBOLS} symbols are allowed`};
  if(values.some(s=>!symbolValid(s))) return {error:'invalid symbol'};
  return {symbols:[...new Set(values)]};
}
const fallbackServices={classifyMarket,ALIAS,ALIAS_SYM,IDX_NAME};

export function createHttp(deps,options={}) {
  const env=options.env||{},now=options.now||(()=>Date.now());
  const telemetry=options.telemetry||createTelemetry();
  const services=Object.freeze({...fallbackServices,...deps});
  const symbols=(env.SYMBOLS||'QQQ,SPY').split(',').map(s=>s.trim().toUpperCase()).filter(symbolValid).slice(0,MAX_SYMBOLS);
  const publicPath=options.publicPath||path.join(ROOT,'public');
  const requestDeadline=boundedInt(env.HTTP_REQUEST_DEADLINE_MS,20000,1,300000);
  const searchDeadline=boundedInt(env.HTTP_SEARCH_DEADLINE_MS,12000,1,300000);
  const admission=createAdmission({env,now});
  const historyAdmission=createAdmission({env:{...env,HTTP_ACTIVE_MAX:env.HTTP_HISTORY_ACTIVE_MAX??4,HTTP_QUEUE_MAX:env.HTTP_HISTORY_QUEUE_MAX??16},now});
  const quoteAdmission=createAdmission({env:{...env,HTTP_ACTIVE_MAX:env.HTTP_QUOTE_ACTIVE_MAX??8,HTTP_QUEUE_MAX:env.HTTP_QUOTE_QUEUE_MAX??16},now});
  const streamBudget=createStreamBudget({maxConnections:env.SSE_MAX_CONNECTIONS??32,maxBufferedBytes:env.SSE_MAX_BUFFER_BYTES??8388608});
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
    const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);
    if(parsed.error) {send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
    const arr=parsed.symbols,out={},meta={};
    for(const symbol of arr) services.activateNews(symbol);
    const tasks=arr.map(symbol=>services.requestNews(symbol,{signal}));
    const results=await settleWithin(tasks,requestDeadline);
    for(let i=0;i<arr.length;i++) {
      const symbol=arr[i],result=results[i];
      if(result?.__error) {
        out[symbol]=[];meta[symbol]={updatedAt:null,stale:true,error:safeError(result.__error.code||result.__error.message)};
      } else if(Array.isArray(result)) out[symbol]=result;
      else {
        out[symbol]=Array.isArray(result?.items)?result.items:[];
        meta[symbol]={updatedAt:result?.updatedAt??null,stale:Boolean(result?.stale),...(result?.error?{error:safeError(result.error)}:{})};
      }
    }
    const headers={'Content-Type':'application/json',...cors,'Cache-Control':'no-store'};
    if(Object.keys(meta).length) {headers['X-News-Meta']=Buffer.from(JSON.stringify(meta)).toString('base64url');headers['X-News-Meta-Encoding']='base64url-json';}
    send(req,res,200,headers,JSON.stringify(out));
  }
  async function searchResponse(req,res,url,cors,signal) {
    const q=(url.searchParams.get('q')||'').trim().slice(0,40);
    if(!q) {send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},'[]');return;}
    const idx=services.ALIAS_SYM[q.toLowerCase()];
    let out=idx?[{symbol:idx,name:services.IDX_NAME[idx]||idx,exch:'Index',type:'INDEX',market:services.classifyMarket(idx,'','','INDEX')}]:[];
    const local=catalogSearch(q);out=out.concat(local);
    const more=url.searchParams.get('more')==='1';
    const exactLocal=!!idx||local.some(x=>x.exact||x.matchType==='related');
    const futuresQuery=local.length>0&&local.every(x=>x.type==='FUTURE');
    const yahooTerm=futuresQuery?(local.find(x=>x.symbol.endsWith('=F'))?.symbol||q):/[\u4e00-\u9fff]/.test(q)?services.ALIAS[q.toLowerCase()]||'':q;
    const tasks=exactLocal&&!more?[]:[yahooTerm?services.yahooSearch(yahooTerm,{signal}):Promise.resolve([]),
      !futuresQuery?services.tencentSuggest(q,{signal}):Promise.resolve([]),
      !futuresQuery&&services.koreanSearch?services.koreanSearch(q,{signal}):Promise.resolve([]),
      services.futuresSearch?services.futuresSearch(q,{signal}):Promise.resolve([])];
    const [ys,ts,ks,fs]=await settleWithin(tasks,searchDeadline);
    if(Array.isArray(fs))out=out.concat(fs);
    if(Array.isArray(ks))out=out.concat(ks);
    const ya=Array.isArray(ys)?ys.filter(x=>x&&x.symbol!==idx&&(!futuresQuery||x.type==='FUTURE')):[],tx=Array.isArray(ts)?ts.filter(x=>x&&x.symbol!==idx):[];
    const seen=new Set();out=out.concat(ya,tx).filter(x=>symbolValid(x.symbol)&&(x.type!=='FUTURE'||futureInstrumentFor(x.symbol))&&!seen.has(x.symbol)&&seen.add(x.symbol)).slice(0,60);
    send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(out));
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
    else {const symbol=url.pathname.slice(5).split(',')[0].toUpperCase();if(symbolValid(symbol))defaults=[symbol];}
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
      const length=Number(req.headers['content-length']||0);
      if(!Number.isFinite(length)||length>2*1024*1024) {send(req,res,413,{'Content-Type':'application/json',...cors},JSON.stringify({error:'request body too large'}));return;}
      if(req.method==='POST'&&p==='/api/history/watchlist'&&services.historyPrewarm){await runRequest(req,res,admission,requestDeadline,signal=>saveHistoryWatchlist(req,res,cors,signal));return;}
      if(!['GET','HEAD','OPTIONS'].includes(req.method)) {send(req,res,405,{'Content-Type':'application/json',Allow:'GET, HEAD, OPTIONS',...cors},JSON.stringify({error:'method not allowed'}));return;}
      if(req.method==='OPTIONS') {send(req,res,204,{...cors,Allow:p==='/api/history/watchlist'?'POST, OPTIONS':'GET, HEAD, OPTIONS','Access-Control-Allow-Methods':p==='/api/history/watchlist'?'GET, HEAD, OPTIONS, POST':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Admin-Token','Cache-Control':'no-store'},'');return;}
      if(p==='/healthz'||p==='/readyz') {
        const payload=healthPayload();send(req,res,p==='/readyz'&&!payload.ready?503:200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(payload));return;
      }
      if(p==='/api/stats') {
        const token=String(env.STATS_TOKEN||''),supplied=String(req.headers['x-admin-token']||'');
        const localHost=/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/i.test(String(req.headers.host||''));
        const remote=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const localSocket=['127.0.0.1','::1'].includes(remote)&&!req.headers['cf-connecting-ip'];
        if(token?supplied!==token:!localHost||!localSocket) {send(req,res,404,{'Content-Type':'text/plain',...cors},'Not found');return;}
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({uptime:Math.round((now()-telemetry.stats.startedAt)/1000),req:telemetry.stats.req,upstream:telemetry.stats.upstream,quote:telemetry.stats.quote,business:businessState(),outcomes:telemetry.stats.business,admission:diagnostics().admission,streams:streamBudget.diagnostics(),runtime:telemetry.runtimeMetrics?.(),version,caches:services.cacheSizes?.()||{},rssMB:+(process.memoryUsage().rss/1048576).toFixed(1),disk:diskDiagnostics(env)}));return;
      }
      if(p==='/api/macro/stream'&&macroSse){macroSse.open(req,res,cors);return;}
      if(p==='/api/macro/snapshot'&&services.macroMonitor){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.macroMonitor.snapshot()));return;}
      if(p==='/api/macro/status'&&services.macroMonitor){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.macroMonitor.status()));return;}
      if(p==='/api/stream'&&sse){const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);if(parsed.error){send(req,res,400,{'Content-Type':'application/json'},JSON.stringify({error:parsed.error}));return;}sse.open(req,res,parsed.symbols,url.searchParams.get('cv'),url.searchParams.get('history')!=='off',cors);return;}
      if(p==='/api/sources'){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.sourceHealth?.()||{}));return;}
      if(p==='/api/samples'&&services.samples){
        await runRequest(req,res,admission,requestDeadline,()=>{
          const symbol=(url.searchParams.get('symbol')||'').trim().toUpperCase();
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
    for(const queue of [admission,historyAdmission,quoteAdmission])queue.reopen();
    server.listen(boundedInt(env.PORT,8567,0,65535),env.HOST||'127.0.0.1',()=>{
      telemetry.log.info('[boot]',{msg:`Market panel on http://127.0.0.1:${server.address().port}`,symbols,version});
      if(options.monitorCore!==false) {probeEpoch++;void probeCore();probeTimer=setInterval(()=>void probeCore(),10000);probeTimer.unref?.();}
    });
    return server;
  }
  async function stop() {
    for(const queue of [admission,historyAdmission,quoteAdmission])queue.close();
    macroSse?.close();sse?.close();probeEpoch++;clearInterval(probeTimer);probeTimer=null;
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
  }
  return Object.freeze({httpServer:server,startListen,stop,staticCache:staticService.cache,diagnostics});
}
