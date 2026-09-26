import {mergeOrderBook} from './order-book.js';
import {chartRevision} from './chart-revision.js';
import {mergeQuoteHistory} from './quote-history-merge.js';
import {MAX_ACTIVE_QUOTE_SYMBOLS} from './watchlist-limits.js';

const at=q=>{const value=Number(q?.quoteAt??q?.ts)||0;return value>0&&value<1e12?value*1000:value;};
// 大图表不进入逐秒 JSON.stringify；其摘要由现有 WeakMap 版本缓存复用。
export function quoteSignature(q) {
  if(!q)return '';
  const {charts,slowFields,regularChart,...head}=q;
  if(regularChart){const {bars,...meta}=regularChart;head.regularChart={...meta,revision:chartRevision(bars)};}
  const fields=Object.fromEntries(Object.entries(slowFields||{}).map(([k,{ageMs,refreshState,...v}])=>[k,v]));
  delete head.quoteAgeMs;delete head.snapshotAgeMs;delete head.pollAfterMs;
  return JSON.stringify([head,fields,charts?Object.entries(charts).map(([k,v])=>[k,chartRevision(v)]):null]);
}
export function createQuoteEngine({readQuote,decorateQuote=value=>value,now=Date.now,onMembership=()=>{},tickMs=1000,leaseMs=15000,eventCoalesceMs=100,maxSymbols=MAX_ACTIVE_QUOTE_SYMBOLS}={}) {
  const quotes=new Map(),signatures=new Map(),inflight=new Map(),clients=new Map(),leases=new Map(),listeners=new Set();
  const activeSymbols=new Set(),watchers=new Map();let membershipDirty=false,rejected=0;
  const future=q=>Number(q?.quoteAt??at(q))>now()+5000;
  let timer=null,flushTimer=null,pokeTimer=null,running=false,epoch=0;const dirty=new Set(),poked=new Set(),readAgain=new Set();
  const isActive=symbol=>activeSymbols.has(symbol)&&(watchers.has(symbol)||(leases.get(symbol)||0)>now());
  function add(symbol){if(!activeSymbols.has(symbol)){activeSymbols.add(symbol);membershipDirty=true;}}
  function drop(symbol){if(!watchers.has(symbol)&&!leases.has(symbol)&&activeSymbols.delete(symbol)){membershipDirty=true;quotes.delete(symbol);signatures.delete(symbol);}}
  function membership() {
    const at=now();for(const [s,until] of leases)if(until<=at){leases.delete(s);drop(s);}
    if(membershipDirty){membershipDirty=false;onMembership([...activeSymbols]);}
    return activeSymbols;
  }
  function admit(symbols){
    membership();const added=[...new Set(symbols)].filter(s=>!activeSymbols.has(s));
    if(activeSymbols.size+added.length>maxSymbols){rejected++;throw Object.assign(new Error('活跃证券数量达到上限'),{code:'QUOTES_CAPACITY_EXCEEDED',statusCode:503,maxSymbols});}
    return added;
  }
  function emitSoon(symbol) {
    dirty.add(symbol);if(flushTimer)return;
    flushTimer=setTimeout(()=>{flushTimer=null;const changed=[...dirty];dirty.clear();for(const listener of listeners)listener(changed);},50);flushTimer.unref?.();
  }
  function commit(symbol,value) {
    if(!value)return;
    const cached=quotes.get(symbol),previous=future(cached)?null:cached;
    // A pre-open maintenance timestamp must not outrank an actual trade or
    // lock the engine against the provider's subsequent corrected timestamp.
    if(value.price!=null&&future(value))value={symbol,error:'行情来源时间异常',code:'SOURCE_TIME_INVALID'};
    if(previous?.price!=null&&(value.error||value.pending))value={...previous,stale:true,error:undefined,pending:undefined,staleInfo:{reason:value.code||'source-unavailable'}};
    if(previous?.price!=null&&at(previous)>at(value)&&!String(value.realtimeStatus||'').includes('INVALIDATED')) {
      // 忽略迟到的较旧价格，但保留明确的断线/来源故障状态。
      value={...mergeOrderBook(mergeQuoteHistory(previous,value),value,now()),realtimeStatus:value.realtimeStatus??previous.realtimeStatus,...(value.stale?{stale:true,staleInfo:value.staleInfo}:{})};
    }
    // Independent slow facts must be calculated against the retained price,
    // after the late-quote guard, never against a rejected older tick.
    value=decorateQuote(value);
    const signature=quoteSignature(value);
    if(signature===signatures.get(symbol))return;
    quotes.set(symbol,value);signatures.set(symbol,signature);emitSoon(symbol);
  }
  function update(symbol) {
    if(!running)return;
    if(inflight.has(symbol)){readAgain.add(symbol);return inflight.get(symbol);}
    const owner=epoch;
    const job=Promise.resolve().then(()=>running&&owner===epoch&&isActive(symbol)?readQuote(symbol):null).then(value=>{
      if(running&&owner===epoch&&isActive(symbol))commit(symbol,value);
    },error=>{if(running&&owner===epoch&&isActive(symbol))commit(symbol,{symbol,error:'行情来源暂不可用',code:error.code||'SOURCE_UNAVAILABLE'});})
      .finally(()=>{if(inflight.get(symbol)!==job)return;inflight.delete(symbol);if(readAgain.delete(symbol)&&running&&owner===epoch&&isActive(symbol))void update(symbol);});
    inflight.set(symbol,job);return job;
  }
  function tick() {if(running)for(const symbol of membership())void update(symbol);}
  function read(symbols,{lease=true}={}) {
    if(lease){const added=admit(symbols),until=now()+leaseMs;for(const symbol of symbols){leases.set(symbol,until);add(symbol);}membership();for(const symbol of added)void update(symbol);}
    return symbols.map(symbol=>quotes.get(symbol)||{symbol,pending:true,code:'PENDING',error:'等待首次报价'});
  }
  function watch(symbols) {
    const list=[...new Set(symbols)],added=admit(list),token=Symbol();clients.set(token,list);
    for(const symbol of list){watchers.set(symbol,(watchers.get(symbol)||0)+1);add(symbol);}membership();for(const symbol of added)void update(symbol);
    return ()=>{if(!clients.delete(token))return;for(const symbol of list){const n=watchers.get(symbol)-1;if(n)watchers.set(symbol,n);else watchers.delete(symbol);drop(symbol);}membership();};
  }
  function poke(symbol) {
    if(!running||!isActive(symbol))return;
    poked.add(symbol);if(pokeTimer)return;
    // Collapse bursty trade/book notifications before reading or decorating.
    // A notification received during a read is replayed once with the latest state.
    pokeTimer=setTimeout(()=>{pokeTimer=null;const symbols=[...poked];poked.clear();for(const s of symbols)if(running&&isActive(s))void update(s);},eventCoalesceMs);
    pokeTimer.unref?.();
  }
  async function refreshNow(symbols) {
    read(symbols);
    await Promise.all(symbols.map(async symbol=>{
      if(inflight.has(symbol))await inflight.get(symbol);
      await update(symbol);
    }));
    return read(symbols,{lease:false});
  }
  return {read,watch,poke,tick,refreshNow,subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    start(){if(running)return;running=true;timer=setInterval(tick,tickMs);timer.unref?.();tick();},
    stop(){running=false;epoch++;clearInterval(timer);clearTimeout(flushTimer);clearTimeout(pokeTimer);timer=flushTimer=pokeTimer=null;clients.clear();leases.clear();watchers.clear();activeSymbols.clear();membershipDirty=false;dirty.clear();poked.clear();readAgain.clear();inflight.clear();quotes.clear();signatures.clear();onMembership([]);},
    diagnostics:()=>({active:[...membership()],maxSymbols,rejected,subscribers:clients.size,quotes:quotes.size,inflight:inflight.size})};
}
