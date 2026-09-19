import {parseCv,applyChartVersions} from './http-charts.js';
import {createStreamBudget} from './stream-budget.js';
// Queue symbol identities, not full charts. Each connection drains one bounded
// symbol frame at a time; updates coalesce while the socket is backpressured.
export function createSse({engine,historyPrewarm,samples,now=Date.now,heartbeatMs=15000,budget=createStreamBudget()}={}) {
  const connections=new Map();
  function open(req,res,symbols,rawCv,retainHistory=true,cors={}) {
    const headers={'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff',...cors};
    if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
    if(!budget.acquire(res)){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5',...cors});res.end(JSON.stringify({code:'SSE_CAPACITY_EXCEEDED'}));return;}
    let closed=false,pulse,scheduled,stall,unhistory,unsamples,releaseHistory,unwatch,unsubscribe;
    const pending=new Set(),sampleUpdates=new Map(),wanted=new Set(symbols),cv=parseCv(rawCv);
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(pulse);clearImmediate(scheduled);clearTimeout(stall);res.off('drain',schedule);pending.clear();sampleUpdates.clear();unwatch?.();unsubscribe?.();unhistory?.();unsamples?.();releaseHistory?.();connections.delete(res);budget.release(res);};
    function write(event,value){if(closed||res.destroyed)return false;const ok=budget.write(res,'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n');if(!ok)cleanup();return ok;}
    function schedule(){if(closed||scheduled||!pending.size)return;scheduled=setImmediate(pump);}
    function enqueue(kind,list){for(const symbol of list)if(wanted.has(symbol))pending.add(kind+':'+symbol);schedule();}
    function pump(){
      scheduled=null;if(closed||!pending.size)return;
      if(budget.blocked?.(res)){if(!stall){stall=setTimeout(()=>{res.destroy();cleanup();},30000);stall.unref?.();}return;}
      clearTimeout(stall);stall=null;
      const key=pending.values().next().value;pending.delete(key);const cut=key.indexOf(':'),kind=key.slice(0,cut),symbol=key.slice(cut+1);
      if(kind==='quotes'){
        const quotes=applyChartVersions(engine.read([symbol],{lease:false}),cv);
        if(write('quotes',{serverNow:now(),quotes}))for(const q of quotes)cv.set(q.symbol,{iVer:q.intradayVer,dVer:q.daily30Ver});
      }else if(kind==='history')write('history',historyPrewarm.snapshot([symbol]));
      else if(kind==='samples'){const entry=sampleUpdates.get(symbol);sampleUpdates.delete(symbol);if(entry)write('samples',{serverNow:now(),entries:[entry]});}
      else write('heartbeat',{serverNow:now()});
      schedule();
    }
    res.once('close',cleanup);res.once('error',cleanup);res.on('drain',schedule);connections.set(res,cleanup);
    res.writeHead(200,headers);res.flushHeaders();if(!budget.write(res,'retry: 3000\n\n')){cleanup();return;}
    if(retainHistory)releaseHistory=historyPrewarm?.lease?.(res,symbols);
    if(retainHistory)unhistory=historyPrewarm?.subscribe(changed=>enqueue('history',changed));
    unwatch=engine.watch(symbols);unsubscribe=engine.subscribe(changed=>enqueue('quotes',changed));
    unsamples=samples?.subscribe(entries=>{
      for(const entry of entries)if(wanted.has(entry.symbol)){
        const previous=sampleUpdates.get(entry.symbol),days=new Set(entry.tradingDays||[]),points=new Map();
        for(const point of [...(previous?.points||[]),...(entry.points||[])])if(days.has(point.tradingDate))points.set(point.tradingDate+':'+Math.floor(point.t/60),point);
        sampleUpdates.set(entry.symbol,{...entry,points:[...points.values()]});
      }
      // Truly stalled clients reconnect and obtain a complete sample snapshot.
      if(Buffer.byteLength(JSON.stringify([...sampleUpdates.values()]))>1024*1024){res.destroy();cleanup();return;}
      enqueue('samples',entries.map(entry=>entry.symbol));
    });
    if(samples&&!write('samples',{serverNow:now(),reset:true,symbols}))return;
    pulse=setInterval(()=>{pending.add('heartbeat:');schedule();},heartbeatMs);pulse.unref?.();enqueue('quotes',symbols);if(historyPrewarm&&retainHistory)enqueue('history',symbols);
  }
  return {open,close(){for(const [res,cleanup] of connections){cleanup();res.end();}},diagnostics:budget.diagnostics};
}
