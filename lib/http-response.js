import fs from 'node:fs';
import zlib from 'node:zlib';

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
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
  if(res.destroyed || res.writableEnded) return;
  headers = {...BASE_HEADERS,...headers,Vary:varyHeaders(headers,'Accept-Encoding')};
  delete headers.vary;
  if(req.method === 'HEAD' || status === 204) {res.writeHead(status,headers);res.end();return;}
  const raw = Buffer.isBuffer(body)?body:Buffer.from(body);
  const finish = (data,gzip=false) => {
    if(res.destroyed || res.writableEnded) return;
    res.writeHead(status,{...headers,...(gzip?{'Content-Encoding':'gzip'}:{}),'Content-Length':data.length});res.end(data);
  };
  if(acceptsGzip(req) && raw.length>1024) zlib.gzip(raw,(error,gz)=>finish(error?raw:gz,!error));
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
      entry={mtimeMs:stat.mtimeMs,size:stat.size,raw,gz:(await pre('.gz'))||(raw.length>1024?await new Promise(resolve=>zlib.gzip(raw,(error,value)=>resolve(error?null:value))):null),br:await pre('.br')};
      if(cache.size>=100 && !cache.has(abs)) cache.delete(cache.keys().next().value);
      cache.set(abs,entry);
    }
    if(res.destroyed || res.writableEnded) return;
    const encoding=entry.br&&acceptsEncoding(req,'br')?'br':entry.gz&&acceptsGzip(req)?'gzip':null,out=encoding==='br'?entry.br:encoding==='gzip'?entry.gz:entry.raw;
    res.writeHead(200,{...BASE_HEADERS,'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':cacheControl,Vary:'Accept-Encoding',...(encoding?{'Content-Encoding':encoding}:{}),'Content-Length':out.length});
    res.end(req.method==='HEAD'?undefined:out);
  }
  return Object.freeze({cache,serve});
}
