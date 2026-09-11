// log.mjs — 轻量结构化日志 + 运行指标
// 输出: stdout(JSON 行, 由 systemd/journald 接管) + 本地文件 logs/panel.log(按大小轮转)
// 级别: LOG_LEVEL=debug|info|warn|error (默认 info)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger({env={},now=()=>Date.now()}={}) {
const MIN = LEVELS[String(env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
const LOG_FILE = env.LOG_FILE || path.join(__dirname, 'logs', 'panel.log');
function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
const MAX_BYTES = boundedInt(env.LOG_MAX_BYTES, 10 * 1024 * 1024, 1, 1024 * 1024 * 1024);
const MAX_FILES = boundedInt(env.LOG_MAX_FILES, 3, 1, 20);

let stream = null;
let currentBytes = 0;
function getStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { currentBytes = fs.statSync(LOG_FILE).size; } catch { currentBytes = 0; }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch { stream = null; }
  return stream;
}
function rotateIfNeeded() {
  try {
    if (currentBytes < MAX_BYTES) return;
    if (stream) { stream.end(); stream = null; }
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const src = LOG_FILE + '.' + i;
      if (fs.existsSync(src)) fs.renameSync(src, LOG_FILE + '.' + (i + 1));
    }
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    currentBytes = 0;
  } catch { /* 轮转失败不致命 */ }
}
function emit(level, msg, meta) {
  if (LEVELS[level] < MIN) return;
  const s = JSON.stringify({ ts: new Date(now()).toISOString(), lv: level, msg, ...(meta || {}) });
  (level === 'warn' || level === 'error' ? console.error : console.log)(s);
  rotateIfNeeded();   // P2 修复: 先轮转(内部会 end+置空旧流), 再取流 -> 拿到指向新文件的新 fd, 边界消息不丢失
  const st = getStream();
  if (st) { const line = s + '\n'; st.write(line); currentBytes += Buffer.byteLength(line); }
}
const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
return logger;
}
export const log=Object.freeze({debug(){},info(){},warn(){},error(){}});

// Instance-owned telemetry; one-second buckets cover a bounded five-minute window.
const WINDOW_MS = 300000;
const MAX_HOSTS = 64;
const ROUTES = new Set(['/healthz','/readyz','/api/stats','/api/market','/api/quote','/api/news','/api/macro','/api/search']);
const routeLabel = value => { const p=String(value||'unknown').split('?')[0]; return ROUTES.has(p)?p:p==='/'?'/':p.startsWith('/api/')?'/api/other':'/other'; };
export function createTelemetry({now=()=>Date.now(),logger=log}={}) {
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
  function startStatsReporter(getCacheSizes) {
    return setInterval(()=>logger.info('stats',{uptimeMin:Math.round((now()-stats.startedAt)/60000),req:stats.req,upstream:stats.upstream,quote:stats.quote,business:stats.business,caches:getCacheSizes?.()||{},rssMB:+(process.memoryUsage().rss/1048576).toFixed(1)}),WINDOW_MS).unref();
  }
  return Object.freeze({stats,log:logger,countReq,countUpstream,recentUpstream,countQuoteOutcomes,startStatsReporter});
}
