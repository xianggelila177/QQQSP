import {parseCv,applyChartVersions} from './http-charts.js';
import {createStreamBudget} from './stream-budget.js';
// One stream per page; quote and history producers remain application-owned.
export function createSse({engine,historyPrewarm,now=Date.now,heartbeatMs=15000,budget=createStreamBudget()}={}) {
  const connections=new Map();
  function open(req,res,symbols,rawCv,retainHistory=true,cors={}) {
    const headers={'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff',...cors};
    if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
    if(!budget.acquire(res)){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5',...cors});res.end(JSON.stringify({code:'SSE_CAPACITY_EXCEEDED'}));return;}
    let closed=false,pulse,unhistory,releaseHistory,unwatch,unsubscribe;
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(pulse);unwatch?.();unsubscribe?.();unhistory?.();releaseHistory?.();connections.delete(res);budget.release(res);};
    res.once('close',cleanup);res.once('error',cleanup);connections.set(res,cleanup);
    res.writeHead(200,headers);res.flushHeaders();if(!budget.write(res,'retry: 3000\n\n')){cleanup();return;}
    const wanted=new Set(symbols),cv=parseCv(rawCv);
    const write=(event,value)=>{if(!closed&&!res.destroyed)budget.write(res,'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n');};
    const push=list=>{const quotes=applyChartVersions(engine.read(list,{lease:false}),cv);write('quotes',{serverNow:now(),quotes});for(const q of quotes)cv.set(q.symbol,{iVer:q.intradayVer,dVer:q.daily30Ver});};
    if(retainHistory)releaseHistory=historyPrewarm?.lease?.(res,symbols);
    const pushHistory=list=>{if(historyPrewarm&&retainHistory)write('history',historyPrewarm.snapshot(list));};
    if(retainHistory)unhistory=historyPrewarm?.subscribe(changed=>{const subset=changed.filter(s=>wanted.has(s));if(subset.length)pushHistory(subset);});
    unwatch=engine.watch(symbols);unsubscribe=engine.subscribe(changed=>{const subset=changed.filter(s=>wanted.has(s));if(subset.length)push(subset);});
    pulse=setInterval(()=>write('heartbeat',{serverNow:now()}),heartbeatMs);pulse.unref?.();push(symbols);pushHistory(symbols);
  }
  return {open,close(){for(const [res,cleanup] of connections){cleanup();res.end();}},diagnostics:budget.diagnostics};
}
