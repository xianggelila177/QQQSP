// Shared by quote and macro SSE; bounds sockets and actual Node writable buffers.
export function createStreamBudget({maxConnections=32,maxBufferedBytes=8*1024*1024,maxClientBytes=1024*1024}={}) {
  const clients=new Set(),blocked=new Set(),drains=new Map();let rejected=0,slowClosed=0;
  const buffered=()=>[...clients].reduce((n,res)=>n+(res.writableLength||0),0);
  return {
    acquire(res){if(clients.size>=maxConnections){rejected++;return false;}clients.add(res);const drain=()=>blocked.delete(res);drains.set(res,drain);res.on?.('drain',drain);return true;},
    release(res){clients.delete(res);blocked.delete(res);const drain=drains.get(res);if(drain)res.off?.('drain',drain);drains.delete(res);},
    blocked:res=>blocked.has(res),
    write(res,text){const size=Buffer.byteLength(text);if(res.destroyed||size+(res.writableLength||0)>maxClientBytes||size+buffered()>maxBufferedBytes){slowClosed++;res.destroy();return false;}if(!res.write(text))blocked.add(res);return true;},
    diagnostics:()=>({connections:clients.size,bufferedBytes:buffered(),maxConnections,maxBufferedBytes,maxClientBytes,rejected,slowClosed})
  };
}
