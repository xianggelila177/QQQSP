import {createCachedResource} from './cached-resource.js';
import {createTaskQueue} from './task-queue.js';
import {buildBasicMetrics} from './fundamentals.js';
import {createMultiSourceFundamentals} from './fundamentals-multi.js';
// Separate, bounded background work. decorate() never waits for financial IO.
export function createFundamentalsService({sources,fetchFundamentals,now=Date.now,enabled=true,ttlMs=21600000,retryMs=300000,maxAgeMs=604800000,onUpdate=()=>{},maxEntries=128}={}) {
  if(sources)return createMultiSourceFundamentals({sources,now,enabled,ttlMs,retryMs,maxAgeMs,onUpdate,maxEntries});
  let running=false;const warming=new Map();
  const ttlFor=record=>Number.isFinite(record?.refreshAfterMs)?Math.min(ttlMs,Math.max(60000,record.refreshAfterMs)):ttlMs;
  const queue=createTaskQueue({maxActive:1,maxQueued:64,now});
  const resource=createCachedResource({now,ttlMs,retryMs,maxEntries,staleOnError:false,loader:(symbol,{signal})=>queue.run(async taskSignal=>{
    // Waiting behind another security is not a failed upstream request. Start
    // the IO budget on admission; membership cancellation still removes waiters.
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(Object.assign(new Error('Financial request deadline exceeded'),{code:'DEADLINE_EXCEEDED'})),20000);
    const requestSignal=AbortSignal.any([taskSignal,timeout.signal]);
    try{
      const value=await fetchFundamentals(symbol,{signal:requestSignal});requestSignal.throwIfAborted();
      if(value?.symbol!==symbol||!value.fields)throw Object.assign(new Error('Financial identity mismatch'),{code:'FUNDAMENTALS_IDENTITY'});
      return {...value,fetchedAt:now()};
    }finally{clearTimeout(timer);}
  },{signal})});
  function warm(symbol){
    if(!enabled||!running||warming.has(symbol)||resource.failures.get(symbol)?.retryAt>now())return;
    const old=resource.cache.get(symbol);if(old&&now()-old.ts<ttlFor(old.data))return;
    const controller=new AbortController();warming.set(symbol,controller);
    void resource.refresh(symbol,{signal:controller.signal}).catch(()=>{}).finally(()=>{
      if(warming.get(symbol)===controller){warming.delete(symbol);if(running)onUpdate(symbol);}
    });
  }
  return {
    decorate(quote){
      if(!quote||quote.error||quote.pending||!quote.symbol)return quote;
      const live=quote.financials;
      const validLive=live?.symbol===quote.symbol&&Number.isFinite(live.fetchedAt)&&live.fetchedAt<=now()+5000&&now()-live.fetchedAt<ttlFor(live)&&Object.keys(live.fields||{}).length>0;
      if(!validLive&&['EQUITY','ETF','MUTUALFUND'].includes(quote.instrumentType||'EQUITY'))warm(quote.symbol);
      const record=validLive?live:resource.cache.get(quote.symbol)?.data;
      const fundamentals=buildBasicMetrics(quote,record,{now:now(),ttlMs:ttlFor(record),maxAgeMs,enabled,loading:warming.has(quote.symbol),failure:validLive?null:resource.failures.get(quote.symbol)});
      const identity=record&&fundamentals.instrumentType!==quote.instrumentType?{instrumentType:fundamentals.instrumentType,instrumentTypeSource:'provider'}:{};
      return {...quote,...identity,fundamentals};
    },
    start(){running=true;resource.reopen();queue.reopen();},
    stop(){running=false;for(const controller of warming.values())controller.abort();warming.clear();resource.close();queue.close();},
    retain(symbols){const keep=new Set(symbols);for(const [symbol,controller] of warming)if(!keep.has(symbol)){warming.delete(symbol);controller.abort();}},
    clear(){resource.clear();},
    diagnostics:()=>({enabled,running,ttlMs,maxAgeMs,entries:resource.cache.size,inflight:warming.size,failures:resource.failures.size,queue:queue.diagnostics()}),
  };
}
