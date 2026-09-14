import { log as defaultLog } from '../log.mjs';
export function createYahooBreaker({now=Date.now,base=30000,cap=120000,log=defaultLog}={}) {
  let until=0,streak=0,setAt=0,events=0,probeUsed=false,retryAt=0;
  function hit(src,retryAfter) {
    events++;streak++;setAt=now();
    const seconds=Number(retryAfter),date=Date.parse(retryAfter);
    const wait=retryAfter!=null&&String(retryAfter).trim()!=='' ? (Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(date)?Math.max(0,date-now()):0) : 0;
    retryAt=wait?now()+Math.min(wait,86400000):0;
    until=Math.max(now()+Math.min(base*2**Math.min(streak-1,30),cap),retryAt);probeUsed=false;
    log.warn('[yahoo 429]',{src,streak,blockMs:until-now()});
  }
  const state=()=>({blocked:now()<until,until,streak,setAt,events,probeUsed,retryAt,halfOpen:now()<until&&!probeUsed&&now()>=retryAt&&(now()-setAt)*2>=until-setAt});
  return {hit,state,clearStreak:()=>{streak=0;},reset:()=>{until=0;streak=0;setAt=0;events=0;probeUsed=false;retryAt=0;},expire:()=>{until=0;retryAt=0;},
    consumeProbe:()=>{if(!state().halfOpen)return false;probeUsed=true;return true;},events:()=>events,recoverIfUnchanged:before=>{if(events===before){until=0;streak=0;probeUsed=false;retryAt=0;}}};
}
