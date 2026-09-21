import {randomUUID} from 'node:crypto';
import {buildMarketContext} from './market-context-format.js';
import {createStreamBudget} from './stream-budget.js';
import {contextError} from './api-error.js';
// Coalesced quote snapshots, not a trade tape. Reconnect gets a fresh snapshot,
// not an unbounded replay log. The default stream has no forced lease deadline.
export function createApiQuoteStream({engine,keys,budget=createStreamBudget(),now=Date.now,leaseMs=0,tickMs=1000}={}){
 if(!Number.isSafeInteger(leaseMs)||leaseMs<0||leaseMs>2147483647)throw new RangeError('leaseMs must be zero or a positive timer duration');
 const connections=new Set(),perKey=new Map();
 function open(req,res,symbols,principal,headers){
  if(!engine||connections.size>=16||(perKey.get(principal.family)||0)>=2)throw contextError('CONTEXT_BUSY',503);
  if(!budget.acquire(res))throw contextError('CONTEXT_BUSY',503);
  let release,unlisten,timer,deadline,lastSent=0,lastSignature=null,dirty=true,closed=false;
  const id=randomUUID();let revision=0;
  const close=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(deadline);unlisten?.();release?.();res.off('close',close);budget.release(res);connections.delete(close);const n=(perKey.get(principal.family)||1)-1;if(n)perKey.set(principal.family,n);else perKey.delete(principal.family);if(!res.destroyed&&!res.writableEnded)res.end();};
  connections.add(close);perKey.set(principal.family,(perKey.get(principal.family)||0)+1);res.once('close',close);
  const write=text=>{if(closed)return false;try{if(budget.write(res,text))return true;}catch{}close();return false;};
  const event=(type,data)=>{const body='id: '+id+':'+(++revision)+'\nevent: '+type+'\ndata: '+JSON.stringify(data)+'\n\n';if(Buffer.byteLength(body)>131072){close();return;}write(body);};
  const tick=()=>{
   if(closed)return;
   try{keys.authenticate(req);}catch(e){event('auth_error',{code:e.code});close();return;}
   if(budget.blocked(res))return;
   const at=now(),heartbeatDue=at-lastSent>=15000;
   if(dirty||heartbeatDue){
    try{const changed=dirty;dirty=false;const quotes=engine.read(symbols,{lease:false});
    const results=symbols.map(symbol=>buildMarketContext({query:{symbol,include:['quote'],daily_bar_count:1,sample_trading_days:1},requestId:id,generatedAt:at,quote:quotes.find(q=>q.symbol===symbol)}));
    // Time alone can change freshness or market state without an engine event.
    // Ignore envelope generation clocks when comparing these cached projections.
    const signature=JSON.stringify(results.map(({generated_at_ms,request_id,...business})=>business));
    if(changed||signature!==lastSignature){event('quote',{schema_version:1,generated_at_ms:at,results,delivery:'coalesced snapshots; intermediate ticks may be omitted'});lastSignature=signature;}
    else if(heartbeatDue)write(': heartbeat\n\n');
    lastSent=at;}catch{event('source_error',{code:'SOURCE_UNAVAILABLE'});close();return;}
   }
  };
  try{
   res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no',Connection:'keep-alive'});
   if(!write('retry: 1000\n\n'))return;release=engine.watch(symbols);unlisten=engine.subscribe(changed=>{if(changed.some(s=>symbols.includes(s)))dirty=true;});
   for(const symbol of symbols)engine.poke(symbol);tick();
   if(!closed){timer=setInterval(tick,tickMs);timer.unref?.();if(leaseMs>0){deadline=setTimeout(()=>{if(closed)return;try{keys.authenticate(req);event('end',{code:'LEASE_ENDED',reconnect_after_ms:1000});}catch(e){event('auth_error',{code:e.code});}finally{close();}},leaseMs);deadline.unref?.();}}
  }catch(e){close();throw e;}
 }
 return {open,close(){for(const close of [...connections])close();},diagnostics:()=>({connections:connections.size,maxConnections:16,maxPerKey:2,leaseMs,tickMs,delivery:leaseMs?'leased':'continuous',reconnectMs:1000})};
}
