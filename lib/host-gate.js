import {setTimeout as delay} from 'node:timers/promises';
import {providerRetryAt} from './providers/provider-retry.js';
import {hostGroup,minimumGap} from './source-registry.js';

// 单进程、每来源一条轻量串行链。没有用户配额、分布式锁或重试任务队列。
// 冷却期间快速失败并由业务读取旧缓存；绝不把 Retry-After 提前当作探测时机。
export function createHostGate({now=Date.now,minGap=minimumGap,baseMs=30000,capMs=900000}={}) {
  const hosts=new Map();let controller=new AbortController();
  function state(key) {
    if(!hosts.has(key))hosts.set(key,{tail:Promise.resolve(),lastStart:-Infinity,until:0,failures:0,busy:false,calls:0,rateLimits:0,suppressed:0,lastStatus:null});
    return hosts.get(key);
  }
  function blocked(s) {
    s.suppressed++;
    return Object.assign(new Error('来源冷却中'),{code:'SOURCE_COOLDOWN',status:429,retryAt:s.until,retryAfterMs:Math.max(0,s.until-now())});
  }
  function run(url,work,{signal}={}) {
    const key=hostGroup(url),s=state(key);
    const lifetime=controller.signal;
    const combined=signal?AbortSignal.any([lifetime,signal]):lifetime;
    const previous=s.tail;
    const task=(async()=>{
      await previous;combined.throwIfAborted();
      if(s.until>now())throw blocked(s);
      const wait=Math.max(0,s.lastStart+minGap(key)-now());
      if(wait)await delay(wait,undefined,{signal:combined});
      combined.throwIfAborted();if(s.until>now())throw blocked(s);
      s.lastStart=now();s.calls++;s.busy=true;
      try {
        const response=await work(combined);s.lastStatus=response?.status??null;
        if(response?.status===429) {
          s.rateLimits++;s.failures++;
          s.until=providerRetryAt(response.headers,now(),Math.min(capMs,baseMs*2**Math.min(s.failures-1,8)));
        } else if(response?.status===403) {
          s.failures++;s.until=providerRetryAt(response.headers,now(),300000);
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
    })();
    s.tail=task.catch(()=>{});return task;
  }
  function diagnostics() {
    return Object.fromEntries([...hosts].map(([host,s])=>[host,{calls:s.calls,rateLimits:s.rateLimits,suppressed:s.suppressed,lastStatus:s.lastStatus,retryAt:s.until>now()?s.until:null,
      state:s.until>now()?'cooldown':s.busy&&s.failures?'probing':s.busy?'requesting':'ready',failures:s.failures,minGapMs:minGap(host)}]));
  }
  return {run,diagnostics,close(){controller.abort(Object.assign(new Error('服务停止'),{code:'STOPPED'}));},reopen(){if(controller.signal.aborted)controller=new AbortController();},
    yahooPolicy:{gatewayManaged:true,state:()=>{const s=state('yahoo');return {blocked:s.until>now(),until:s.until,halfOpen:false,streak:s.failures};},hit(){},clearStreak(){},events:()=>state('yahoo').rateLimits,recoverIfUnchanged(){},reset(){const s=state('yahoo');s.until=0;s.failures=0;},expire(){state('yahoo').until=0;}}
  };
}
