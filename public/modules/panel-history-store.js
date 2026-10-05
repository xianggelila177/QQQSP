(() => {
  const createHistoryStore = ({fetchImpl = window.fetch.bind(window), symbol, timeoutMs = 22000, network}) => {
    const transport = network || window.PANEL_NETWORK.createNetwork({fetchImpl, timeoutMs});
    const entries=Object.create(null), controllers=Object.create(null), generations=Object.create(null),prewarmBuffers=Object.create(null),pending=Object.create(null),listeners=new Set();
    const entry=tf=>entries[tf] ||= {bars:[],revision:0,status:'unknown',warnings:[],meta:null,pagination:null,requestedExtent:null,loadingExtent:null,availableExtent:{first:null,last:null,count:0}};
    const notify=change=>{for(const listener of listeners)listener(change);};
    const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
    const normalize=bar=>{
      if(!bar||!validDate(bar.periodStart)||!['t','o','h','l','c'].every(k=>typeof bar[k]==='number'&&Number.isFinite(bar[k])))return null;
      if(bar.t!==Date.parse(bar.periodStart+'T00:00:00Z')/1000||bar.h<Math.max(bar.o,bar.c)||bar.l>Math.min(bar.o,bar.c)||bar.l>bar.h)return null;
      if(bar.v!=null&&(typeof bar.v!=='number'||!Number.isFinite(bar.v)||bar.v<0))return null;
      return {...bar,v:bar.v??null};
    };
    const validOverlap=(response,before)=>response.overlapBars===undefined||Array.isArray(response.overlapBars)&&response.overlapBars.length<=1&&
      response.overlapBars.every(bar=>before&&bar.periodStart===before&&normalize(bar));
    function updatePagination(e,response,previous,bars,{before,same}){
      const edge=same?(e.pagination?.before||previous[0]?.periodStart):null,first=response.bars[0]?.periodStart;
      // A tail refresh describes that tail's coverage, not the oldest loaded
      // page. Keep the independently established cursor/end at the left edge.
      if(edge&&(before?before>edge:!first||first>edge))return;
      const candidate=validDate(response.nextBefore)&&(!before||response.nextBefore<before)&&(!first||response.nextBefore<=first)?response.nextBefore:null;
      const cursor=candidate||(first&&(!before||first<before)?first:edge||bars[0]?.periodStart)||null;
      e.pagination={before:cursor,hasMore:response.hasMore===true?true:response.hasMore===false?false:null};
    }
    function merge(tf,response,{before}={}){
      const e=entry(tf),same=e.meta?.seriesId===response.seriesId;
      if(same&&e.revision===String(response.revision)&&e.bars.length&&!response.overlapBars?.length){updatePagination(e,response,e.bars,e.bars,{before,same});e.meta=response;e.status=response.status||'ready';e.retryAt=response.retryAt||null;e.errorCode=response.errorCode||null;e.warnings=response.warnings||[];return e;}

      const map=same?new Map(e.bars.map(b=>[b.periodStart,b])):new Map();
      const first=response.bars[0]?.periodStart,last=response.bars.at(-1)?.periodStart;
      // A refreshed range replaces its old contents, including records removed
      // by a source correction. Other loaded pages keep their own dated rows.
      if(!response.bars.length){if(!before||!same)map.clear();}
      else for(const date of map.keys())if(date>=first&&date<=last)map.delete(date);
      for(const raw of response.bars)map.set(raw.periodStart,normalize(raw));
      // Older raw data can complete the first already visible month/year. It
      // corrects only the requested boundary bucket, not the intervening range.
      for(const raw of response.overlapBars||[])map.set(raw.periodStart,normalize(raw));
      let bars=[...map.values()].sort((a,b)=>a.t-b.t);
      // Keep the client memory bounded while retaining the page just requested.
      if(bars.length>2000){const first=response.bars[0]?.t;if(first===bars[0]?.t)bars=bars.slice(0,2000);else bars=bars.slice(-2000);}
      const previous=e.bars;
      notify({phase:'before',tf,previous,bars,entry:e});
      updatePagination(e,response,previous,bars,{before,same});
      e.bars=bars;
      e.availableExtent={first:bars[0]?.periodStart||null,last:bars.at(-1)?.periodStart||null,count:bars.length};
      e.revision=String(response.revision);e.meta=response;
      e.status=response.status==='empty'&&e.bars.length?'ready':response.status||(e.bars.length?'ready':'empty');
      e.warnings=response.warnings||[];e.retryAt=response.retryAt||null;e.errorCode=response.errorCode||null;
      notify({phase:'after',tf,previous,bars,entry:e});
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
      if(!response||response.schemaVersion!==1||response.symbol!==symbol||response.period!==spec.apiPeriod||typeof response.seriesId!=='string'||typeof response.revision!=='string'||!Array.isArray(response.bars)||!validOverlap(response)||!unchanged&&(response.bars.some(b=>!normalize(b))||response.bars.some((b,i,a)=>i&&b.t<=a[i-1].t)))return false;
      const old=entry(tf).meta;
      if(old?.sourceCheckedAt>response.sourceCheckedAt)return false;
      prewarmBuffers[tf]=response;
      // Near daily aggregates cannot replace a complete requested month/year.
      if(response.prewarmScope==='near'&&spec.apiPeriod!=='daily'&&(entry(tf).loadedDirect||controllers[tf]))return true;
      // A prewarm arriving during a first load supersedes it, but never abort an older-page request.
      if(controllers[tf]&&!entry(tf).loadingBefore){generations[tf]=(generations[tf]||0)+1;controllers[tf].abort();delete controllers[tf];delete pending[tf];entry(tf).loadingExtent=null;}
      merge(tf,response);return true;
    }
    async function performLoad(tf,{before,limit}={}){
      const spec=window.PANEL_TIMEFRAMES.get(tf),e=entry(tf);if(!spec||spec.kind!=='history'||e.retryAt>Date.now())return e;
      controllers[tf]?.abort();const ac=new AbortController();controllers[tf]=ac;
      const gen=(generations[tf]||0)+1;generations[tf]=gen;e.loadingBefore=before||null;e.status='loading';
      e.requestedExtent={period:spec.apiPeriod,count:limit||spec.visible+spec.prewarm,before:before||null};e.loadingExtent=e.requestedExtent;
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
          if(j.bars.some(b=>!normalize(b)||before&&b.periodStart>=before)||j.bars.some((b,i,a)=>i&&b.t<=a[i-1].t)||!validOverlap(j,before))throw new Error('invalid history bars');
          const value=merge(tf,j,{before});value.loadedDirect=true;return value;
        }
      }catch(err){if(current()){e.status=e.bars.length?'stale':'error';e.warnings=[String(err.message||err)];e.errorCode=err.code||'HISTORY_BAD_RESPONSE';e.retryAt=Number(err.retryAt)||null;}}
      finally{if(controllers[tf]===ac){delete controllers[tf];e.loadingBefore=null;e.loadingExtent=null;}}
      return e;
    }
    function load(tf,options={}){
      const key=JSON.stringify([options.before||null,options.limit||null]);
      if(pending[tf]?.key===key)return pending[tf].promise;
      const job={key,promise:null};pending[tf]=job;
      job.promise=performLoad(tf,options).finally(()=>{if(pending[tf]===job)delete pending[tf];});return job.promise;
    }
    function abort(){for(const tf of Object.keys(controllers)){generations[tf]=(generations[tf]||0)+1;controllers[tf].abort();delete controllers[tf];delete pending[tf];const e=entry(tf);e.status=e.bars.length?'stale':'unknown';e.loadingBefore=null;e.loadingExtent=null;}}
    const needsLoad=tf=>{const spec=window.PANEL_TIMEFRAMES.get(tf),e=entry(tf);return spec.kind==='history'&&(!e.bars.length||!e.loadedDirect&&(e.meta?.extent?.satisfied===false||e.meta?.prewarmScope==='near'&&spec.apiPeriod!=='daily'));};
    return Object.freeze({getSeries:tf=>entry(tf).bars,getRevision:tf=>entry(tf).revision,getMeta:entry,needsLoad,load,hydrate,abort,
      subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}});
  };
  window.PANEL_HISTORY_STORE=Object.freeze({createHistoryStore});
})();
