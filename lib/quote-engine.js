import {mergeOrderBook} from './order-book.js';
import {chartRevision} from './chart-revision.js';
import {mergeQuoteHistory} from './quote-history-merge.js';

const at=q=>{const value=Number(q?.quoteAt??q?.ts)||0;return value>0&&value<1e12?value*1000:value;};
// 大图表不进入逐秒 JSON.stringify；其摘要由现有 WeakMap 版本缓存复用。
export function quoteSignature(q) {
  if(!q)return '';
  const {charts,slowFields,...head}=q;
  const fields=Object.fromEntries(Object.entries(slowFields||{}).map(([k,{ageMs,refreshState,...v}])=>[k,v]));
  delete head.quoteAgeMs;delete head.snapshotAgeMs;delete head.pollAfterMs;
  return JSON.stringify([head,fields,charts?Object.entries(charts).map(([k,v])=>[k,chartRevision(v)]):null]);
}
export function createQuoteEngine({readQuote,decorateQuote=value=>value,now=Date.now,onMembership=()=>{},tickMs=1000,leaseMs=15000,eventCoalesceMs=100}={}) {
  const quotes=new Map(),signatures=new Map(),inflight=new Map(),clients=new Map(),leases=new Map(),listeners=new Set();
  let timer=null,flushTimer=null,pokeTimer=null,running=false,epoch=0;const dirty=new Set(),poked=new Set(),readAgain=new Set();
  const active=()=>new Set([...clients.values()].flat().concat([...leases].filter(([,until])=>until>now()).map(([s])=>s)));
  function membership() {
    for(const [s,until] of leases)if(until<=now())leases.delete(s);
    const symbols=active();onMembership([...symbols]);
    for(const s of quotes.keys())if(!symbols.has(s)){quotes.delete(s);signatures.delete(s);}
    return symbols;
  }
  function emitSoon(symbol) {
    dirty.add(symbol);if(flushTimer)return;
    flushTimer=setTimeout(()=>{flushTimer=null;const changed=[...dirty];dirty.clear();for(const listener of listeners)listener(changed);},50);flushTimer.unref?.();
  }
  function commit(symbol,value) {
    if(!value)return;
    const previous=quotes.get(symbol);
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
    const job=Promise.resolve().then(()=>running&&owner===epoch&&active().has(symbol)?readQuote(symbol):null).then(value=>{
      if(running&&owner===epoch&&active().has(symbol))commit(symbol,value);
    },error=>{if(running&&owner===epoch&&active().has(symbol))commit(symbol,{symbol,error:'行情来源暂不可用',code:error.code||'SOURCE_UNAVAILABLE'});})
      .finally(()=>{if(inflight.get(symbol)!==job)return;inflight.delete(symbol);if(readAgain.delete(symbol)&&running&&owner===epoch&&active().has(symbol))void update(symbol);});
    inflight.set(symbol,job);return job;
  }
  function tick() {if(running)for(const symbol of membership())void update(symbol);}
  function read(symbols,{lease=true}={}) {
    if(lease){const before=active();for(const symbol of symbols)leases.set(symbol,now()+leaseMs);membership();for(const symbol of symbols)if(!before.has(symbol))void update(symbol);}
    return symbols.map(symbol=>quotes.get(symbol)||{symbol,pending:true,code:'PENDING',error:'等待首次报价'});
  }
  function watch(symbols) {
    const before=active(),token=Symbol();clients.set(token,[...symbols]);membership();for(const symbol of symbols)if(!before.has(symbol))void update(symbol);
    return ()=>{clients.delete(token);membership();};
  }
  function poke(symbol) {
    if(!running||!active().has(symbol))return;
    poked.add(symbol);if(pokeTimer)return;
    // Collapse bursty trade/book notifications before reading or decorating.
    // A notification received during a read is replayed once with the latest state.
    pokeTimer=setTimeout(()=>{pokeTimer=null;const symbols=[...poked];poked.clear();const wanted=active();for(const s of symbols)if(running&&wanted.has(s))void update(s);},eventCoalesceMs);
    pokeTimer.unref?.();
  }
  return {read,watch,poke,tick,subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    start(){if(running)return;running=true;timer=setInterval(tick,tickMs);timer.unref?.();tick();},
    stop(){running=false;epoch++;clearInterval(timer);clearTimeout(flushTimer);clearTimeout(pokeTimer);timer=flushTimer=pokeTimer=null;clients.clear();leases.clear();dirty.clear();poked.clear();readAgain.clear();inflight.clear();quotes.clear();signatures.clear();onMembership([]);},
    diagnostics:()=>({active:[...active()],subscribers:clients.size,quotes:quotes.size,inflight:inflight.size})};
}
