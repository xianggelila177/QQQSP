import {streamAvailability,selectStream} from './stream-policy.js';
// Providers keep separate statistics. Selection is per-security, not per-socket.
export function createStreamPair(primary,backup,{now=Date.now}={}) {
 const needsBackup=s=>streamAvailability(s,primary?.read(s),now()).needsBackup;
 return {supports:s=>!!(primary?.supports(s)||backup?.supports(s)),
   touch(s){const a=primary?.supports(s)&&primary.touch(s);const b=needsBackup(s)&&backup?.supports(s)&&backup.touch(s);return !!(a||b);},
   retain(symbols){primary?.retain(symbols);backup?.retain(symbols.filter(needsBackup));},
   read(s){return selectStream(s,primary?.read(s),backup?.read(s),now());},
   start(){primary?.start();backup?.start();},stop(){primary?.stop();backup?.stop();},
   subscribe(fn){const a=primary?.subscribe(fn),b=backup?.subscribe(fn);return ()=>{a?.();b?.();};},
   diagnostics:()=>({enabled:true,primary:primary?.diagnostics()||null,backup:backup?.diagnostics()||null})};
}
