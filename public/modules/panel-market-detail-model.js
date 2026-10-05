(() => {
  // Owns the market request only. No DOM, card state, canvas or history store.
  function createMarketDetailModel({network,onChange=()=>{},canRead=()=>true,now=Date.now}){
    let epoch=0,job=null;
    function cancel(){epoch++;job?.controller.abort();job=null;}
    function reset({session='auto',bookReason='DETAIL_LOADING',tapeReason='TAPE_LOADING',error=null}={}){
      onChange({book:{status:'unavailable',reason:bookReason},tape:{status:'unavailable',session,reason:tapeReason,events:[]}},error);
    }
    function read({symbol,range='1d',session='auto'}){
      if(!canRead())return Promise.resolve();
      const key=JSON.stringify([symbol,range,session]);
      if(job?.key===key)return job.promise;
      cancel();const controller=new AbortController(),id=epoch,current={key,controller,promise:null};job=current;
      current.promise=(async()=>{
        try{
          const response=await network.request('chart-detail:'+symbol,'/api/chart/detail?symbol='+encodeURIComponent(symbol)+'&range='+range+'&tapeSession='+session+'&sections=market',
            {signal:controller.signal,cache:'no-store',replace:true});
          if(!response.ok)throw new Error(response.retryAt>now()?'来源限流，'+Math.ceil((response.retryAt-now())/1000)+' 秒后可重试':'HTTP '+response.status);
          const value=await response.json();if(id!==epoch||controller.signal.aborted)return;
          if(value?.symbol!==symbol||value.range!==range)throw new Error('证券身份或请求范围不符');
          onChange(value);
        }catch(error){
          if(id!==epoch||controller.signal.aborted&&error.code!=='REQUEST_TIMEOUT')return;
          reset({session,bookReason:'DETAIL_REQUEST_FAILED',tapeReason:'PUBLIC_TRADES_UNAVAILABLE',error:String(error.message||'请求失败')});
        }finally{if(job===current)job=null;}
      })();return current.promise;
    }
    return Object.freeze({read,reset,cancel});
  }
  window.PANEL_MARKET_DETAIL_MODEL=Object.freeze({createMarketDetailModel});
})();
