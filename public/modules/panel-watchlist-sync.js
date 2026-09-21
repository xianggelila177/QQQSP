(() => {
  // A failed write keeps the latest revision. Only one write is in flight.
  function createWatchlistSync({network,getToken=()=>'',onStatus=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,maxRetries=5}={}) {
    let pending=null,revision=0,active=false,timer=null,failures=0,paused=false,blocked=false;
    const report=(state,extra={})=>onStatus({state,pending:pending!==null,...extra});
    const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;};
    async function drain() {
      if(active||paused||blocked||pending===null)return;
      clear();active=true;
      try {
        while(pending!==null&&!paused&&!blocked){
          const item=pending;report('saving');
          let response;
          try {const token=getToken();response=await network.request('watchlist','/api/history/watchlist',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Admin-Token':token}:{})},body:JSON.stringify({symbols:item.symbols})});}
          catch(error){if(paused||error.name==='AbortError')break;response={ok:false,status:0};}
          if(response.ok){if(pending?.revision===item.revision)pending=null;failures=0;report(pending?'saving':'saved');continue;}
          if(response.status===401||response.status===403){blocked=true;report('auth-required');break;}
          if([400,413,415].includes(response.status)){blocked=true;report('invalid');break;}
          failures++;
          if(failures>maxRetries){report('failed');break;}
          const delay=Math.max(Math.min(1000*2**(failures-1),30000),Math.max(0,(response.retryAt||0)-now()));
          report('retrying',{retryAt:now()+delay,attempt:failures});
          timer=setTimer(()=>{timer=null;void drain();},delay);break;
        }
      } finally {active=false;}
    }
    return Object.freeze({
      save(symbols){pending={symbols:[...symbols],revision:++revision};failures=0;clear();void drain();},
      retry(){blocked=false;failures=0;clear();void drain();},
      pause(){paused=true;clear();network.abort?.('watchlist');},
      resume(){paused=false;void drain();},
      state:()=>({pending:pending!==null,active,blocked,failures})
    });
  }
  window.PANEL_WATCHLIST_SYNC=Object.freeze({createWatchlistSync});
})();
