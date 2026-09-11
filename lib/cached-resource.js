// 同一键只执行一次加载，TTL 到期即刷新；失败冷却与成功时间独立。
// 专门的历史序列/成交记录仍用自己的缓存，不为统一而包装所有 Map。
export function createCachedResource({loader,ttlMs=60000,retryMs=60000,maxEntries=64,now=Date.now,cache=new Map(),inflight=new Map(),failures=new Map(),staleOnError=true}={}) {
  let closed=false,epoch=0;
  const stopped=()=>Object.assign(new Error('缓存服务已停止'),{code:'STOPPED'});
  function trim(map) {while(map.size>maxEntries)map.delete(map.keys().next().value);}
  function refresh(key) {
    if(closed)return Promise.reject(stopped());
    if(inflight.has(key))return inflight.get(key);
    const f=failures.get(key);if(f?.retryAt>now())return Promise.reject(f.error);
    const owner=epoch;
    const job=Promise.resolve().then(()=>loader(key)).then(data=>{
      if(closed||owner!==epoch)throw stopped();
      cache.delete(key);cache.set(key,{data,ts:now()});trim(cache);failures.delete(key);return data;
    },error=>{
      if(!closed&&owner===epoch) {
        const n=Math.min((failures.get(key)?.n??0)+1,8);
        const retryAt=Math.max(now()+Math.min(retryMs*2**(n-1),900000),Number(error.retryAt)||0);
        failures.set(key,{error,at:now(),n,retryAt});trim(failures);
      }
      throw error;
    }).finally(()=>{if(inflight.get(key)===job)inflight.delete(key);});
    inflight.set(key,job);return job;
  }
  async function get(key,{swr=false,maxAgeMs=ttlMs}={}) {
    if(closed)throw stopped();const entry=cache.get(key);
    if(entry&&now()-entry.ts<maxAgeMs)return entry.data;
    const job=refresh(key);
    if(entry&&swr){void job.catch(()=>{});return entry.data;}
    try{return await job;}catch(error){if(entry&&staleOnError&&error.code!=='STOPPED')return entry.data;throw error;}
  }
  return {get,refresh,cache,inflight,failures,close(){closed=true;epoch++;inflight.clear();},reopen(){closed=false;},clear(){cache.clear();failures.clear();}};
}
