// Public health exposes operational counts, never symbols, raw payloads or credentials.
const scalar=(value,keys)=>Object.fromEntries(keys.filter(k=>typeof value?.[k]==='number'||typeof value?.[k]==='boolean'||typeof value?.[k]==='string').map(k=>[k,typeof value[k]==='string'?value[k].slice(0,120):value[k]]));
export function publicSourceHealth(value={}) {
  const f=value.fundamentals||{};
  const streams=v=>v?{...scalar(v,['enabled','status','errorCode','feed','active','maxSymbols','restRetryAt','restBlocked','nextConnectAt']),...(v.primary?{primary:streams(v.primary)}:{}),...(v.backup?{backup:streams(v.backup)}:{})}:null;
  return {fundamentals:{...scalar(f,['enabled','running','entries','inflight','failures','ttlMs','maxAgeMs']),sources:Object.fromEntries(Object.entries(f.sources||{}).map(([id,v])=>{
    const states=Object.values(v.securities||{});
    return [id,{ttlMs:v.ttlMs,tracked:states.length,inflight:states.filter(s=>s.inflight).length,failed:states.filter(s=>s.code).length}];
  }))},polling:scalar(value.polling,['primary','pollMs','requests','failures']),
    hosts:Object.fromEntries(Object.entries(value.hosts||{}).map(([id,v])=>[id,scalar(v,['state','calls','rateLimits','retryAt','queued','active'])])),stream:streams(value.stream)};
}
