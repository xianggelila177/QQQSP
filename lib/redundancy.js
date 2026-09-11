import {marketStateFor,marketCalendarCoverage} from '../mkt.mjs';
import {isUsableChartFamily,isTerminalChartField} from './quote-contract.js';
import {currencyToCny} from './currency.js';

// This boundary is independent of the chart provider: a failed Yahoo chart
// must not prevent reference FX refresh or access to the last good quote.
export function createRedundancy({getQuote,fx,recovery,now=Date.now,recoveryWaitMs=150}) {
  const saved=new Map(),inflight=new Map();
  let timer=null,flushPromise=null,accepting=true;
  recovery.load();
  function flush(){
    if(!flushPromise)flushPromise=recovery.flush().finally(()=>{flushPromise=null;});
    return flushPromise;
  }
  function withFx(quote){
    if(!quote||quote.price==null||quote.recovery)return quote;
    void fx.getFxRates(quote.currency).catch(()=>{});
    const {rates,...info}=fx.fxSnapshotFor?fx.fxSnapshotFor(quote.currency):{rates:fx.fxFallbackRates(),...fx.fxMetadata()};
    return {...quote,...info,fxMap:rates,currency2cny:currencyToCny(quote.currency,rates,{index:quote.instrumentType==='INDEX',fxStale:info.fxStale}),
      slowFields:{...quote.slowFields,fx:{source:info.fxSource,updatedAt:info.fxAsOf,stale:info.fxStale,kind:info.fxKind}}};
  }
  function remember(quote){
    if(!accepting||!quote||quote.stale||quote.staleInfo||quote.error||quote.pending||quote.recovery||!recovery.enabled)return;
    const previous=saved.get(quote.symbol);
    // Avoid cloning/serializing chart arrays for every browser poll.
    if(previous!=null&&now()-previous<30000)return;
    if(recovery.remember(quote)){
      saved.delete(quote.symbol);saved.set(quote.symbol,now());
      while(saved.size>200)saved.delete(saved.keys().next().value);
      if(!recovery.diagnostics().lastFlushAt)void flush();
    }
  }
  function fallback(symbol,quote){
    const old=recovery.get(symbol);
    if(!old)return quote;
    if(quote?.price!=null&&Number(quote.quoteAt??quote.ts)>Number(old.quoteAt??old.ts))return quote;
    return {...old,marketState:marketStateFor(symbol,null,now(),old),calendarCoverage:marketCalendarCoverage(symbol,now(),null,old)};
  }
  function retainHistory(quote,old){
    if(!quote||quote.recovery||quote.symbol!==old?.symbol||!old.charts)return quote;
    const retained=Object.keys(old.charts).filter(key=>isUsableChartFamily(old.charts[key])&&!isUsableChartFamily(quote.charts?.[key]));
    if(!retained.length)return quote;
    const charts={...quote.charts},slowFields={...quote.slowFields};
    for(const key of retained){
      charts[key]=old.charts[key];
      const info=old.slowFields?.[key]||old.slowFields?.charts||{source:old.src||'recovery',updatedAt:old.fetchedAt??null};
      const current=quote.slowFields?.[key]||{},diagnostics={};
      for(const name of ['status','retryable','retryAt','retryAfterMs','failedAt','unsupported','error'])if(Object.hasOwn(current,name))diagnostics[name]=current[name];
      slowFields[key]={...info,...diagnostics,stale:true};
      if(isTerminalChartField(current)){
        slowFields[key].retryable=false;
        delete slowFields[key].retryAt;delete slowFields[key].retryAfterMs;
        if(!current.error)delete slowFields[key].error;
      }else slowFields[key].error=current.error||'retained history while source unavailable';
    }
    return {...quote,charts,slowFields};
  }
  async function getCachedQuote(symbol){
    void fx.getFxRates().catch(()=>{});
    const old=fallback(symbol,null);
    let pending=inflight.get(symbol);
    if(!pending){
      if(inflight.size>=200){const old=fallback(symbol,null);return old||{symbol,error:'活跃证券数量达到上限',code:'CAPACITY_EXCEEDED'};}
      pending=Promise.resolve().then(()=>getQuote(symbol)).then(quote=>{
        if(!quote||quote.error||quote.pending||quote.stale||quote.staleInfo)quote=fallback(symbol,quote);
        const out=withFx(retainHistory(quote,old));remember(out);return out;
      },error=>{const old=fallback(symbol,null);if(old)return old;throw error;}).finally(()=>inflight.delete(symbol));
      inflight.set(symbol,pending);
    }
    if(!old)return pending;
    let timeout;
    try{return await Promise.race([pending,new Promise(resolve=>{timeout=setTimeout(()=>resolve(old),recoveryWaitMs);})]);}
    finally{clearTimeout(timeout);}
  }
  function start(){accepting=true;if(!timer)timer=setInterval(()=>{void flush();},60000).unref();}
  async function stop(){accepting=false;clearInterval(timer);timer=null;await flush();}
  return Object.freeze({getCachedQuote,start,stop,diagnostics:()=>({fx:fx.diagnostics?.()||fx.fxMetadata(),recovery:recovery.diagnostics()})});
}
