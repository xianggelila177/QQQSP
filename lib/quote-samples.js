import {createSampleStore} from './sample-store.js';
import {symbolValid} from './symbol-validation.js';

export function createQuoteSamples({engine,getWatchlist=()=>[],now=Date.now,directory='',enabled=true,tickMs=1000,maxBytes,store:providedStore}={}) {
  const store=providedStore||createSampleStore({directory,now,maxBytes});
  const listeners=new Set(),errors=new Map();
  let running=false,initialized=false,timer=null,release=null,unsubscribe=null,membership=[],nextFlush=0,init=null,persistenceStatus='';
  function collect(symbols=membership) {
    for(const q of engine.read(symbols,{lease:false})){
      if(!membership.includes(q.symbol))continue;
      const error=q.error||q.pending?'等待有效报价':q.recovery||q.stale||q.staleInfo?'来源暂不可用，保留已有采样':null;
      if(errors.get(q.symbol)!==error)store.touch(q.symbol);errors.set(q.symbol,error);
      store.accept(q);
    }
  }
  function reconcile() {
    const list=[...new Set(getWatchlist().filter(s=>typeof s==='string'&&symbolValid(s)))].slice(0,12);
    if(list.join(',')===membership.join(','))return;
    const previous=release;for(const symbol of new Set([...membership,...list]))store.touch(symbol);membership=list;release=list.length?engine.watch(list):null;previous?.();
    for(const symbol of errors.keys())if(!list.includes(symbol))errors.delete(symbol);
  }
  function snapshot(symbol) {
    const data=store.snapshot(symbol),collecting=enabled&&running&&membership.includes(symbol);
    const error=!data.supported?data.reason:errors.get(symbol)||data.capacityError||null;
    return {...data,enabled,collecting,status:!data.supported?'unsupported':!collecting?'paused':error||data.persistenceError?'degraded':data.points.length?'collecting':'warming',error};
  }
  function runDue() {
    if(!running||!initialized)return;
    reconcile();collect();
    if(now()<nextFlush)return;
    nextFlush=Math.floor(now()/60000)*60000+60000;store.prune();
    for(const symbol of membership)store.touch(symbol);
    emit();
    void store.flush().then(()=>{
      const d=store.diagnostics(),status=JSON.stringify([d.loadError,d.saveError]);
      if(running&&status!==persistenceStatus){persistenceStatus=status;for(const symbol of membership)store.touch(symbol);emit();}
    });
  }
  function emit(){
    const updates=store.takeUpdates().map(update=>{const {points,...meta}=snapshot(update.symbol);return {...meta,points:update.points};});
    if(updates.length)for(const listener of listeners)listener(updates);
  }
  function start(){
    if(!enabled||running)return init||Promise.resolve();running=true;
    init=(initialized?Promise.resolve():store.restore()).then(()=>{
      initialized=true;if(!running)return;reconcile();
      unsubscribe=engine.subscribe(symbols=>{if(running)collect(symbols.filter(s=>membership.includes(s)));});
      runDue();timer=setInterval(runDue,tickMs);timer.unref?.();
    });return init;
  }
  async function stop(){if(running&&initialized)collect();running=false;clearInterval(timer);release?.();release=null;membership=[];unsubscribe?.();unsubscribe=null;await init;await store.flush();await store.flush();}
  return {start,stop,runDue,snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    diagnostics:()=>({enabled,running,initialized,watchlist:[...membership],...store.diagnostics()})};
}
