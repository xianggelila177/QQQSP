import {mergeOrderBook} from './order-book.js';
import {createTaskQueue} from './task-queue.js';
import {buildBasicMetrics,BASIC_FIELDS} from './fundamentals.js';
import {normalizeFinancialRecord,selectFinancialRecord,deriveFinancialFields,usableFinancialField} from './financial-candidates.js';
import {mergeTradingStatistics} from './trading-statistics.js';

export function createMultiSourceFundamentals({sources,now=Date.now,enabled=true,ttlMs=21600000,retryMs=300000,maxAgeMs=604800000,onUpdate=()=>{},maxEntries=128}={}){
  const specs=sources.map((s,order)=>({ttlMs:60000,order,...s}));
  const liveBySymbol=new Map(),liveSpecs=new Map();
  const cache=new Map(),liveCache=new Map(),failures=new Map(),warming=new Map(),quotes=new Map();let running=false,epoch=0;
  // One slot remains available for public facts even when financial statements stall.
  const queues={public:createTaskQueue({maxActive:1,maxQueued:64,now}),slow:createTaskQueue({maxActive:1,maxQueued:64,now})};
  const key=(id,symbol)=>id+':'+symbol;
  function entries(symbol){return [...specs.map(s=>({id:s.id,data:cache.get(key(s.id,symbol)),failure:failures.get(key(s.id,symbol))})),...[...(liveBySymbol.get(symbol)?.values()||[])].map(data=>({id:'live:'+data.source,data}))];}
  function allSpecs(){return [...specs,...liveSpecs.values()];}
  const select=symbol=>selectFinancialRecord(symbol,entries(symbol),allSpecs(),{now:now(),maxAgeMs});
  function trim(){while(quotes.size>maxEntries){const symbol=quotes.keys().next().value;quotes.delete(symbol);liveBySymbol.delete(symbol);for(const s of specs){const k=key(s.id,symbol);warming.get(k)?.abort();warming.delete(k);cache.delete(k);failures.delete(k);}for(const [k,v] of liveCache)if(v.symbol===symbol)liveCache.delete(k);}}
  function wanted(spec,quote){
    const excluded=quote.instrumentType!=='EQUITY'?['priceToBook','peTTM','peLYR','psTTM','marketCap','floatMarketCap','trailingEps','annualEps','revenueTTM','bookValue']:[];
    // Field priority selects the displayed value, never whether an otherwise
    // applicable source is allowed to refresh. Every source keeps its own TTL.
    return spec.fields.some(k=>!excluded.includes(k));
  }
  function warm(spec,quote){
    const symbol=quote.symbol,k=key(spec.id,symbol),old=cache.get(k),failure=failures.get(k);
    if(!running||!enabled||warming.has(k)||failure?.retryAt>now()||old&&now()-old.fetchedAt<spec.ttlMs||spec.match&&!spec.match(quote))return;
    if(!wanted(spec,quote))return;
    const queue=queues[spec.lane==='slow'?'slow':'public'];
    if(queue.diagnostics().queued>=64)return; // local congestion is not an upstream failure
    const controller=new AbortController(),owner=epoch;warming.set(k,controller);
    void queue.run(async signal=>{
      if(!wanted(spec,quotes.get(symbol)||quote))return null;
      const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(Object.assign(new Error('Financial deadline exceeded'),{code:'DEADLINE_EXCEEDED'})),20000),taskSignal=AbortSignal.any([signal,timeout.signal]);
      try{const value=await spec.load(symbol,{signal:taskSignal,quote:quotes.get(symbol)||quote});taskSignal.throwIfAborted();return normalizeFinancialRecord(symbol,value,{source:spec.id,now:now(),ttlMs:spec.ttlMs,maxAgeMs,previous:cache.get(k)});}finally{clearTimeout(timer);}
    },{signal:controller.signal}).then(record=>{if(record&&running&&owner===epoch&&!controller.signal.aborted){cache.set(k,record);failures.delete(k);}},error=>{
      if(!running||owner!==epoch||controller.signal.aborted)return;
      const n=Math.min((failures.get(k)?.n||0)+1,8),code=['FUNDAMENTALS_IDENTITY','FUNDAMENTALS_EMPTY','FUNDAMENTALS_CURRENCY','FUNDAMENTALS_INCOMPLETE','RATE_LIMITED','SOURCE_COOLDOWN','DEADLINE_EXCEEDED','FUNDAMENTALS_UNSUPPORTED'].includes(error.code)?error.code:'FUNDAMENTALS_SOURCE';
      failures.set(k,{code,n,at:now(),retryAt:Math.max(now()+Math.min(retryMs*2**(n-1),900000),Number(error.retryAt)||0)});
    }).finally(()=>{if(warming.get(k)===controller){warming.delete(k);if(running)onUpdate(symbol);}});
  }
  function decorate(quote){
    if(!quote||quote.error||quote.pending||!quote.symbol)return quote;
    const security=['EQUITY','ETF','MUTUALFUND'].includes(quote.instrumentType||'EQUITY');
    quotes.set(quote.symbol,quote);trim();
    const live=quote.financials,spec=specs.find(s=>s.id===live?.source),stamp=live?.fetchedAt,liveKey=key(live?.source,quote.symbol);
    if(enabled&&live?.symbol===quote.symbol&&typeof live.source==='string'&&Number.isFinite(stamp)&&stamp<=now()+5000&&stamp>(liveCache.get(liveKey)?.fetchedAt||0)){
      try{const normalized=normalizeFinancialRecord(quote.symbol,live,{source:live.source,now:stamp,ttlMs:spec?.ttlMs||60000,maxAgeMs,previous:liveCache.get(liveKey)});
        liveCache.set(liveKey,normalized);
        if(!liveBySymbol.has(quote.symbol))liveBySymbol.set(quote.symbol,new Map());
        liveBySymbol.get(quote.symbol).set(live.source,normalized);
        liveSpecs.set(live.source,{...spec,priority:spec?.priority??20,id:'live:'+live.source});
      }catch{}
    }
    let record=enabled?select(quote.symbol):null;
    if(security)for(const s of specs)warm(s,quote);
    for(const entry of entries(quote.symbol))if(entry.data?.statistics)quote=mergeTradingStatistics(quote,{symbol:quote.symbol,currency:entry.data.statistics.currency,tradingStats:entry.data.statistics},{now:now()});
    for(const entry of entries(quote.symbol))if(entry.data?.orderBook)quote=mergeOrderBook(quote,{symbol:quote.symbol,currency:entry.data.orderBook.currency,orderBook:entry.data.orderBook},now());
    record=deriveFinancialFields(quote,record);
    // Individual field ages are already enforced; one newly fetched field must
    // not renew the lifetime of any older field in the assembled record.
    const f=buildBasicMetrics(quote,record,{now:now(),ttlMs:Infinity,maxAgeMs,enabled});
    const out={...quote,...(f.instrumentType!==quote.instrumentType?{instrumentType:f.instrumentType,instrumentTypeSource:'provider'}:{}),fundamentals:f};
    for(const [key,field] of Object.entries(record?.fields||{}))if(!BASIC_FIELDS.includes(key))f.fields[key]=field;
    const hi=f.fields.week52High,lo=f.fields.week52Low;
    if(hi?.value>0&&lo?.value>0&&hi.value>=lo.value){out.week52High=hi.value;out.week52Low=lo.value;}
    const simple={open:out.open,prev:out.prevClose,high:out.dayHigh,low:out.dayLow,volume:out.volume,w52h:out.week52High,w52l:out.week52Low,exch:out.exchangeName};
    const missing=Object.entries(simple).filter(([,v])=>v==null||v==='').map(([k])=>k);
    const applicable=BASIC_FIELDS.filter(k=>f.fields[k].status!=='not-applicable');
    const missingFinancial=applicable.filter(k=>!usableFinancialField(k,f.fields[k]));
    const available=Object.keys(simple).length-missing.length+applicable.length-missingFinancial.length,stale=Object.values(f.fields).some(v=>v.stale),loading=specs.some(s=>warming.has(key(s.id,quote.symbol)));
    f.coverage={total:Object.keys(simple).length+BASIC_FIELDS.length,applicable:Object.keys(simple).length+applicable.length,available,missing:[...missing,...missingFinancial]};
    f.statisticsDate=out.tradingStats?.tradeDate||null;f.retainedStatistics=!!out.tradingStats?.retained;
    f.loading=loading;f.stale=stale;f.status=!enabled?'disabled':!security?'not-applicable':stale?'stale':!available?loading?'loading':'unavailable':f.coverage.missing.length?'partial':'complete';
    f.refreshMs=60000;f.sourceStates=Object.fromEntries(specs.filter(s=>!s.match||s.match(quote)).map(s=>{const k=key(s.id,quote.symbol),data=cache.get(k),failure=failures.get(k);return [s.id,{state:warming.has(k)?'loading':failure?'failed':data?'ready':'pending',code:failure?.code||null,lastSuccessAt:data?.fetchedAt||null,retryAt:failure?.retryAt??(data?data.fetchedAt+s.ttlMs:null)}];}));
    for(const name of missingFinancial)f.fields[name]={...f.fields[name],attempts:specs.filter(s=>s.fields.includes(name)&&(!s.match||s.match(quote))).map(s=>({source:s.id,...f.sourceStates[s.id]}))};
    for(const name of ['week52High','week52Low'])if(!f.fields[name]&&out[name]==null)f.fields[name]={value:null,status:'unavailable',reason:'source-missing',attempts:specs.filter(s=>s.fields.includes(name)&&(!s.match||s.match(quote))).map(s=>({source:s.id,...f.sourceStates[s.id]}))};
    return out;
  }
  function stop(){running=false;epoch++;for(const c of warming.values())c.abort();warming.clear();for(const q of Object.values(queues))q.close();}
  return {decorate,start(){running=true;for(const q of Object.values(queues))q.reopen();},stop,
    retain(symbols){const keep=new Set(symbols);for(const s of specs)for(const [k,c] of warming)if(k.startsWith(s.id+':')&&!keep.has(k.slice(s.id.length+1))){c.abort();warming.delete(k);}},
    clear(){cache.clear();liveCache.clear();liveBySymbol.clear();liveSpecs.clear();failures.clear();},
    diagnostics:()=>({enabled,running,ttlMs,maxAgeMs,entries:cache.size,inflight:warming.size,failures:failures.size,queue:{active:Object.values(queues).reduce((n,q)=>n+q.diagnostics().active,0),maxActive:2,queued:Object.values(queues).reduce((n,q)=>n+q.diagnostics().queued,0)},sources:Object.fromEntries(specs.map(s=>[s.id,{ttlMs:s.ttlMs,fields:s.fields,securities:Object.fromEntries([...quotes.keys()].map(symbol=>{const k=key(s.id,symbol),data=cache.get(k),failure=failures.get(k);return [symbol,{lastSuccessAt:data?.fetchedAt||null,inflight:warming.has(k),missingFields:s.fields.filter(f=>!usableFinancialField(f,data?.fields?.[f])),...failure,retryAt:failure?.retryAt??(data?data.fetchedAt+s.ttlMs:null)}];}))}]))})};
}
