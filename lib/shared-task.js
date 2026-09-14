// Readers own cancellation; only the last departing reader cancels the producer.
export function createSharedTasks() {
  const jobs=new Map();
  function run(key,producer,{signal}={}) {
    if(signal?.aborted)return Promise.reject(signal.reason);
    let job=jobs.get(key);
    if(!job||job.controller.signal.aborted){
      const controller=new AbortController();job={controller,readers:0,promise:null};
      const current=job;
      job.promise=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return producer(controller.signal);})
        .finally(()=>{if(jobs.get(key)===current)jobs.delete(key);});
      jobs.set(key,job);
    }
    job.readers++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(err,value)=>{
        if(done)return;done=true;signal?.removeEventListener('abort',abort);job.readers--;
        if(!job.readers&&signal?.aborted)job.controller.abort(signal.reason);
        err?reject(err):resolve(value);
      };
      const abort=()=>finish(signal.reason);
      signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(value=>finish(null,value),finish);
    });
  }
  return {run,close(reason=Object.assign(new Error('Service stopped'),{code:'STOPPED'})){for(const job of jobs.values())job.controller.abort(reason);jobs.clear();},size:()=>jobs.size};
}
