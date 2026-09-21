import {performance} from 'node:perf_hooks';
// The rolling window charges symbols; the three-request burst charges envelopes.
// This permits a ten-symbol batch without pretending it costs one unit.
export function createContextLimiter({now=()=>performance.now(),wallNow=Date.now}={}){
 const states=new Map();
 return {consume(cost=1,key='legacy'){
  if(!Number.isInteger(cost)||cost<1||cost>10)throw new TypeError('Invalid quota cost');
  const time=now();
  for(const [k,s] of states)if(time-s.at>60000)states.delete(k);
  let s=states.get(key);if(!s){if(states.size>=256)return {ok:false,retryAfter:60,limit:20,remaining:0,reset:Math.ceil((wallNow()+60000)/1000)};s={tokens:3,at:time,accepted:[]};states.set(key,s);}
  s.tokens=Math.min(3,s.tokens+Math.max(0,time-s.at)/3000);s.at=time;s.accepted=s.accepted.filter(x=>x.time>time-60000);
  const used=s.accepted.reduce((n,x)=>n+x.cost,0);let remaining=20-used,windowWait=0;
  if(cost>remaining){let freed=0;for(const x of s.accepted){freed+=x.cost;if(remaining+freed>=cost){windowWait=x.time+60000-time;break;}}}
  const wait=Math.max(windowWait,s.tokens<1?(1-s.tokens)*3000:0);
  const ok=wait<=0;
  if(ok){s.tokens--;s.accepted.push({time,cost});remaining-=cost;}
  const reset=Math.ceil((wallNow()+(s.accepted[0]?Math.max(0,s.accepted[0].time+60000-time):0))/1000);
  return {ok,limit:20,remaining,reset,burstRemaining:Math.floor(s.tokens),...(ok?{}:{retryAfter:Math.max(1,Math.ceil(wait/1000))})};
 },diagnostics:()=>({keys:states.size,limit:20,windowMs:60000,burst:3})};
}
export const quotaHeaders=q=>({'X-RateLimit-Limit':String(q.limit),'X-RateLimit-Remaining':String(q.remaining),'X-RateLimit-Reset':String(q.reset),'X-RateLimit-Burst-Remaining':String(q.burstRemaining??0)});
