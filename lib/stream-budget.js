// Shared by quote and macro SSE; bounds sockets and actual Node writable buffers.
export function createStreamBudget({maxConnections=32,maxBufferedBytes=8*1024*1024,maxClientBytes=1024*1024}={}) {
  const clients=new Set();let rejected=0,slowClosed=0;
  const buffered=()=>[...clients].reduce((n,res)=>n+(res.writableLength||0),0);
  return {
    acquire(res){if(clients.size>=maxConnections){rejected++;return false;}clients.add(res);return true;},
    release(res){clients.delete(res);},
    write(res,text){const size=Buffer.byteLength(text);if(res.destroyed||size+(res.writableLength||0)>maxClientBytes||size+buffered()>maxBufferedBytes){slowClosed++;res.destroy();return false;}res.write(text);return true;},
    diagnostics:()=>({connections:clients.size,bufferedBytes:buffered(),maxConnections,maxBufferedBytes,maxClientBytes,rejected,slowClosed})
  };
}
