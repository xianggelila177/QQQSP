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
import {createSse} from './sse.js';
import {boundedInt,safeError,withDeadline,settleWithin} from './http-admission.js';
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
  const requestDeadline=boundedInt(env.HTTP_REQUEST_DEADLINE_MS,20000,1000,120000);
  const searchDeadline=boundedInt(env.HTTP_SEARCH_DEADLINE_MS,12000,1000,120000);
  const admission={run:fn=>Promise.resolve().then(fn),diagnostics:()=>({mode:'single-user'})};
  const historyAdmission=admission,quoteAdmission=admission;
  const sse=deps.engine?createSse({engine:deps.engine,now}):null;
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
    return {version,business:businessState(),admission:{...admission.diagnostics(),quotes:quoteAdmission.diagnostics(),history:historyAdmission.diagnostics()}};
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
  async function newsResponse(req,res,url,cors) {
    const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);
    if(parsed.error) {send(req,res,400,{'Content-Type':'application/json',...cors},JSON.stringify({error:parsed.error}));return;}
    const arr=parsed.symbols,out={},meta={};
    for(const symbol of arr) services.activateNews(symbol);
    const tasks=arr.map(symbol=>admission.run(()=>services.requestNews(symbol)));
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
  async function searchResponse(req,res,url,cors) {
    const q=(url.searchParams.get('q')||'').trim().slice(0,40);
    if(!q) {send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},'[]');return;}
    const idx=services.ALIAS_SYM[q.toLowerCase()];
    let out=idx?[{symbol:idx,name:services.IDX_NAME[idx]||idx,exch:'Index',type:'INDEX',market:services.classifyMarket(idx,'','','INDEX')}]:[];
    const local=catalogSearch(q);out=out.concat(local);
    const more=url.searchParams.get('more')==='1';
    const exactLocal=!!idx||local.some(x=>x.exact||x.matchType==='related');
    const futuresQuery=local.length>0&&local.every(x=>x.type==='FUTURE');
    const yahooTerm=futuresQuery?(local.find(x=>x.symbol.endsWith('=F'))?.symbol||q):/[\u4e00-\u9fff]/.test(q)?services.ALIAS[q.toLowerCase()]||'':q;
    const tasks=exactLocal&&!more?[]:[yahooTerm?admission.run(()=>services.yahooSearch(yahooTerm)):Promise.resolve([]),
      !futuresQuery?admission.run(()=>services.tencentSuggest(q)):Promise.resolve([]),
      !futuresQuery&&services.koreanSearch?services.koreanSearch(q):Promise.resolve([]),
      services.futuresSearch?services.futuresSearch(q):Promise.resolve([])];
    const [ys,ts,ks,fs]=await settleWithin(tasks,searchDeadline);
    if(Array.isArray(fs))out=out.concat(fs);
    if(Array.isArray(ks))out=out.concat(ks);
    const ya=Array.isArray(ys)?ys.filter(x=>x&&x.symbol!==idx&&(!futuresQuery||x.type==='FUTURE')):[],tx=Array.isArray(ts)?ts.filter(x=>x&&x.symbol!==idx):[];
    const seen=new Set();out=out.concat(ya,tx).filter(x=>symbolValid(x.symbol)&&(x.type!=='FUTURE'||futureInstrumentFor(x.symbol))&&!seen.has(x.symbol)&&seen.add(x.symbol)).slice(0,60);
    send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(out));
  }
  async function historyResponse(req,res,url,cors){
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableEnded)controller.abort(historyError('HISTORY_CANCELLED','Client disconnected',499));};
    res.on('close',cancel);
    try{
      const query=historyQuery(url.searchParams.get('symbol'),url.searchParams.get('period'),{count:url.searchParams.get('count')??url.searchParams.get('limit')??undefined,before:url.searchParams.get('before'),seriesId:url.searchParams.get('seriesId')});
      if(!symbolValid(query.symbol))throw historyError('BAD_HISTORY_QUERY','Invalid symbol');
      if(!services.history?.get)throw historyError('HISTORY_UNSUPPORTED','History service unavailable',503);
      // The history service times execution, not time waiting behind other cards.
      const value=await historyAdmission.run(()=>services.history.get(query.symbol,query.period,{...query,signal:controller.signal}));
      send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(value));
    }catch(error){
      controller.abort(error);
      const code=error.code||'HISTORY_SOURCE_UNAVAILABLE';
      const status=error.statusCode||(['RATE_LIMITED','HISTORY_RATE_LIMITED'].includes(code)?429:['HISTORY_TIMEOUT','DEADLINE_EXCEEDED','DEADLINE'].includes(code)?504:503);
      if(!res.destroyed)send(req,res,status,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store',...(error.retryAt?{'Retry-After':String(Math.max(1,Math.ceil((error.retryAt-now())/1000)))}:{})},JSON.stringify({schemaVersion:1,status:'error',code,error:safeError(error.message),...(error.retryAt?{retryAt:error.retryAt}:{})}));
    }finally{res.removeListener('close',cancel);}
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
      try{return await withDeadline(quoteAdmission.run(()=>services.getCachedQuote(symbol)),requestDeadline);}
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
    const cors=String(req.headers.origin||'')===origin?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};
    res.on('finish',()=>{
      const ms=now()-started;telemetry.countReq(p,ms,res.statusCode);
      const quiet=['/api/market','/api/news','/api/macro','/healthz','/readyz'].includes(p)&&res.statusCode<400;
      (quiet?telemetry.log.debug:telemetry.log.info)('[req]',{m:req.method,p,st:res.statusCode,ms});
    });
    try {
      const length=Number(req.headers['content-length']||0);
      if(!Number.isFinite(length)||length>2*1024*1024) {send(req,res,413,{'Content-Type':'application/json',...cors},JSON.stringify({error:'request body too large'}));return;}
      if(!['GET','HEAD','OPTIONS'].includes(req.method)) {send(req,res,405,{'Content-Type':'application/json',Allow:'GET, HEAD, OPTIONS',...cors},JSON.stringify({error:'method not allowed'}));return;}
      if(req.method==='OPTIONS') {send(req,res,204,{...cors,Allow:'GET, HEAD, OPTIONS','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Admin-Token','Cache-Control':'no-store'},'');return;}
      if(p==='/healthz'||p==='/readyz') {
        const payload=healthPayload();send(req,res,p==='/readyz'&&!payload.ready?503:200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(payload));return;
      }
      if(p==='/api/stats') {
        const token=String(env.STATS_TOKEN||''),supplied=String(req.headers['x-admin-token']||'');
        const localHost=/^127\.0\.0\.1(?::\d+)?$|^localhost(?::\d+)?$/i.test(String(req.headers.host||''));
        const remote=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const localSocket=['127.0.0.1','::1'].includes(remote)&&!req.headers['cf-connecting-ip'];
        if(token?supplied!==token:!localHost||!localSocket) {send(req,res,404,{'Content-Type':'text/plain',...cors},'Not found');return;}
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({uptime:Math.round((now()-telemetry.stats.startedAt)/1000),req:telemetry.stats.req,upstream:telemetry.stats.upstream,quote:telemetry.stats.quote,business:businessState(),outcomes:telemetry.stats.business,admission:diagnostics().admission,version,caches:services.cacheSizes?.()||{},rssMB:+(process.memoryUsage().rss/1048576).toFixed(1),disk:diskDiagnostics(env)}));return;
      }
      if(p==='/api/stream'&&sse){const parsed=parseSymbols(url.searchParams.get('symbols'),symbols);if(parsed.error){send(req,res,400,{'Content-Type':'application/json'},JSON.stringify({error:parsed.error}));return;}sse.open(req,res,parsed.symbols,url.searchParams.get('cv'));return;}
      if(p==='/api/sources'){send(req,res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(services.sourceHealth?.()||{}));return;}
      if(p==='/api/news') {await newsResponse(req,res,url,cors);return;}
      if(p==='/api/markets') {send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'public, max-age=300'},JSON.stringify(marketDirectory()));return;}
      if(p==='/api/search') {await searchResponse(req,res,url,cors);return;}
      if(p==='/api/history') {await historyResponse(req,res,url,cors);return;}
      if(p==='/api/macro') {
        const out=await withDeadline(admission.run(()=>services.getMacro()),requestDeadline);
        send(req,res,200,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify(out));return;
      }
      const legacySymbolRoute=/^\/api\/[A-Z0-9^][A-Z0-9.&^=\-]{0,15}$/.test(p) && symbolValid(p.slice(5));
      if(p==='/api/market'||p==='/api/quote'||legacySymbolRoute) {await marketResponse(req,res,url,cors);return;}
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
      const status=error.code==='DEADLINE_EXCEEDED'?504:error.code==='CAPACITY_EXCEEDED'?503:500;
      send(req,res,status,{'Content-Type':'application/json',...cors,'Cache-Control':'no-store'},JSON.stringify({error:status===500?'internal error':safeError(error.code)}));
    }
  });
  function startListen() {
    if(server.listening) return server;
    server.listen(boundedInt(env.PORT,8567,0,65535),env.HOST||'127.0.0.1',()=>{
      telemetry.log.info('[boot]',{msg:`Market panel on http://127.0.0.1:${server.address().port}`,symbols,version});
      if(options.monitorCore!==false) {probeEpoch++;void probeCore();probeTimer=setInterval(()=>void probeCore(),10000);probeTimer.unref?.();}
    });
    return server;
  }
  async function stop() {
    sse?.close();probeEpoch++;clearInterval(probeTimer);probeTimer=null;
    await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
  }
  return Object.freeze({httpServer:server,startListen,stop,staticCache:staticService.cache,diagnostics});
}

