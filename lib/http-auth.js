import {createHash,timingSafeEqual} from 'node:crypto';
const forwardingHeaders=['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','cf-connecting-ip','true-client-ip'];
export function isDirectLoopback(req) {
  const remote=String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
  if(!['127.0.0.1','::1'].includes(remote)||forwardingHeaders.some(k=>req.headers[k]!==undefined))return false;
  if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(req.headers.host||'')))return false;
  return req.headers['sec-fetch-site']!=='cross-site';
}
export function adminAuthorized(req,token='') {
  if(!token)return isDirectLoopback(req);
  const supplied=req.headers['x-admin-token'];
  if(typeof supplied!=='string'||supplied.length>1024)return false;
  if((req.rawHeaders||[]).filter((v,i)=>i%2===0&&v.toLowerCase()==='x-admin-token').length>1)return false;
  const hash=value=>createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied),hash(token));
}
