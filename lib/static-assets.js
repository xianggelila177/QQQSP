import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const failure=(code,message)=>Object.assign(new Error(message),{code,statusCode:503});
const changed=()=>failure('STATIC_ASSET_CHANGED','Static asset changed while loading');
const stamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');

// One instance owns cache and in-flight bytes separately. Reservations cover
// fixed-size read buffers, not the process heap or buffers held by responses.
export function createStaticCache({maxActive=8,maxBytes=8*1024*1024,maxCacheBytes=8*1024*1024,maxEntries=100,maxReaders=128,timeoutMs=20000}={}) {
  const cache=new Map(),inflight=new Map(),active=new Set();
  let reservedBytes=0,cacheBytes=0,readers=0,rejected=0,loads=0,hits=0,closed=false;
  const capacity=()=>{rejected++;return failure('STATIC_CAPACITY_EXCEEDED','Static loading capacity exhausted');};
  function remove(file){const old=cache.get(file);if(old){cache.delete(file);cacheBytes-=old.bytes;}}
  function remember(file,entry){
    if(entry.bytes>maxCacheBytes){remove(file);return;}
    remove(file);cache.set(file,entry);cacheBytes+=entry.bytes;
    while(cache.size>maxEntries||cacheBytes>maxCacheBytes)remove(cache.keys().next().value);
  }
  async function readVersion(file,stat,signal){
    signal.throwIfAborted();
    const handle=await fs.open(file,'r');
    try{
      signal.throwIfAborted();if(stamp(await handle.stat())!==stamp(stat))throw changed();
      // readFile can allocate beyond a prior stat if a file grows. A fixed
      // buffer plus version checks keeps the allocation inside its reservation.
      const data=Buffer.allocUnsafe(stat.size);let offset=0;
      while(offset<data.length){
        signal.throwIfAborted();
        const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);
        if(!bytesRead)throw changed();offset+=bytesRead;
      }
      signal.throwIfAborted();if(stamp(await handle.stat())!==stamp(stat))throw changed();
      return data;
    }finally{await handle.close();}
  }
  async function load(file,job){
    const signal=job.controller.signal;
    for(let attempt=0;attempt<2;attempt++){
      signal.throwIfAborted();
      const stat=await fs.stat(file);signal.throwIfAborted();
      if(!stat.isFile())throw Object.assign(new Error('not a file'),{code:'EISDIR'});
      const old=cache.get(file);
      if(old?.stamp===stamp(stat)){hits++;cache.delete(file);cache.set(file,old);return old;}
      if(!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>maxBytes-reservedBytes)throw capacity();
      job.bytes=stat.size;reservedBytes+=job.bytes;
      try{
        const variants=[];
        for(const suffix of ['.gz','.br']){
          const compressed=await fs.stat(file+suffix).catch(()=>null);signal.throwIfAborted();
          if(compressed?.isFile()&&compressed.mtimeMs>=stat.mtimeMs-1000&&Number.isSafeInteger(compressed.size)&&compressed.size>=0&&compressed.size<=maxBytes-reservedBytes){
            variants.push([suffix,compressed]);job.bytes+=compressed.size;reservedBytes+=compressed.size;
          }
        }
        const raw=await readVersion(file,stat,signal),encoded={gz:null,br:null};
        for(const [suffix,compressed] of variants){
          try{
            const allowance=Math.max(1,raw.length);
            if(allowance>maxBytes-reservedBytes)continue;
            // Timestamps cannot bind a sidecar to raw bytes during publication.
            // Verify once on cold load with a bounded output; keep ownership of
            // the decoder until its callback settles even if every reader left.
            job.bytes+=allowance;reservedBytes+=allowance;
            try{
              const data=await readVersion(file+suffix,compressed,signal);
              const decoded=await new Promise((resolve,reject)=>zlib[suffix==='.gz'?'gunzip':'brotliDecompress'](data,{maxOutputLength:allowance},(error,value)=>error?reject(error):resolve(value)));
              signal.throwIfAborted();if(decoded.equals(raw))encoded[suffix.slice(1)]=data;
            }finally{job.bytes-=allowance;reservedBytes-=allowance;}
          }
          catch(error){signal.throwIfAborted();/* optional representation: send can compress raw */}
        }
        if(stamp(await fs.stat(file))!==stamp(stat))throw changed();signal.throwIfAborted();
        const entry=Object.freeze({stamp:stamp(stat),mtimeMs:stat.mtimeMs,size:stat.size,raw,...encoded,bytes:raw.length+(encoded.gz?.length||0)+(encoded.br?.length||0)});
        remember(file,entry);loads++;return entry;
      }catch(error){if(error.code!=='STATIC_ASSET_CHANGED'||attempt===1)throw error;}
      finally{reservedBytes-=job.bytes;job.bytes=0;}
    }
  }
  function get(file,{signal}={}){
    if(closed)return Promise.reject(failure('STOPPED','Static service stopped'));
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(readers>=maxReaders)return Promise.reject(capacity());
    let job=inflight.get(file);
    if(!job||job.controller.signal.aborted){
      if(active.size>=maxActive)return Promise.reject(capacity());
      job={controller:new AbortController(),readers:0,bytes:0,settled:false};
      const owner=job;active.add(owner);inflight.set(file,owner);
      const timer=setTimeout(()=>owner.controller.abort(failure('STATIC_TIMEOUT','Static load timed out')),timeoutMs);timer.unref?.();
      owner.promise=Promise.resolve().then(()=>load(file,owner)).finally(()=>{
        owner.settled=true;clearTimeout(timer);active.delete(owner);
        if(inflight.get(file)===owner)inflight.delete(file);
      });
    }
    const owner=job;readers++;owner.readers++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,value)=>{
        if(done)return;done=true;readers--;owner.readers--;
        signal?.removeEventListener('abort',cancel);owner.controller.signal.removeEventListener('abort',stopped);
        if(error&&!owner.readers&&!owner.settled)owner.controller.abort(error);
        error?reject(error):resolve(value);
      };
      const cancel=()=>finish(signal.reason),stopped=()=>finish(owner.controller.signal.reason);
      signal?.addEventListener('abort',cancel,{once:true});owner.controller.signal.addEventListener('abort',stopped,{once:true});
      owner.promise.then(value=>finish(null,value),finish);
    });
  }
  return Object.freeze({cache,get,
    diagnostics:()=>({active:active.size,readers,reservedBytes,cacheBytes,entries:cache.size,maxActive,maxReaders,maxBytes,maxCacheBytes,maxEntries,loads,hits,rejected,closed}),
    close(){closed=true;for(const job of active)job.controller.abort(failure('STOPPED','Static service stopped'));cache.clear();cacheBytes=0;},
    reopen(){closed=false;}
  });
}
