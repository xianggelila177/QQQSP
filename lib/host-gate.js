import {createTaskQueue} from './task-queue.js';
import {setTimeout as delay} from 'node:timers/promises';
import {providerRetryAt} from './providers/provider-retry.js';
import {hostGroup,minimumGap} from './source-registry.js';

// 单进程、每来源一条轻量串行链。没有用户配额、分布式锁或重试任务队列。
// 冷却期间快速失败并由业务读取旧缓存；绝不把 Retry-After 提前当作探测时机。
export function createHostGate({now=Date.now,minGap=minimumGap,baseMs=30000,capMs=900000,maxQueued=32,deadlineMs=20000}={}) {
  const hosts=new Map();let controller=new AbortController();
  function state(key,group=key) {
    if(!hosts.has(key))hosts.set(key,{group,queue:createTaskQueue({maxActive:1,maxQueued,now}),lastStart:-Infinity,until:0,failures:0,busy:false,calls:0,rateLimits:0,suppressed:0,lastStatus:null});
    return hosts.get(key);
  }
  function blocked(s) {
    s.suppressed++;
    return Object.assign(new Error('来源冷却中'),{code:'SOURCE_COOLDOWN',status:429,retryAt:s.until,retryAfterMs:Math.max(0,s.until-now())});
  }
  function run(url,work,{signal,deadlineAt=now()+deadlineMs,gatePartition,priority=0}={}) {
    const group=hostGroup(url);
    // Finnhub REST credentials have separate upstream quotas. The partition is
    // an opaque slot number, never a token; all other hosts keep their shared gate.
    const key=group==='finnhub.io'&&/^rest-[0-7]$/.test(gatePartition||'')?group+':'+gatePartition:group;
    const s=state(key,group);
    const lifetime=controller.signal;
    const combined=signal?AbortSignal.any([lifetime,signal]):lifetime;
    return s.queue.run(async taskSignal=>{
      const combined=taskSignal;combined.throwIfAborted();
      if(s.until>now())throw blocked(s);
      const wait=Math.max(0,s.lastStart+minGap(group)-now());
      if(wait)await delay(wait,undefined,{signal:combined});
      combined.throwIfAborted();if(s.until>now())throw blocked(s);
      s.lastStart=now();s.calls++;s.busy=true;
      try {
        const response=await work(combined);s.lastStatus=response?.status??null;
        if(response?.status===429) {
          s.rateLimits++;s.failures++;
          s.until=providerRetryAt(response.headers,now(),Math.min(capMs,baseMs*2**Math.min(s.failures-1,8)));
        } else if(response?.status===403&&group!=='finnhub.io') {
          s.failures++;s.until=providerRetryAt(response.headers,now(),300000);
        } else if(response?.status===403) {
          // Finnhub 403 is often a per-dataset entitlement denial. The candle
          // adapter cools its route; quote and metric requests keep their slot.
          s.failures=0;s.until=0;
        } else if(response?.status>=500) {
          s.failures++;s.until=providerRetryAt(response.headers,now(),Math.min(60000,5000*2**Math.min(s.failures-1,4)));
        } else if(response?.status>=200&&response.status<400) {
          s.failures=0;s.until=0;
        }
        return response;
      } catch(error) {
        if(!combined.aborted) {s.failures++;s.until=Math.max(s.until,now()+Math.min(60000,5000*2**Math.min(s.failures-1,4)));}
        throw error;
      } finally {s.busy=false;}
    },{signal:combined,deadlineAt,priority});
  }
  function diagnostics() {
    return Object.fromEntries([...hosts].map(([host,s])=>[host,{calls:s.calls,rateLimits:s.rateLimits,suppressed:s.suppressed,lastStatus:s.lastStatus,retryAt:s.until>now()?s.until:null,
      state:s.until>now()?'cooldown':s.busy&&s.failures?'probing':s.busy?'requesting':'ready',failures:s.failures,minGapMs:minGap(s.group),...s.queue.diagnostics()}]));
  }
  return {run,diagnostics,close(){controller.abort(Object.assign(new Error('服务停止'),{code:'STOPPED'}));for(const s of hosts.values())s.queue.close();},reopen(){if(controller.signal.aborted)controller=new AbortController();for(const s of hosts.values())s.queue.reopen();},
    yahooPolicy:{gatewayManaged:true,state:()=>{const s=state('yahoo');return {blocked:s.until>now(),until:s.until,halfOpen:false,streak:s.failures};},hit(){},clearStreak(){},events:()=>state('yahoo').rateLimits,recoverIfUnchanged(){},reset(){const s=state('yahoo');s.until=0;s.failures=0;},expire(){state('yahoo').until=0;}}
  };
}
