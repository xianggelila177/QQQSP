import {parseCv,applyChartVersions} from './http-charts.js';
// One stream per page; no server-side polling per connection, no replay queue.
// Reconnect sends the authoritative current snapshot, so no lost-tick replay is needed.
export function createSse({engine,now=Date.now,heartbeatMs=15000}={}){
  const connections=new Set();
  function open(req,res,symbols,rawCv){
    if(req.method==='HEAD'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.end();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    res.flushHeaders();res.write('retry: 3000\n\n');
    const wanted=new Set(symbols),cv=parseCv(rawCv);
    let closed=false;
    const write=(event,value)=>{
      if(closed||res.destroyed)return;
      // A frozen browser can reconnect from a snapshot. Do not retain an unbounded queue.
      if(res.writableLength>1048576){res.destroy();return;}
      res.write('event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n');
    };
    const push=list=>{
      const quotes=applyChartVersions(engine.read(list,{lease:false}),cv);
      write('quotes',{serverNow:now(),quotes});
      for(const q of quotes)cv.set(q.symbol,{iVer:q.intradayVer,dVer:q.daily30Ver});
    };
    const unwatch=engine.watch(symbols);
    const unsubscribe=engine.subscribe(changed=>{const subset=changed.filter(s=>wanted.has(s));if(subset.length)push(subset);});
    const pulse=setInterval(()=>write('heartbeat',{serverNow:now()}),heartbeatMs);pulse.unref?.();
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(pulse);unwatch();unsubscribe();connections.delete(res);};
    res.once('close',cleanup);connections.add(res);push(symbols);
  }
  return {open,close(){for(const res of connections)res.end();connections.clear();}};
}
