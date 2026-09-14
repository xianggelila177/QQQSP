(() => {
  function createSampleStore({symbol,fetchImpl=window.fetch.bind(window),onChange=()=>{},timeoutMs=10000}={}) {
    let state={symbol,points:[],tradingDays:[],revision:0,status:'unknown'},loaded=false,job=null,controller=null,generation=0;
    let pending=[];
    const valid=value=>value?.symbol===symbol&&Number.isFinite(value.revision)&&Array.isArray(value.tradingDays)&&value.tradingDays.length<=3&&
      value.tradingDays.every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d))&&Array.isArray(value.points)&&value.points.length<=4500&&
      value.points.every(p=>p&&Number.isFinite(p.t)&&p.t>0&&Number.isFinite(p.c)&&p.c>0&&value.tradingDays.includes(p.tradingDate)&&
        typeof p.source==='string'&&p.source.length<=80&&/^(?:[A-Z]{3}|GBp|ZAc)$/.test(p.currency));
    function merge(value,replace=false) {
      if(!valid(value)||!replace&&value.revision<=state.revision)return false;
      const map=new Map((replace?[]:state.points).filter(p=>value.tradingDays.includes(p.tradingDate)).map(p=>[Math.floor(p.t/60),p]));
      for(const p of value.points)map.set(Math.floor(p.t/60),Object.freeze({...p,v:null,_sample:true}));
      state={...state,...value,points:Object.freeze([...map.values()].sort((a,b)=>a.t-b.t))};onChange();return true;
    }
    function apply(value) {
      if(!valid(value))return false;
      if(job){pending.push(value);if(pending.length>8)pending.shift();return true;}
      if(!loaded)return false;
      return merge(value);
    }
    function load(force=false) {
      if(job)return job;if(loaded&&!force)return Promise.resolve(state);
      controller=new AbortController();const ac=controller,owner=++generation;pending=[];
      state={...state,status:'loading',error:null};onChange();
      const timeout=setTimeout(()=>ac.abort(),timeoutMs);
      job=(async()=>{
        try{
          const response=await fetchImpl('/api/samples?symbol='+encodeURIComponent(symbol),{signal:ac.signal,cache:'no-store'});
          if(!response.ok)throw Error('服务器采样暂不可用');
          const value=await response.json();if(owner!==generation)return state;
          if(!valid(value))throw Error('采样数据格式无效');
          merge(value,true);loaded=true;
          for(const update of pending)merge(update);pending=[];
        }catch(error){if(owner===generation){state={...state,status:'error',error:'采样读取失败，保留已有记录'};onChange();}}
        finally{clearTimeout(timeout);if(owner===generation){job=null;controller=null;}}
        return state;
      })();return job;
    }
    function abort(){generation++;controller?.abort();controller=null;job=null;pending=[];}
    return {load,apply,snapshot:()=>state,abort};
  }
  window.PANEL_SAMPLE_STORE=Object.freeze({createSampleStore});
})();
