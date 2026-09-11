(() => {
  // Owns the page's only market connection. Views do not manage reconnect timers.
  function createLiveStore({getSymbols,getCv,readSnapshot,onQuotes,onClock=()=>{},onState=()=>{},
    EventSourceImpl=window.EventSource,now=Date.now}){
    let stream=null,reconnect=null,pollTimer=null,watchdog=null,paused=true,epoch=0,attempts=0,lastMessage=0,state='idle',polling=false;
    const quotes=new Map();
    function setState(value){if(state!==value){state=value;onState(value);}}
    function stopPolling(){clearInterval(pollTimer);pollTimer=null;}
    async function poll(){if(paused||polling)return;polling=true;try{await readSnapshot(false);}finally{polling=false;}}
    function fallback(){if(!pollTimer){void poll();pollTimer=setInterval(poll,2000);}setState('fallback');}
    function clearConnection(){stream?.close();stream=null;clearTimeout(reconnect);reconnect=null;clearInterval(watchdog);watchdog=null;}
    function fail(owner){
      if(paused||owner!==epoch)return;epoch++;clearConnection();fallback();
      reconnect=setTimeout(connect,Math.min(30000,3000*2**Math.min(attempts++,4)));
    }
    function connect(){
      if(paused||!getSymbols().length)return;
      clearConnection();const owner=++epoch;
      if(!EventSourceImpl){fallback();return;}
      setState(pollTimer?'fallback':'connecting');lastMessage=now();
      try{stream=new EventSourceImpl('/api/stream?symbols='+encodeURIComponent(getSymbols().join(','))+'&cv='+encodeURIComponent(getCv()));}
      catch{fail(owner);return;}
      const receive=event=>{
        if(owner!==epoch||paused)return;
        let payload;try{payload=JSON.parse(event.data);}catch{fail(owner);return;}
        lastMessage=now();onClock(payload.serverNow);
        stopPolling();attempts=0;setState('streaming');
        if(Array.isArray(payload.quotes)){
          const wanted=new Set(getSymbols());for(const q of payload.quotes)if(wanted.has(q?.symbol))quotes.set(q.symbol,q);
          onQuotes(payload.quotes.filter(q=>wanted.has(q?.symbol)));
        }
      };
      stream.addEventListener('quotes',receive);stream.addEventListener('heartbeat',receive);
      stream.onerror=()=>fail(owner);
      // Measures transport heartbeats, never time since last trade. Quiet markets
      // must not cause reconnect storms or fabricated quote timestamps.
      watchdog=setInterval(()=>{if(now()-lastMessage>35000)fail(owner);},5000);
    }
    function setSymbols(){
      const keep=new Set(getSymbols());for(const s of quotes.keys())if(!keep.has(s))quotes.delete(s);
      epoch++;clearConnection();stopPolling();if(!paused)connect();
    }
    function pause(){paused=true;epoch++;clearConnection();stopPolling();setState('paused');}
    function resume(){if(!paused&&stream)return;paused=false;connect();}
    return {pause,resume,setSymbols,stop:pause,healthy:()=>state==='streaming',state:()=>state,quotes};
  }
  window.PANEL_LIVE_STORE=Object.freeze({createLiveStore});
})();
