import {instrumentClassification,marketKeyFor} from './instruments.js';

// Per-application, bounded identity evidence. Search and quote observations use
// the same decision as history, trades and fundamentals; inferred types never
// overwrite a verified listing. Provider caches own network retry/cancellation.
export function createInstrumentRegistry({resolveIdentity,now=Date.now,maxEntries=300}={}) {
  const entries=new Map();
  function observe(symbol,meta={}) {
    const result=instrumentClassification(symbol,meta),old=entries.get(symbol);
    if(old&&old.until<=now())entries.delete(symbol);
    if(result.status==='confirmed'){
      const rank=result.source==='catalog'?100:result.source==='symbol'?95:result.source==='naver-search'?90:result.type==='EQUITY'?60:70;
      const held=entries.get(symbol);
      if(!held||rank>=held.rank){entries.delete(symbol);entries.set(symbol,{value:{...result,checkedAt:now()},rank,until:now()+86400000});}
      while(entries.size>maxEntries)entries.delete(entries.keys().next().value);
    }
    return entries.get(symbol)?.value||result;
  }
  const peek=(symbol,meta={})=>observe(symbol,meta);
  async function resolve(symbol,{quote={},instrumentType,signal}={}) {
    let result=observe(symbol,quote);
    if(instrumentType)result=observe(symbol,{instrumentType});
    if(result.status==='confirmed'||marketKeyFor(symbol)!=='us'||!resolveIdentity)return result;
    const identity=await resolveIdentity(symbol,{signal});
    signal?.throwIfAborted();
    if(identity?.instrumentType)result=observe(symbol,{instrumentType:identity.instrumentType,source:identity.provenance||'naver-search'});
    return result;
  }
  function decorate(quote){
    if(!quote?.symbol||quote.error||quote.pending)return quote;
    const classification=observe(quote.symbol,quote);
    return {...quote,instrumentType:classification.type,instrumentTypeSource:classification.source==='catalog'?'catalog':classification.status==='unknown'?'inferred':'provider',
      instrumentTypeEvidence:classification.source,classification};
  }
  return {observe,peek,resolve,decorate,clear:()=>entries.clear()};
}
