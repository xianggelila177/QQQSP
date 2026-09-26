(() => {
  const createHistoryStore = ({fetchImpl = window.fetch.bind(window), symbol, timeoutMs = 22000, network}) => {
    const transport = network || window.PANEL_NETWORK.createNetwork({fetchImpl, timeoutMs});
    const entries=Object.create(null), controllers=Object.create(null), generations=Object.create(null),prewarmBuffers=Object.create(null);
    const entry=tf=>entries[tf] ||= {bars:[],revision:0,status:'unknown',warnings:[],meta:null};
    const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
    const normalize=bar=>{
      if(!bar||!validDate(bar.periodStart)||!['t','o','h','l','c'].every(k=>typeof bar[k]==='number'&&Number.isFinite(bar[k])))return null;
      if(bar.t!==Date.parse(bar.periodStart+'T00:00:00Z')/1000||bar.h<Math.max(bar.o,bar.c)||bar.l>Math.min(bar.o,bar.c)||bar.l>bar.h)return null;
      if(bar.v!=null&&(typeof bar.v!=='number'||!Number.isFinite(bar.v)||bar.v<0))return null;
      return {...bar,v:bar.v??null};
    };
    function merge(tf,response,{before}={}){
      const e=entry(tf),same=e.meta?.seriesId===response.seriesId;
      if(same&&e.revision===String(response.revision)&&e.bars.length){e.meta=response;e.status=response.status||'ready';e.retryAt=response.retryAt||null;e.errorCode=response.errorCode||null;e.warnings=response.warnings||[];return e;}

      const map=same?new Map(e.bars.map(b=>[b.periodStart,b])):new Map();
      const first=response.bars[0]?.periodStart,last=response.bars.at(-1)?.periodStart;
      // A refreshed range replaces its old contents, including records removed
      // by a source correction. Other loaded pages keep their own dated rows.
      if(!response.bars.length){if(!before||!same)map.clear();}
      else for(const date of map.keys())if(date>=first&&date<=last)map.delete(date);
      for(const raw of response.bars)map.set(raw.periodStart,normalize(raw));
      e.bars=[...map.values()].sort((a,b)=>a.t-b.t);
      // Keep the client memory bounded while retaining the page just requested.
      if(e.bars.length>2000){const first=response.bars[0]?.t;if(first===e.bars[0]?.t)e.bars=e.bars.slice(0,2000);else e.bars=e.bars.slice(-2000);}
      e.revision=String(response.revision);e.meta=response;
      e.status=response.status==='empty'&&e.bars.length?'ready':response.status||(e.bars.length?'ready':'empty');
      e.warnings=response.warnings||[];e.retryAt=response.retryAt||null;e.errorCode=response.errorCode||null;
      return e;
    }
    function hydrate(tf,response){
      const spec=window.PANEL_TIMEFRAMES.get(tf);
      const unchanged=response?.bars==='same';
      if(unchanged){
        const saved=prewarmBuffers[tf];
        if(!saved||saved.seriesId!==response.seriesId||(saved.barsRevision||saved.revision)!==(response.barsRevision||response.revision))return false;
        response={...response,bars:saved.bars};
      }
      if(!response||response.schemaVersion!==1||response.symbol!==symbol||response.period!==spec.apiPeriod||typeof response.seriesId!=='string'||typeof response.revision!=='string'||!Array.isArray(response.bars)||!unchanged&&(response.bars.some(b=>!normalize(b))||response.bars.some((b,i,a)=>i&&b.t<=a[i-1].t)))return false;
      const old=entry(tf).meta;
      if(old?.sourceCheckedAt>response.sourceCheckedAt)return false;
      prewarmBuffers[tf]=response;
      // Near daily aggregates cannot replace a complete requested month/year.
      if(response.prewarmScope==='near'&&spec.apiPeriod!=='daily'&&(entry(tf).loadedDirect||controllers[tf]))return true;
      // A prewarm arriving during a first load supersedes it, but never abort an older-page request.
      if(controllers[tf]&&!entry(tf).loadingBefore){generations[tf]=(generations[tf]||0)+1;controllers[tf].abort();delete controllers[tf];}
      merge(tf,response);return true;
    }
    async function load(tf,{before,limit}={}){
      const spec=window.PANEL_TIMEFRAMES.get(tf),e=entry(tf);if(!spec||spec.kind!=='history'||e.retryAt>Date.now())return e;
      controllers[tf]?.abort();const ac=new AbortController();controllers[tf]=ac;
      const gen=(generations[tf]||0)+1;generations[tf]=gen;e.loadingBefore=before||null;e.status='loading';
      const current=()=>generations[tf]===gen&&!ac.signal.aborted;
      const deadlineAt=Date.now()+timeoutMs;
      try{
        let identity=e.meta?.seriesId;
        for(let attempt=0;attempt<2;attempt++){
          const qs=new URLSearchParams({symbol,period:spec.apiPeriod,limit:String(limit||spec.visible+spec.prewarm)});
          if(before)qs.set('before',before);if(identity)qs.set('seriesId',identity);
          const r=await transport.request('history:'+symbol+':'+tf, '/api/history?'+qs, {replace:true, signal:ac.signal, timeoutMs:Math.max(1,deadlineAt-Date.now()), readErrorJson:true}),j=(await r.json())||{};
          if(!current())return e;
          if(r.status===409&&identity&&attempt===0){identity=null;e.status=e.bars.length?'stale':'loading';continue;}
          if(!r.ok)throw Object.assign(new Error(j.error||'历史来源暂不可用'),{code:j.code||'HISTORY_SOURCE_UNAVAILABLE',retryAt:j.retryAt||r.retryAt||null});
          if(j.schemaVersion!==1||j.symbol!==symbol||j.period!==spec.apiPeriod||typeof j.seriesId!=='string'||!j.seriesId||typeof j.revision!=='string'||!Array.isArray(j.bars))throw new Error(j.error||'invalid history response');
          if(j.bars.some(b=>!normalize(b))||j.bars.some((b,i,a)=>i&&b.t<=a[i-1].t))throw new Error('invalid history bars');
          const value=merge(tf,j,{before});value.loadedDirect=true;return value;
        }
      }catch(err){if(current()){e.status=e.bars.length?'stale':'error';e.warnings=[String(err.message||err)];e.errorCode=err.code||'HISTORY_BAD_RESPONSE';e.retryAt=Number(err.retryAt)||null;}}
      finally{if(controllers[tf]===ac)delete controllers[tf];}
      return e;
    }
    function abort(){for(const tf of Object.keys(controllers)){generations[tf]=(generations[tf]||0)+1;controllers[tf].abort();delete controllers[tf];const e=entry(tf);e.status=e.bars.length?'stale':'unknown';e.loadingBefore=null;}}
    const needsLoad=tf=>{const spec=window.PANEL_TIMEFRAMES.get(tf),e=entry(tf);return spec.kind==='history'&&(!e.bars.length||!e.loadedDirect&&e.meta?.prewarmScope==='near'&&spec.apiPeriod!=='daily');};
    return Object.freeze({getSeries:tf=>entry(tf).bars,getRevision:tf=>entry(tf).revision,getMeta:entry,needsLoad,load,hydrate,abort});
  };
  window.PANEL_HISTORY_STORE=Object.freeze({createHistoryStore});
})();
