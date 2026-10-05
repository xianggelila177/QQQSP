// Each HTTP instance owns its response work and socket buffers. A disconnected
// reader does not release a compressor that is still retaining its input.
export const RESPONSE_BUDGET=Symbol('response-budget');
export function createResponseBudget({maxActive=32,maxBytes=8*1024*1024,timeoutMs=20000}={}){
  const records=new Map();let reservedBytes=0,rejected=0,timeouts=0,closed=false;
  function reserve(res,bytes,{compressing=false}={}){
    if(closed||records.size>=maxActive||bytes>maxBytes-reservedBytes){rejected++;return null;}
    const record={bytes,compressing,finished:false,timer:null};
    const release=()=>{
      if(!record.finished||record.compressing||records.get(res)!==record)return;
      records.delete(res);reservedBytes-=record.bytes;clearTimeout(record.timer);
      res.off('finish',finish);res.off('close',finish);res.off('error',finish);
    };
    const finish=()=>{record.finished=true;clearTimeout(record.timer);release();};
    records.set(res,record);reservedBytes+=bytes;
    res.once('finish',finish);res.once('close',finish);res.once('error',finish);
    record.timer=setTimeout(()=>{timeouts++;finish();res.destroy();},timeoutMs);record.timer.unref?.();
    return {settleCompression(){record.compressing=false;release();},abort(){finish();res.destroy();}};
  }
  return Object.freeze({attach(res){res[RESPONSE_BUDGET]=this;},reserve,
    diagnostics:()=>({active:records.size,compressing:[...records.values()].filter(r=>r.compressing).length,reservedBytes,maxActive,maxBytes,timeoutMs,rejected,timeouts,closed}),
    close(){closed=true;for(const res of records.keys())res.destroy();},reopen(){closed=false;}
  });
}
