import http from 'node:http';
import https from 'node:https';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import { log as defaultLog } from '../log.mjs';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export function isYahooUrl(u) {try {const h=new URL(u).hostname;return h==='yahoo.com'||h.endsWith('.yahoo.com');}catch{return false;}}
export function createTransport({env={},upstream=null,log=defaultLog,countUpstream=()=>{},now=()=>Date.now(),gate=null}={}) {
  const makeAgent=()=>new https.Agent({keepAlive:true,maxSockets:8,scheduling:'lifo'});
  let AGENT=makeAgent(),closed=false;
  const active=new Set();
  const stopped=()=>Object.assign(new Error('Transport stopped'),{code:'STOPPED'});
  function tracked(work,opts={}) {
    if(closed)return Promise.reject(stopped());
    if(opts.signal?.aborted)return Promise.reject(opts.signal.reason || stopped());
    const controller=new AbortController();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;active.delete(cancel);opts.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const cancel=()=>{const error=stopped();controller.abort(error);finish(error);};
      const abort=()=>{const error=opts.signal.reason || stopped();controller.abort(error);finish(error);};
      active.add(cancel);opts.signal?.addEventListener('abort',abort,{once:true});
      try{Promise.resolve(work({...opts,signal:controller.signal})).then(value=>finish(null,value),finish);}catch(error){finish(error);}
    });
  }
  const UPSTREAM_TIMEOUT=Number(env.UPSTREAM_TIMEOUT || 8000);
  const UPSTREAM_MAX_BODY_BYTES=Number(env.UPSTREAM_MAX_BODY_BYTES || 2*1024*1024);
async function rawRequest(url, headers = {}, opts = {}, countUrl = null) {
  const t0 = now();
  let host = '?';
  try { host = new URL(countUrl || url).host; } catch {}
  const isHttp = url.startsWith('http:');
  const mod = isHttp ? http : https;
  return new Promise((resolve, reject) => {
    let timedOut = false, settled = false, killer;
    const reqEnc = opts.encoding || 'utf8';
    const fail = (error) => {
      if (settled) return;
      settled = true; clearTimeout(killer);
      const ms = now() - t0;
      countUpstream(host, ms, false, timedOut);
      log.warn('[upstream fail]', { host, ms, timeout: timedOut, err: String(error?.message || error) });
      reject(error);
    };
    const req = mod.get(url, { agent: isHttp ? undefined : AGENT, headers: { 'User-Agent': UA, ...headers }, ...opts }, (res) => {
      const chunks = [];
      let bodyBytes = 0;
      res.on('error', error => { fail(error); req.destroy(error); });
      res.on('data', chunk => {
        if (settled) return;
        bodyBytes += chunk.length;
        if (bodyBytes > UPSTREAM_MAX_BODY_BYTES) {
          const error = new Error('upstream body exceeds limit');
          fail(error); req.destroy(error);
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        let bytes=Buffer.concat(chunks,bodyBytes),body;
        try {
          const encoding=String(res.headers['content-encoding']||'identity').trim().toLowerCase();
          const decode={gzip:gunzipSync,'x-gzip':gunzipSync,deflate:inflateSync,br:brotliDecompressSync}[encoding];
          if(decode)bytes=decode(bytes,{maxOutputLength:UPSTREAM_MAX_BODY_BYTES});
          else if(encoding!=='identity')throw Object.assign(new Error('unsupported content-encoding: '+encoding),{code:'UPSTREAM_ENCODING'});
          body=bytes.toString(reqEnc);
        } catch(error) {fail(error);req.destroy(error);return;}
        settled = true; clearTimeout(killer);
        const ms = now() - t0;
        const yahoo404 = host === 'fc.yahoo.com' && res.statusCode === 404;
        countUpstream(host, ms, res.statusCode < 400 || yahoo404, false);
        log.debug('[upstream]', { host, status: res.statusCode, ms, bytes: bodyBytes });
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    killer = setTimeout(() => {
      timedOut = true;
      const error = new Error('upstream timeout ' + host);
      fail(error); req.destroy(error);
    }, Number(opts.timeout) || UPSTREAM_TIMEOUT);
    killer.unref?.();
    req.on('error', fail);
  });
}


  function rawHttpsGet(url,headers={},opts={},countUrl=null){const {priority,...requestOptions}=opts;return tracked(options=>rawRequest(url,headers,options,countUrl),requestOptions);}
  function request(url,headers={},opts={}) {return upstream?upstream(url,headers,opts):rawRequest(url,headers,opts);}
  function httpsGet(url,headers={},opts={}){
    const {gatePartition,priority,...requestOptions}=opts;
    return gate?gate.run(url,signal=>tracked(options=>request(url,headers,options),{...requestOptions,signal}),{...requestOptions,gatePartition,priority}):tracked(options=>request(url,headers,options),requestOptions);
  }
  function close(){gate?.close();closed=true;for(const cancel of [...active])cancel();AGENT.destroy();return Promise.resolve();}
  function reopen(){gate?.reopen();if(closed){closed=false;AGENT=makeAgent();}}
  return {httpsGet,rawHttpsGet,close,reopen};
}
