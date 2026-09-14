import {providerRetryAt} from './providers/provider-retry.js';
// Optional generic JSON receiver. No credentials or user data appear in SSE.
export function createMacroNotifier({url='',token='',fetchImpl=fetch,now=Date.now}={}){
 if(!url)return null;
 const target=new URL(url);if(target.protocol!=='https:')throw new TypeError('MACRO_WEBHOOK_URL 必须为 https 地址');
 return async event=>{const r=await fetchImpl(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({type:'qqqsp.macro.focus',...event})});
  const status=r.status;await r.body?.cancel();if(!r.ok)throw Object.assign(new Error('通知接收端 HTTP '+status),{retryAt:providerRetryAt(Object.fromEntries(r.headers),now(),60000)});
 };
}
