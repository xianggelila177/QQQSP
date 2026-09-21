// Optional checks never consume the foreground reader's remaining budget.
// Their producer still receives caller cancellation, an independent deadline,
// and application shutdown. A timed-out producer keeps its slot until settled.
export function createSourceProbes({now=Date.now,timeoutMs=3500,maxActive=2,maxEntries=400,ttlMs=300000}={}) {
 const jobs=new Map(),results=new Map();let closed=false,generation=0;
 function launch(key,load,{signal,onSuccess=()=>{},onFailure=()=>{}}={}) {
  if(closed||signal?.aborted||jobs.has(key)||jobs.size>=maxActive)return false;
  const owner=generation,controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Optional source probe timed out'),{code:'HISTORY_PROBE_TIMEOUT'})),Math.min(3500,Math.max(1,timeoutMs)));timer.unref?.();
  const clear=()=>clearTimeout(timer);combined.addEventListener('abort',clear,{once:true});
  const record={controller,promise:null};jobs.set(key,record);
  record.promise=Promise.resolve().then(()=>{combined.throwIfAborted();return load(combined);}).then(value=>{
   combined.throwIfAborted();if(closed||owner!==generation)return;
   // The adapters own history arrays and byte budgets. Retain only a tiny
   // verification summary here; onSuccess consumes the candidate immediately.
   const result={checkedAt:now(),until:now()+ttlMs,rows:Array.isArray(value?.timestamp)?value.timestamp.length:0};results.delete(key);results.set(key,result);
   while(results.size>maxEntries)results.delete(results.keys().next().value);
   onSuccess(value,result);
  }).catch(error=>{if(!closed&&owner===generation&&!combined.aborted)onFailure(error);})
   .finally(()=>{clear();combined.removeEventListener('abort',clear);if(jobs.get(key)===record)jobs.delete(key);});
  return true;
 }
 return {launch,
  close(){closed=true;generation++;results.clear();for(const job of jobs.values())job.controller.abort(Object.assign(new Error('History probes stopped'),{code:'STOPPED'}));},
  reopen(){closed=false;},diagnostics:()=>({active:jobs.size,maxActive,results:results.size,timeoutMs:Math.min(3500,Math.max(1,timeoutMs)),closed})};
}

// Compare whole verified sequences; never splice sources or prefer a wider
// but older-ending sequence over the current source's most recent period.
export function broaderHistory(candidate,current) {
 if(!candidate||!current||!Array.isArray(candidate.timestamp)||!Array.isArray(current.timestamp))return false;
 const a=candidate.timestamp.filter(Number.isFinite),b=current.timestamp.filter(Number.isFinite);
 if(!a.length||!b.length||Math.max(...a)<Math.max(...b)||Math.min(...a)>Math.min(...b))return false;
 return !!current.retrievalLimited&&!candidate.retrievalLimited||!!current.retrievalLimited===!!candidate.retrievalLimited&&a.length>b.length;
}
