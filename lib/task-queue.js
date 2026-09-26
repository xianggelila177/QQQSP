// A bounded queue, FIFO within each priority. Cancellation removes waiting work immediately. An active slot
// remains owned until the producer settles, even when its reader has timed out.
export function createTaskQueue({maxActive=1,maxQueued=32,now=Date.now}={}) {
  const waiting=[],running=new Set();
  let closed=false,rejected=0,cancelled=0,completed=0,waitTotalMs=0,waitMaxMs=0;
  const error=(code,message,statusCode=503)=>Object.assign(new Error(message),{code,statusCode});
  function drain() {
    while(!closed&&running.size<maxActive&&waiting.length) {
      const job=waiting.shift();
      if(job.controller.signal.aborted)continue;
      job.started=true;running.add(job);
      const waited=Math.max(0,now()-job.queuedAt);waitTotalMs+=waited;waitMaxMs=Math.max(waitMaxMs,waited);
      Promise.resolve().then(()=>{job.controller.signal.throwIfAborted();return job.fn(job.controller.signal);})
        .then(value=>job.finish(null,value),err=>job.finish(err))
        .finally(()=>{running.delete(job);completed++;drain();});
    }
  }
  function run(fn,{signal,deadlineAt,priority=0}={}) {
    if(closed)return Promise.reject(error('STOPPED','Queue stopped'));
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(deadlineAt!=null&&deadlineAt<=now())return Promise.reject(error('DEADLINE_EXCEEDED','Operation deadline exceeded',504));
    if(running.size>=maxActive&&waiting.length>=maxQueued){rejected++;return Promise.reject(error('CAPACITY_EXCEEDED','Request capacity exhausted'));}
    let job;
    const promise=new Promise((resolve,reject)=>{
      const controller=new AbortController();let settled=false,timer;
      const abort=()=>job.cancel(signal.reason);
      job={fn,controller,started:false,priority:priority===1?1:0,queuedAt:now(),finish(err,value){
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);
      },cancel(reason=error('REQUEST_CANCELLED','Request cancelled',499)){
        if(settled)return;cancelled++;controller.abort(reason);
        if(!job.started){const index=waiting.indexOf(job);if(index>=0)waiting.splice(index,1);}
        job.finish(reason);drain();
      }};
      signal?.addEventListener('abort',abort,{once:true});
      if(deadlineAt!=null)timer=setTimeout(()=>job.cancel(error('DEADLINE_EXCEEDED','Operation deadline exceeded',504)),Math.max(0,deadlineAt-now()));
      const index=waiting.findIndex(queued=>queued.priority<job.priority);
      if(index<0)waiting.push(job);else waiting.splice(index,0,job);
      drain();
    });
    promise.cancel=reason=>job.cancel(reason);return promise;
  }
  return {run,close(){closed=true;for(const job of [...waiting,...running])job.cancel(error('STOPPED','Queue stopped'));},reopen(){closed=false;drain();},
    diagnostics:()=>({active:running.size,queued:waiting.length,maxActive,maxQueue:maxQueued,rejected,cancelled,completed,waitTotalMs,waitMaxMs,oldestQueuedMs:waiting.length?Math.max(0,now()-Math.min(...waiting.map(job=>job.queuedAt))):0,closed})};
}
