import {publishQuote} from './quote-contract.js';
import {createCachedResource} from './cached-resource.js';
export const failCooldownMs=n=>Math.min(10000*2**Math.max(0,(n||1)-1),120000);

export function createQuoteCache({cacheMap=new Map(),inflight=new Map(),failAt=new Map(),fetchQuote,usFallbackQuote,
  cacheMs=2000,quoteMaxAge=10000,stats={quote:{fetched:0,staleServed:0,cooldownHits:0}},now=Date.now}={}) {
  const resource=createCachedResource({cache:cacheMap,inflight,failures:failAt,ttlMs:cacheMs,retryMs:60000,maxEntries:32,now,loader:async symbol=>{
    try {const value=publishQuote(await fetchQuote(symbol));stats.quote.fetched++;return value;}
    catch(error) {const fallback=await usFallbackQuote?.(symbol);if(fallback)return publishQuote(fallback);throw error;}
  }});
  async function getCachedQuote(symbol) {
    const old=cacheMap.get(symbol);
    const quote=await resource.get(symbol,{swr:!!old&&now()-old.ts<quoteMaxAge});
    const failed=failAt.get(symbol),entry=cacheMap.get(symbol);
    if(failed&&entry&&failed.at>=entry.ts) {
      stats.quote.staleServed++;
      return {...quote,stale:true,staleInfo:{reason:'source-unavailable',retryAt:failed.retryAt}};
    }
    return quote;
  }
  return {getCachedQuote,fallbackInflight:new Map(),close:resource.close,reopen:resource.reopen};
}
