// Atomic-write policy belongs to the injected writer. This queue retains one
// active serialization and one latest pending capture, never a chain of bodies.
export function createLatestCheckpoint({write,capture,onError=()=>{},onSuccess=()=>{}}){
 let active=null,pending=null,requestedVersion=0,savedVersion=0,writes=0,serializations=0;
 async function drain(){
  try{while(pending){const entry=pending;pending=null;
   try{const body=JSON.stringify(entry.saved===undefined?capture():entry.saved);serializations++;writes++;
    await write(body);savedVersion=entry.version;onSuccess();entry.resolve();
   }catch(error){onError(error);entry.reject(error);}
  }}finally{active=null;}
 }
 function persist(saved){
  if(!pending){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});pending={promise,resolve,reject};}
  pending.saved=saved;pending.version=++requestedVersion;const promise=pending.promise;
  if(!active)active=Promise.resolve().then(drain);return promise;
 }
 return {persist,settled:()=>active||Promise.resolve(),diagnostics:()=>({active:!!active,pending:!!pending,requestedVersion,savedVersion,writes,serializations})};
}
