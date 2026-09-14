// Yahoo credential lifecycle: paired cookie/crumb, single-flight and failure backoff.
export function createYahooAuth({ttl=55*60*1000,failureCooldown=30000,failureCap=120000,now=()=>Date.now(),onRateLimit=()=>{},httpsGet,yGated}={}) {
  let crumbStore=null,failUntil=0,failures=0,inflight=null,generation=0,closed=false;
  const stopped=()=>Object.assign(new Error('Yahoo auth stopped'),{code:'STOPPED'});
  async function fetchCrumb() {
    const owner=generation;
    try {
      const ck=await yGated((signal,remaining)=>httpsGet('https://fc.yahoo.com',{}, {signal,timeout:remaining}),{source:'cookie',cookieProbe:true});
      if(closed||owner!==generation)throw stopped();
      if(ck.status===429){onRateLimit('cookie',ck.headers?.['retry-after']);throw Object.assign(new Error('cookie HTTP 429'),{rateLimited:true});}
      if(ck.status!==404&&(ck.status<200||ck.status>=300))throw new Error('cookie HTTP '+ck.status);
      const raw=ck.headers?.['set-cookie'];
      const cookie=(Array.isArray(raw)?raw:raw?[raw]:[]).map(c=>c.split(';')[0]).join('; ');
      if(!cookie)throw new Error('cookie missing');
      const cr=await yGated((signal,remaining)=>httpsGet('https://query1.finance.yahoo.com/v1/test/getcrumb',{Cookie:cookie},{signal,timeout:remaining}),{source:'crumb'});
      if(closed||owner!==generation)throw stopped();
      if(cr.status===429){onRateLimit('crumb',cr.headers?.['retry-after']);throw Object.assign(new Error('crumb HTTP 429'),{rateLimited:true});}
      const body=String(cr.body || '').trim();
      if(cr.status!==200||!body||body.length>40||/[\s<:]/.test(body))throw new Error('invalid crumb HTTP '+cr.status);
      crumbStore={crumb:body,cookie,t:now()};failUntil=0;failures=0;
      return {crumb:body,cookie};
    }catch(error){
      if(closed||owner!==generation)throw stopped();
      failures=Math.min(failures+1,30);
      failUntil=Math.max(now()+Math.min(failureCooldown*2**(failures-1),failureCap),Number(error.retryAt)||0);
      throw Object.assign(new Error('crumb fetch failed: '+String(error.message || error),{cause:error}),{rateLimited:!!error.rateLimited,code:error.code,retryAt:failUntil});
    }
  }
  function getCrumb() {
    if(closed)return Promise.reject(stopped());
    if(crumbStore&&now()-crumbStore.t<ttl)return Promise.resolve({crumb:crumbStore.crumb,cookie:crumbStore.cookie});
    if(inflight)return inflight;
    if(now()<failUntil)return Promise.reject(Object.assign(new Error('crumb cooldown'),{retryAt:failUntil}));
    const work=fetchCrumb().finally(()=>{if(inflight===work)inflight=null;});inflight=work;return work;
  }
  function reset(){generation++;crumbStore=null;failUntil=0;failures=0;inflight=null;}
  return {getCrumb,clearCrumb:()=>{crumbStore=null;},seed:(crumb='test-crumb')=>{crumbStore={crumb,cookie:'test-cookie=1',t:now()};},reset,
    close:()=>{closed=true;reset();},reopen:()=>{closed=false;},resetFailure:()=>{failUntil=0;failures=0;},state:()=>({crumbFailUntil:failUntil})};
}
