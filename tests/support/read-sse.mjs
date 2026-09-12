export async function readSseEvent(reader,{event,timeoutMs=3000}={}){
  const decoder=new TextDecoder();let buffer='',timer;
  const operation=(async()=>{while(true){const {done,value}=await reader.read();if(done)throw new Error('SSE ended before requested event');buffer+=decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw new Error('SSE test response too large');let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event||frame.split('\n').some(line=>line==='event: '+event))return frame;}}})();
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new Error('SSE event deadline exceeded'));},timeoutMs);})]);}finally{clearTimeout(timer);}
}
