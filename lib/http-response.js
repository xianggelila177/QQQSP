import fs from 'node:fs';
import zlib from 'node:zlib';
import {RESPONSE_BUDGET} from './http-response-budget.js';
const SENDING=Symbol('response-started');
const ERROR_CONTEXT=Symbol('response-error-context');
export function setResponseErrorContext(res,schemaVersion,requestId){res[ERROR_CONTEXT]={schemaVersion,requestId};}

const MIME = {'.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const BASE_HEADERS = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
export function varyHeaders(headers, value) {
  const values = new Set(String(headers.Vary || headers.vary || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
  for (const part of value.split(',')) if(part.trim()) values.add(part.trim().toLowerCase());
  return [...values].map(s=>s.replace(/(^|[- ])([a-z])/g,(_,p,c)=>p+c.toUpperCase())).join(', ');
}
export function acceptsEncoding(req,encoding) {
  const options=String(req.headers['accept-encoding']||'').toLowerCase().split(',').map(s=>s.trim());
  const value=options.find(s=>s.split(';')[0].trim()===encoding)||options.find(s=>s.split(';')[0].trim()==='*');
  return !!value&&(!/;\s*q=([0-9.]+)/.test(value)||Number(/;\s*q=([0-9.]+)/.exec(value)[1])>0);
}
export function acceptsGzip(req) {
  const match = String(req.headers['accept-encoding'] || '').split(',').map(s=>s.trim().toLowerCase()).find(s=>/^gzip(?:\s*;|$)/.test(s));
  return !!match && (!/;\s*q=([0-9.]+)/.test(match) || Number(/;\s*q=([0-9.]+)/.exec(match)[1])>0);
}
export function send(req,res,status,headers,body) {
  if(res.destroyed || res.writableEnded || res[SENDING]) return;
  headers = {...BASE_HEADERS,...headers,Vary:varyHeaders(headers,'Accept-Encoding, '+(res.getHeader?.('Vary')||''))};
  delete headers.vary;
  if(req.method === 'HEAD' || status === 204 || status === 304) {res.writeHead(status,headers);res.end();return;}
  const size=Buffer.isBuffer(body)?body.length:Buffer.byteLength(body);
  const compress=!Object.keys(headers).some(key=>key.toLowerCase()==='content-encoding')&&acceptsGzip(req)&&size>1024;
  // Reserve input plus a conservative compressed-output allowance until finish.
  // This is an application buffer budget, not a process RSS bound.
  const budget=res[RESPONSE_BUDGET],lease=budget?.reserve(res,compress?size*2+1024:size,{compressing:compress});
  res[SENDING]=true;
  if(budget&&!lease){
    const context=res[ERROR_CONTEXT],code='RESPONSE_CAPACITY_EXCEEDED';
    const rejected=Buffer.from(JSON.stringify(context?{schema_version:context.schemaVersion,request_id:context.requestId,status:'unavailable',error:{code,message:'响应发送容量已满，请稍后重试。'}}:{code}));
    const retained=Object.fromEntries(Object.entries(headers).filter(([key])=>!['content-encoding','content-length','content-type','content-disposition','etag','last-modified','cache-control','retry-after','connection'].includes(key.toLowerCase())));
    res.writeHead(503,{...retained,'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'1','Connection':'close','Content-Length':rejected.length});res.end(rejected);return;
  }
  let raw;
  try{raw=Buffer.isBuffer(body)?body:Buffer.from(body);}catch(error){lease?.settleCompression();lease?.abort();throw error;}
  const finish = (data,gzip=false) => {
    if(res.destroyed || res.writableEnded) return;
    try{res.writeHead(status,{...headers,...(gzip?{'Content-Encoding':'gzip'}:{}),'Content-Length':data.length});res.end(data);}
    catch{lease?.abort();res.destroy();}
  };
  if(compress){
    try{zlib.gzip(raw,(error,gz)=>{lease?.settleCompression();finish(error?raw:gz,!error);});}
    catch{lease?.settleCompression();finish(raw);}
  }
  else finish(raw);
}

export function createStaticService() {
  const cache = new Map();
  async function serve(req,res,abs,ext,cacheControl) {
    const stat = await fs.promises.stat(abs);
    if(!stat.isFile()) throw Object.assign(new Error('not a file'),{code:'EISDIR'});
    let entry = cache.get(abs);
    if(!entry || entry.mtimeMs!==stat.mtimeMs || entry.size!==stat.size) {
      const raw = await fs.promises.readFile(abs);
      const pre=async suffix=>{try{const file=abs+suffix,compressed=await fs.promises.stat(file);return compressed.mtimeMs>=stat.mtimeMs-1000?await fs.promises.readFile(file):null;}catch{return null;}};
      // Missing precompressed files use send's bounded compressor. Loading a
      // cold asset must not start an independent unbudgeted gzip operation.
      entry={mtimeMs:stat.mtimeMs,size:stat.size,raw,gz:await pre('.gz'),br:await pre('.br')};
      if(cache.size>=100 && !cache.has(abs)) cache.delete(cache.keys().next().value);
      cache.set(abs,entry);
    }
    if(res.destroyed || res.writableEnded) return;
    const encoding=entry.br&&acceptsEncoding(req,'br')?'br':entry.gz&&acceptsGzip(req)?'gzip':null,out=encoding==='br'?entry.br:encoding==='gzip'?entry.gz:entry.raw;
    send(req,res,200,{'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':cacheControl,Vary:'Accept-Encoding',...(encoding?{'Content-Encoding':encoding}:{}),'Content-Length':out.length},out);
  }
  return Object.freeze({cache,serve});
}
