// Instance-owned structured logging. Slow sinks cannot create an unbounded queue.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {finished} from 'node:stream/promises';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createBoundedWriter} from './lib/bounded-writer.js';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const LEVELS={debug:10,info:20,warn:30,error:40};
const observedSinks=new WeakSet();
function writeSink(sink,text){
  if(!observedSinks.has(sink)){observedSinks.add(sink);sink.on('error',()=>{});}
  return new Promise((resolve,reject)=>sink.write(text,error=>error?reject(error):resolve()));
}
export function createLogger({env={},now=Date.now,stdout=process.stdout,stderr=process.stderr}={}){
  const minimum=LEVELS[env.LOG_LEVEL||'info']??20;
  const file=env.LOG_FILE===undefined?path.join(__dirname,'logs','panel.log'):env.LOG_FILE;
  const maxBytes=Number(env.LOG_MAX_BYTES)||10485760,maxFiles=Number(env.LOG_MAX_FILES)||3;
  const queueBytes=Number(env.LOG_BUFFER_BYTES)||262144,sampleLimit=Number(env.LOG_SAMPLE_LIMIT)||20;
  let stream=null,currentBytes=0,nextFileAttempt=0,sampled=0;
  const repeats=new Map();
  async function closeFile(){if(stream){const old=stream;stream=null;const done=finished(old);old.end();await done;}}
  async function writeFile(text){
    if(now()<nextFileAttempt)throw new Error('Log file cooling down');
    try{
      if(!stream){await fs.promises.mkdir(path.dirname(file),{recursive:true,mode:0o700});try{currentBytes=(await fs.promises.stat(file)).size;}catch(error){if(error.code!=='ENOENT')throw error;currentBytes=0;}}
      if(currentBytes>=maxBytes){
        await closeFile();
        for(let i=maxFiles-1;i>=1;i--)try{await fs.promises.rename(file+'.'+i,file+'.'+(i+1));}catch(error){if(error.code!=='ENOENT')throw error;}
        try{await fs.promises.rename(file,file+'.1');}catch(error){if(error.code!=='ENOENT')throw error;}currentBytes=0;
      }
      if(!stream)stream=fs.createWriteStream(file,{flags:'a',mode:0o600});
      await writeSink(stream,text);currentBytes+=Buffer.byteLength(text);
    }catch(error){stream?.destroy();stream=null;nextFileAttempt=now()+1000;throw error;}
  }
  const out=createBoundedWriter(text=>writeSink(stdout,text),{maxBytes:queueBytes});
  const err=createBoundedWriter(text=>writeSink(stderr,text),{maxBytes:queueBytes});
  const disk=file?createBoundedWriter(writeFile,{maxBytes:queueBytes}):null;
  function emit(level,msg,meta){
    if(LEVELS[level]<minimum)return;
    if(LEVELS[level]>=30){
      const key=[level,String(msg).slice(0,256),meta?.code||meta?.st||''].join('|');let item=repeats.get(key);
      if(!item||now()-item.at>=5000){item={at:now(),count:0};repeats.delete(key);repeats.set(key,item);while(repeats.size>256)repeats.delete(repeats.keys().next().value);}
      if(++item.count>sampleLimit){sampled++;return;}
    }
    let text;try{text=JSON.stringify({ts:new Date(now()).toISOString(),lv:level,msg,...(meta||{})})+'\n';}
    catch{text=JSON.stringify({ts:new Date(now()).toISOString(),lv:level,msg:String(msg),serializationError:true})+'\n';}
    (LEVELS[level]>=30?err:out).enqueue(text);disk?.enqueue(text);
  }
  async function flush({timeoutMs=2000}={}){
    let timer;try{return await Promise.race([Promise.all([out.idle(),err.idle(),disk?.idle()]).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{clearTimeout(timer);}
  }
  return Object.freeze({debug:(m,d)=>emit('debug',m,d),info:(m,d)=>emit('info',m,d),warn:(m,d)=>emit('warn',m,d),error:(m,d)=>emit('error',m,d),flush,
    diagnostics:()=>({sampled,stdout:out.diagnostics(),stderr:err.diagnostics(),file:disk?.diagnostics()||null}),
    async close(){if(await flush())await closeFile();}
  });
}
export const log=Object.freeze({debug(){},info(){},warn(){},error(){}});

// Instance-owned telemetry; one-second buckets cover a bounded five-minute window.
const WINDOW_MS = 300000;
const MAX_HOSTS = 64;
const ROUTES = new Set(['/healthz','/readyz','/api/stats','/api/market','/api/quote','/api/news','/api/macro','/api/search','/api/history','/api/history/bundle','/api/history/watchlist','/api/stream','/api/macro/stream','/api/macro/context']);
const routeLabel = value => { const p=String(value||'unknown').split('?')[0]; return ROUTES.has(p)?p:p==='/'?'/':p.startsWith('/api/')?'/api/other':'/other'; };
export function createTelemetry({now=()=>Date.now(),logger=log}={}) {
  let loop=null,reporter=null;
  const stats={startedAt:now(),req:{total:0,errors:0,byRoute:{}},upstream:{total:0,fail:0,timeout:0,byHost:{}},quote:{fetched:0,staleServed:0,cooldownHits:0},business:{responses:0,ok:0,pending:0,stale:0,error:0}};
  function bump(bucket,key,ms,error) {
    if(!bucket[key] && Object.keys(bucket).length>=MAX_HOSTS) key='/other';
    const entry=bucket[key] ||= {n:0,err:0,totalMs:0,maxMs:0};
    const elapsed=Number.isFinite(Number(ms))?Math.max(0,Number(ms)):0;
    entry.n++; entry.totalMs+=elapsed; entry.maxMs=Math.max(entry.maxMs,elapsed); if(error) entry.err++;
    return entry;
  }
  function countReq(route,ms,status) {stats.req.total++;if(status>=500)stats.req.errors++;bump(stats.req.byRoute,routeLabel(route),ms,status>=400);}
  function countUpstream(host,ms,ok,timedOut) {
    stats.upstream.total++; if(!ok)stats.upstream.fail++;if(timedOut)stats.upstream.timeout++;
    const safeHost=String(host||'unknown').replace(/[^A-Za-z0-9.:-]/g,'').slice(0,128)||'unknown';
    const entry=bump(stats.upstream.byHost,safeHost,ms,!ok),at=Math.floor(now()/1000)*1000;
    entry.recent ||= [];
    entry.recent=entry.recent.filter(b=>b.at+1000>now()-WINDOW_MS && b.at<=now());
    let bucket=entry.recent.at(-1);
    if(!bucket || bucket.at!==at) {bucket={at,n:0,errors:0,timeouts:0};entry.recent.push(bucket);}
    bucket.n++;if(!ok)bucket.errors++;if(timedOut)bucket.timeouts++;
    if(entry.recent.length>301)entry.recent.splice(0,entry.recent.length-301);
  }
  function recentUpstream(host) {
    const items=stats.upstream.byHost[host]?.recent?.filter(b=>b.at+1000>now()-WINDOW_MS && b.at<=now())||[];
    const calls=items.reduce((n,b)=>n+(b.n??1),0),errors=items.reduce((n,b)=>n+(b.errors??(b.err?1:0)),0);
    return {calls,errors,errRate:calls?+(errors/calls).toFixed(3):0,windowMs:WINDOW_MS,bucketMs:1000};
  }
  function countQuoteOutcomes(quotes) {
    stats.business.responses++;
    for(const q of quotes) {const kind=q?.pending?'pending':q?.error?'error':q?.stale||q?.staleInfo?'stale':'ok';stats.business[kind]++;}
  }
  function runtimeMetrics(){return {eventLoop:loop?{p50Ms:loop.percentile(50)/1e6,p95Ms:loop.percentile(95)/1e6,p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6}:null,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss,logging:logger.diagnostics?.()||null};}
  function stopStatsReporter(){clearInterval(reporter);reporter=null;loop?.disable();loop=null;}
  function startStatsReporter(getCacheSizes) {
    if(reporter)return reporter;loop=monitorEventLoopDelay({resolution:20});loop.enable();
    return reporter=setInterval(()=>logger.info('stats',{uptimeMin:Math.round((now()-stats.startedAt)/60000),req:stats.req,upstream:stats.upstream,quote:stats.quote,business:stats.business,caches:getCacheSizes?.()||{},rssMB:+(process.memoryUsage().rss/1048576).toFixed(1)}),WINDOW_MS).unref();
  }
  return Object.freeze({stats,log:logger,countReq,countUpstream,recentUpstream,countQuoteOutcomes,startStatsReporter,stopStatsReporter,runtimeMetrics});
}
