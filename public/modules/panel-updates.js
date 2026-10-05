(() => {
  const validVersion=value=>typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value));
  function createPanelUpdates({window,document,navigator,location,pageVersion,onStatus=()=>{},now=Date.now,
    MessageChannel=window.MessageChannel,setTimeout=window.setTimeout.bind(window),clearTimeout=window.clearTimeout.bind(window),
    checkIntervalMs=300000,minCheckMs=60000,versionTimeoutMs=2000}={}){
    const sw=navigator.serviceWorker,seen=new WeakSet(),listeners=[],guardKey='qqqsp:panel-update-reload:v1';
    let registration=null,starting=null,checking=null,lastCheck=-Infinity,timer=null,stopped=false,
      hadController=!!sw?.controller,allowAuto=!!sw?.controller,readyVersion=null,unknownController=null,reloadAttempted=false;
    const online=()=>navigator.onLine!==false,visible=()=>!document.hidden;
    const status=(state,extra={})=>onStatus({state,pageVersion,version:readyVersion,...extra});
    function listen(target,type,handler){target?.addEventListener?.(type,handler);listeners.push(()=>target?.removeEventListener?.(type,handler));}
    function workerVersion(worker){
      if(!worker||typeof MessageChannel!=='function')return Promise.resolve(null);
      return new Promise(resolve=>{
        const channel=new MessageChannel();let done=false;
        const finish=value=>{if(done)return;done=true;clearTimeout(timeout);channel.port1.close();channel.port2.close();resolve(value);};
        const timeout=setTimeout(()=>finish(null),versionTimeoutMs);
        channel.port1.onmessage=event=>finish(event.data?.type==='QQQSP_VERSION'&&validVersion(event.data.version)?event.data.version:null);
        try{worker.postMessage({type:'QQQSP_GET_VERSION'},[channel.port2]);}catch{finish(null);}
      });
    }
    function reload(manual=false){
      if(stopped||reloadAttempted||!readyVersion||!online()||!visible()||!manual&&!allowAuto)return false;
      // A denied/unavailable session store disables automatic navigation; the
      // persistent button remains usable without risking a reload loop.
      let storageAvailable=false;
      try{
        const storage=window.sessionStorage,previous=JSON.parse(storage.getItem(guardKey)||'null');
        if(!manual&&previous?.from===pageVersion&&previous?.to===readyVersion&&now()-previous.at<120000)return false;
        storage.setItem(guardKey,JSON.stringify({from:pageVersion,to:readyVersion,at:now()}));storageAvailable=true;
      }catch{}
      if(!manual&&!storageAvailable)return false;
      reloadAttempted=true;location.reload();return true;
    }
    async function inspectController(auto=allowAuto){
      const controller=sw?.controller;if(!controller||stopped)return;
      const version=await workerVersion(controller);
      if(stopped||controller!==sw.controller)return;
      // Older deployed workers (including v111) cannot answer the protocol.
      // Do not label a timeout current or infer their version from the server.
      if(!version){readyVersion=null;unknownController=controller;status('unknown',{canReload:true,reason:'CONTROLLER_VERSION_UNAVAILABLE'});return;}
      unknownController=null;
      // A rollback is also a new deployment. Only an identical shell is current.
      if(validVersion(pageVersion)&&Number(version)===Number(pageVersion)){readyVersion=null;status('current');return;}
      readyVersion=version;status('ready');if(auto)reload();
    }
    function watch(worker){
      if(!worker||seen.has(worker))return;seen.add(worker);
      const changed=()=>{
        if(stopped)return;
        if(worker.state==='installed')status('installing');
        if(worker.state==='activated')void inspectController();
      };
      listen(worker,'statechange',changed);changed();
    }
    function schedule(){clearTimeout(timer);if(stopped)return;timer=setTimeout(()=>{void check();schedule();},checkIntervalMs);}
    async function start(){
      if(stopped||!sw)return null;if(starting)return starting;
      starting=sw.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(reg=>{
        if(stopped)return reg;registration=reg;lastCheck=now();
        listen(reg,'updatefound',()=>watch(reg.installing));watch(reg.installing);watch(reg.waiting);
        void inspectController();schedule();return reg;
      }).catch(()=>{starting=null;status('error');schedule();return null;});
      return starting;
    }
    function check(force=false){
      if(stopped||!online()||!visible())return Promise.resolve(false);
      if(readyVersion)reload();
      if(checking)return checking;
      if(!force&&now()-lastCheck<minCheckMs)return Promise.resolve(false);
      lastCheck=now();status('checking');
      checking=(async()=>{
        const reg=registration||await start();if(!reg||stopped)return false;
        await reg.update();watch(reg.installing);watch(reg.waiting);await inspectController();
        return true;
      })().catch(()=>{status('error');return false;}).finally(()=>{checking=null;});
      return checking;
    }
    async function activate(){
      if(readyVersion)return reload(true);
      // This explicit user action may reload the coherent shell held by an
      // unknown legacy controller. Automatic checks never take this path.
      if(unknownController&&unknownController===sw?.controller)return reloadUnknown();
      await check(true);return readyVersion?reload(true):reloadUnknown();
    }
    function reloadUnknown(){
      if(stopped||reloadAttempted||!unknownController||unknownController!==sw?.controller||!online()||!visible())return false;
      reloadAttempted=true;location.reload();return true;
    }
    listen(sw,'controllerchange',()=>{const auto=hadController;hadController=!!sw.controller;readyVersion=null;unknownController=null;if(auto)allowAuto=true;void inspectController(auto);});
    listen(window,'online',()=>{if(readyVersion)reload();void check();});
    listen(window,'focus',()=>{void check();});
    listen(window,'pageshow',()=>{schedule();if(readyVersion)reload();void check();});
    listen(window,'pagehide',()=>{clearTimeout(timer);timer=null;});
    listen(document,'visibilitychange',()=>{if(visible()){if(readyVersion)reload();void check();}});
    return Object.freeze({start,check,activate,stop(){stopped=true;clearTimeout(timer);listeners.splice(0).forEach(remove=>remove());}});
  }
  window.PANEL_UPDATES=Object.freeze({createPanelUpdates});
})();
