import {createStreamBudget} from './stream-budget.js';
export function createMacroSse({monitor,heartbeatMs=15000,budget=createStreamBudget()}={}) {
 const clients=new Map();
 function open(req,res,cors={}) {
  const headers={'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no',...cors};
  if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return;}
  if(!budget.acquire(res)){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5',...cors});res.end(JSON.stringify({code:'SSE_CAPACITY_EXCEEDED'}));return;}
  let done=false,timer,unsubscribe;
  const cleanup=()=>{if(done)return;done=true;clearInterval(timer);unsubscribe?.();clients.delete(res);budget.release(res);};
  clients.set(res,cleanup);res.on('close',cleanup);res.on('error',cleanup);
  res.writeHead(200,headers);res.flushHeaders?.();if(!budget.write(res,'retry: 3000\n\n')){cleanup();return;}
  const write=data=>{if(!done)budget.write(res,'id: '+data.revision+'\nevent: macro\ndata: '+JSON.stringify(data)+'\n\n');};
  unsubscribe=monitor.subscribe(write);write(monitor.snapshot());if(done)return;
  timer=setInterval(()=>{if(!done)budget.write(res,': keepalive\n\n');},heartbeatMs);timer.unref?.();
 }
 return {open,close(){for(const [res,cleanup] of clients){cleanup();res.end();}},size:()=>clients.size,diagnostics:budget.diagnostics};
}
