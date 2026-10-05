(() => {
  'use strict';
  const status=document.getElementById('update-status');
  const retry=document.getElementById('update-retry');
  const progress=document.getElementById('update-progress');
  if(!status||!retry||!progress)return;
  const failure=code=>Object.assign(new Error(code),{code});
  let busy=false;
  const stable=worker=>{
    if(worker?.state!=='activated')return false;
    try{const url=new URL(worker.scriptURL,location.href);
      return url.origin===location.origin&&url.pathname==='/sw.js'&&!url.search&&!url.hash;
    }catch{return false;}
  };
  const current=(registration,worker)=>stable(worker)&&registration.active===worker&&
    navigator.serviceWorker.controller===worker&&!registration.installing&&!registration.waiting;
  function abortable(promise,signal){
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},
        error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  function activeWorker(registration,signal){
    return new Promise((resolve,reject)=>{
      let timer=null,candidate=null;
      const finish=(error,worker)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(worker);};
      const abort=()=>finish(signal.reason);
      const check=()=>{
        if(signal.aborted){abort();return;}
        const worker=registration.active;
        // Activation and clients.claim are separate steps. Wait until this
        // document is controlled by the same stable worker, with no pending
        // replacement, for two checks before asking it to identify its version.
        if(current(registration,worker)){
          if(candidate===worker){finish(null,worker);return;}
          candidate=worker;
        }else candidate=null;
        timer=setTimeout(check,200);
      };
      signal.addEventListener('abort',abort,{once:true});check();
    });
  }
  function workerVersion(worker,signal){
    return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();let done=false;
      const finish=(error,version)=>{
        if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        channel.port1.onmessage=null;channel.port1.close();channel.port2.close();error?reject(error):resolve(version);
      };
      const abort=()=>finish(signal.reason);
      const timer=setTimeout(()=>finish(failure('VERSION_UNCONFIRMED')),4000);
      signal.addEventListener('abort',abort,{once:true});
      channel.port1.onmessage=event=>{
        const value=event.data,version=value?.version;
        if(value?.type!=='QQQSP_VERSION'||typeof version!=='string'||!/^[1-9]\d{0,11}$/.test(version)){
          finish(failure('VERSION_UNCONFIRMED'));return;
        }
        finish(null,version);
      };
      if(signal.aborted){abort();return;}
      try{worker.postMessage({type:'QQQSP_GET_VERSION'},[channel.port2]);}
      catch{finish(failure('VERSION_UNCONFIRMED'));}
    });
  }
  async function update(){
    if(busy)return;busy=true;retry.hidden=true;retry.disabled=true;progress.hidden=false;
    status.dataset.state='loading';status.textContent='正在取得最新页面…';
    const controller=new AbortController(),signal=controller.signal;
    const timer=setTimeout(()=>controller.abort(failure('UPDATE_TIMEOUT')),30000);
    try{
      if(!('serviceWorker' in navigator)||typeof MessageChannel!=='function')throw failure('UNSUPPORTED');
      const registration=await abortable(navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}),signal);
      await abortable(registration.update(),signal);
      status.textContent='正在启用更新后的页面…';
      while(!signal.aborted){
        const worker=await activeWorker(registration,signal);
        const version=await workerVersion(worker,signal);
        // A replacement can arrive during the handshake. Verify the worker
        // again so a reply from a previous controller cannot confirm success.
        if(!current(registration,worker))continue;
        status.dataset.state='complete';status.textContent='更新已完成（版本 '+version+'），正在返回行情页…';
        progress.hidden=true;
        location.replace('/?updated='+encodeURIComponent(version));return;
      }
      throw signal.reason;
    }catch(error){
      status.dataset.state='error';progress.hidden=true;retry.hidden=false;retry.disabled=false;
      status.textContent=navigator.onLine===false?'当前离线，请连接网络后点击重试。':
        error?.code==='UNSUPPORTED'?'当前浏览器不支持自动更新。请在支持的浏览器中打开此页。':
        error?.code==='VERSION_UNCONFIRMED'?'尚未确认新页面已生效，请点击重试。':
        error?.code==='UPDATE_TIMEOUT'?'更新尚未完成，请稍后点击重试。':'本次更新未完成，请检查网络后点击重试。';
    }finally{clearTimeout(timer);controller.abort(failure('ATTEMPT_FINISHED'));busy=false;}
  }
  retry.addEventListener('click',()=>void update());
  void update();
})();
