// A backup is subscribed only while the primary has no usable stream for that
// symbol. Provider state stays separate; never splice statistics across feeds.
export function createStreamPair(primary,backup){
 const needsBackup=s=>{const d=primary?.read(s);return !d?.trade||d.state!=='streaming';};
 return {supports:s=>!!(primary?.supports(s)||backup?.supports(s)),
   touch(s){const a=primary?.supports(s)&&primary.touch(s);const b=needsBackup(s)&&backup?.supports(s)&&backup.touch(s);return !!(a||b);},
   retain(symbols){primary?.retain(symbols);backup?.retain(symbols.filter(needsBackup));},
   read(s){const a=primary?.read(s),b=backup?.read(s);if(a?.state==='streaming'&&a.trade)return a;if(b?.trade&&(!a?.trade||b.trade.quoteAt>=a.trade.quoteAt))return b;return a||b;},
   start(){primary?.start();backup?.start();},stop(){primary?.stop();backup?.stop();},
   subscribe(fn){const a=primary?.subscribe(fn),b=backup?.subscribe(fn);return ()=>{a?.();b?.();};},
   diagnostics:()=>({enabled:true,primary:primary?.diagnostics()||null,backup:backup?.diagnostics()||null})};
}
