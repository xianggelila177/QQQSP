/** A sink callback owns at most one record; pending plus active bytes are bounded. */
export function createBoundedWriter(write, {maxBytes=262144}={}) {
  const queue=[];let bytes=0,active=false,dropped=0,errors=0,written=0,peakBytes=0;
  const waiters=new Set();
  async function drain(){
    if(active)return;active=true;
    try{while(queue.length){const item=queue.shift();try{await write(item.text);written++;}catch{errors++;}finally{bytes-=item.bytes;}}}
    finally{active=false;for(const resolve of waiters)resolve();waiters.clear();}
  }
  function enqueue(text){
    const size=Buffer.byteLength(text);
    if(size+bytes>maxBytes){dropped++;return false;}
    bytes+=size;peakBytes=Math.max(peakBytes,bytes);queue.push({text,bytes:size});void drain();return true;
  }
  return Object.freeze({enqueue,idle:()=>!active?Promise.resolve():new Promise(resolve=>waiters.add(resolve)),diagnostics:()=>({bytes,maxBytes,peakBytes,queued:queue.length,active,dropped,errors,written})});
}
