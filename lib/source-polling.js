// Demand-driven, bounded round robin. A turn only selects a candidate; adapters
// still own their caches, capability checks, in-flight work and Retry-After.
export function createSourcePolling({now=Date.now,intervalMs=30000,maxEntries=200}={}) {
  const rounds=new Map();
  function take(key,ids) {
    if(!ids.length)return null;
    let state=rounds.get(key);
    if(!state){state={cursor:0,nextAt:now()+intervalMs};rounds.set(key,state);}
    while(rounds.size>maxEntries)rounds.delete(rounds.keys().next().value);
    if(now()<state.nextAt)return null;
    const id=ids[state.cursor%ids.length];state.cursor++;state.nextAt=now()+intervalMs;
    return id;
  }
  return {take,retry(key){const state=rounds.get(key);if(state){state.cursor=Math.max(0,state.cursor-1);state.nextAt=now();}},clear:()=>rounds.clear(),diagnostics:()=>({intervalMs,tracked:rounds.size})};
}
