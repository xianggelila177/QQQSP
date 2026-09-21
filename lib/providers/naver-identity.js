const DAY=86400000,NEGATIVE_MS=600000,MAX_ENTRIES=200,MAX_INFLIGHT=2;
const exchanges={AMEX:'AMX',NYSE:'NYS',NASDAQ:'NSQ'};
const stopped=()=>Object.assign(new Error('Naver identity service stopped'),{code:'STOPPED'});

// Reuters suffixes are provider identifiers, not a mechanical translation of
// Tencent's exchange suffix. Naver itself supplies the exact listing and type.
export function naverSearchIdentity(data,symbol){
 if(data?.isSuccess!==true||!Array.isArray(data.result?.items))return null;
 const matches=data.result.items.filter(item=>item?.code===symbol&&item.nationCode==='USA');
 if(matches.length!==1)return null;
 const item=matches[0],exchange=exchanges[item.typeCode],code=item.reutersCode;
 if(!exchange||typeof code!=='string'||!new RegExp('^'+symbol+'(?:\\.[A-Z])?$').test(code)||typeof item.isEtf!=='boolean')return null;
 if(item.url!==`/worldstock/${item.isEtf?'etf':'stock'}/${code}`)return null;
 return {code,exchange,instrumentType:item.isEtf?'ETF':'EQUITY'};
}
export function matchesNaverIdentity(row,symbol,identity){
 const exchange=row?.stockExchangeType;
 return row?.symbolCode===symbol&&row.reutersCode===identity.code&&row.currencyType?.code==='USD'&&
  exchange?.code===identity.exchange&&['EST5EDT','America/New_York'].includes(exchange.zoneId)&&
  [exchange.nationCode,exchange.nationType].filter(v=>v!=null).length>0&&
  [exchange.nationCode,exchange.nationType].filter(v=>v!=null).every(v=>v==='USA');
}

export function createNaverIdentityResolver({request,now=Date.now}={}){
 const cache=new Map(),jobs=new Map();let closed=false,generation=0;
 function remember(symbol,value,nextAt){cache.delete(symbol);cache.set(symbol,{value,nextAt});while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value);}
 function peek(symbol){const entry=cache.get(symbol);return entry?.nextAt>now()?entry.value:null;}
 function resolve(symbol,{signal}={}){
  if(closed)return Promise.reject(stopped());
  if(signal?.aborted)return Promise.reject(signal.reason);
  if(!/^[A-Z][A-Z0-9-]{0,15}$/.test(symbol))return Promise.resolve(null);
  const entry=cache.get(symbol);if(entry?.nextAt>now())return Promise.resolve(entry.value);
  let job=jobs.get(symbol);
  // Keep cancelled work in its slot until the bounded transport actually
  // settles. Reopening cannot spawn replacements for a still-running request.
  if(job?.controller.signal.aborted)return Promise.resolve(null);
  if(!job){
   if(jobs.size>=MAX_INFLIGHT)return Promise.resolve(null);
   const controller=new AbortController(),owner=generation;
   job={controller,readers:0,promise:null};const current=job;
   job.promise=Promise.resolve().then(async()=>{
    controller.signal.throwIfAborted();
    const response=await request('https://m.stock.naver.com/front-api/search/autoComplete?query='+encodeURIComponent(symbol)+'&target=stock','utf8',controller.signal);
    controller.signal.throwIfAborted();if(closed||owner!==generation)throw stopped();
    const value=naverSearchIdentity(JSON.parse(response.body),symbol);
    remember(symbol,value,now()+(value?DAY:NEGATIVE_MS));return value;
   }).catch(error=>{
    if(controller.signal.aborted||closed||owner!==generation)throw controller.signal.reason||error;
    remember(symbol,null,Math.max(now()+60000,Number(error.retryAt)||0,now()+(Number(error.retryAfterMs)||0)));return null;
   }).finally(()=>{if(jobs.get(symbol)===current)jobs.delete(symbol);});
   jobs.set(symbol,job);
  }
  job.readers++;
  return new Promise((resolve,reject)=>{
   let done=false;
   const finish=(error,value)=>{
    if(done)return;done=true;signal?.removeEventListener('abort',abort);job.readers--;
    if(!job.readers&&signal?.aborted)job.controller.abort(signal.reason);
    error?reject(error):resolve(value);
   };
   const abort=()=>finish(signal.reason);
   signal?.addEventListener('abort',abort,{once:true});job.promise.then(value=>finish(null,value),finish);
  });
 }
 return {peek,resolve,close(){closed=true;generation++;cache.clear();for(const job of jobs.values())job.controller.abort(stopped());},reopen(){closed=false;}};
}
