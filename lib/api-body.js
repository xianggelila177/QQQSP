import {contextError} from './api-error.js';
export function readJsonBody(req,signal,limit=8192){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,done=false;
  const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);signal.removeEventListener('abort',abort);};
  const finish=(e,value)=>{if(done)return;done=true;cleanup();if(e){req.resume();reject(e);}else resolve(value);};
  const data=chunk=>{bytes+=chunk.length;if(bytes>limit)finish(contextError('BODY_TOO_LARGE',413));else chunks.push(chunk);};
  const end=()=>{try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{finish(contextError('BAD_JSON'));}};
  const error=()=>finish(contextError('REQUEST_CANCELLED',499)),abort=()=>finish(signal.reason);
  req.on('data',data);req.once('end',end);req.once('error',error);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
}
