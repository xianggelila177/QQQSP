(() => {
  function symbolsUrl(path,symbols,cv=''){
    const base=path+(path.includes('?')?'&':'?')+'symbols='+encodeURIComponent(symbols.join(','))+(path==='/api/stream'?'&historyDelta=1&regularDelta=1':'');
    const withVersions=base+'&cv='+encodeURIComponent(cv);
    // Nginx accepts request lines up to 8 KiB. Cache hints are optional;
    // membership is never truncated to squeeze a large watchlist into the URL.
    return withVersions.length<=6500?withVersions:base;
  }
  function createLiveStore({getSymbols,getCv,readSnapshot,onQuotes,onHistory=()=>{},onSamples=()=>{},onClock=()=>{},onState=()=>{},
    getPolicy=()=>({marketMs:2000}),getRetryAt=()=>0,EventSourceImpl=window.EventSource,now=Date.now}){
    let stream=null,reconnect=null,pollTimer=null,watchdog=null,paused=true,epoch=0,attempts=0,lastMessage=0,state='idle',polling=false;
    let lastPollAt=null,nextPollAt=null,membership=getSymbols().slice().sort().join(',');
    const quotes=new Map();
    function setState(value){if(state!==value){state=value;onState(value);}}
    function stopPolling(){clearTimeout(pollTimer);pollTimer=null;nextPollAt=null;}
    function reschedule(){
      if(paused||state!=='fallback'||polling||!getSymbols().length)return;
      const interval=Math.max(1000,Number(getPolicy().marketMs)||2000);
      const next=Math.max(lastPollAt===null?now():lastPollAt+interval,Number(getRetryAt())||0);
      if(pollTimer!==null&&nextPollAt===next)return;
      stopPolling();nextPollAt=next;pollTimer=setTimeout(poll,Math.max(0,next-now()));
    }
    async function poll(){
      stopPolling();if(paused||polling||state!=='fallback')return;
      polling=true;lastPollAt=now();
      try{await readSnapshot(false);}catch{/* Snapshot errors are rendered by the snapshot adapter. */}
      finally{polling=false;reschedule();}
    }
    function fallback(){setState('fallback');reschedule();}
    function clearConnection(){stream?.close();stream=null;clearTimeout(reconnect);reconnect=null;clearInterval(watchdog);watchdog=null;}
    function fail(owner){
      if(paused||owner!==epoch)return;epoch++;clearConnection();fallback();
      if(EventSourceImpl)reconnect=setTimeout(connect,Math.min(30000,3000*2**Math.min(attempts++,4)));
    }
    function connect(){
      if(paused||!getSymbols().length)return;
      clearConnection();const owner=++epoch;
      if(!EventSourceImpl){fallback();return;}
      if(state!=='fallback')setState('connecting');lastMessage=now();
      try{stream=new EventSourceImpl(symbolsUrl('/api/stream',getSymbols(),getCv()));}
      catch{fail(owner);return;}
      const receive=(event,kind)=>{
        if(owner!==epoch||paused)return;
        let payload;try{payload=JSON.parse(event.data);}catch{fail(owner);return;}
        lastMessage=now();onClock(payload.serverNow);stopPolling();attempts=0;setState('streaming');
        if(kind==='samples')onSamples(payload);
        else if(Array.isArray(payload.entries))onHistory(payload);
        if(Array.isArray(payload.quotes)){
          const wanted=new Set(getSymbols());for(const q of payload.quotes)if(wanted.has(q?.symbol))quotes.set(q.symbol,q);
          onQuotes(payload.quotes.filter(q=>wanted.has(q?.symbol)));
        }
      };
      for(const kind of ['quotes','heartbeat','history','samples'])stream.addEventListener(kind,event=>receive(event,kind));
      stream.onerror=()=>fail(owner);
      watchdog=setInterval(()=>{if(now()-lastMessage>35000)fail(owner);},5000);
    }
    function setSymbols(){
      const next=getSymbols().slice().sort().join(',');if(next===membership)return false;membership=next;
      const keep=new Set(getSymbols());for(const s of quotes.keys())if(!keep.has(s))quotes.delete(s);
      epoch++;clearConnection();stopPolling();lastPollAt=null;if(!paused)connect();return true;
    }
    function pause(){paused=true;epoch++;clearConnection();stopPolling();setState('paused');}
    function resume(){if(!paused){reschedule();return;}paused=false;connect();}
    return {pause,resume,setSymbols,reschedule,stop:pause,healthy:()=>state==='streaming',state:()=>state,quotes};
  }
  window.PANEL_LIVE_STORE=Object.freeze({createLiveStore,symbolsUrl});
})();
