(() => {
  const createNewsController = ({ network, client:PANEL, getWatchlist, getCards, now=Date.now }) => {
    const { esc, fmtTime8 } = window.PANEL_FORMAT;
    let inFlight=null, generation=0;
    const data={}, metadata={};
  function sentTag(tone) {
    if(tone?.scope!=='headline_only')return '';
    const sentiment = {positive:'利好',negative:'利空',neutral:'中性'}[tone.value] || '中性';
    const label={'利好':'积极','利空':'消极','中性':'中性'}[sentiment];
    return '<span class="stag s-' + sentiment + '" title="仅描述标题关键词语气，未判定对当前证券的利好或利空，也未核验新闻事实">标题·' + label + '</span>';
  }
  function sourceLabel(item){
    const classification=item.provenance?.publisher_classification;
    const label=classification?.status!=='registered_domain'?'来源域名未登记':({'newsroom':'媒体报道','official':'官方来源','press_release':'新闻稿'}[classification.category]||'已登记来源');
    return '<span class="nsrc" title="'+esc(label+'；仅核对来源域名，不代表内容已核实')+'">'+esc(item.src)+' · '+esc(label)+'</span>';
  }
  function renderNews(q, items, meta = {}) {
    if (!q.newslist) return;
    if (q.newshead) q.newshead.textContent = meta.pending ? '资讯 · 正在获取' : meta.stale || meta.error ? '资讯 · 缓存/刷新暂不可用' : '相关资讯 · 近7天';
    const clock=now();
    const list = (items || []).filter(n=>Number.isFinite(n.t)&&n.t>0&&n.t<=clock&&n.t>=clock-7*864e5&&n.title&&n.src&&/^https?:\/\//i.test(n.link||'')&&PANEL.safeURL(n.link)&&n.linkScope!=='feed'&&n.provenance?.link_scope!=='feed').slice().sort((a, b) => b.t - a.t).slice(0, 6);
    const sig = JSON.stringify([list.map(n => [n.id,n.title, n.t, n.link, n.src, n.headlineTone, n.provenance?.publisher_classification, !!n.general]),!!meta.pending,!!meta.stale,!!meta.error]);
    if (sig === q._newsSig) return;
    q._newsSig = sig;
    const box=q.newslist,doc=box.ownerDocument||document,rows=q._newsRows ||= new Map();
    const active=doc.activeElement,scroll=box.scrollTop,oldRows=[...box.children],activeIndex=oldRows.indexOf(active),used=new Set();
    for(const node of oldRows)if(node.classList.contains('newsempty'))node.remove();
    let index=0;
    for(const n of list){
      const link=PANEL.safeURL(n.link),tag=link?'a':'div',key=String(n.id||link||[n.src,n.t,n.title].join('|'));
      if(used.has(key))continue;used.add(key);
      let row=rows.get(key);
      if(row&&row.tag!==tag){row.el.remove();rows.delete(key);row=null;}
      if(!row){row={el:doc.createElement(tag),tag,sig:null};row.el.className='newsitem';rows.set(key,row);}
      const itemSig=JSON.stringify([n.title,n.t,n.src,n.headlineTone,n.provenance?.publisher_classification,!!n.general,link]);
      if(row.sig!==itemSig){
        if(link){row.el.href=link;row.el.target='_blank';row.el.rel='noopener noreferrer';}
        row.el.innerHTML=sentTag(n.headlineTone)+(n.general?'<span class="general-news">市场资讯</span>':'')+'<span class="ntime">'+fmtTime8(n.t)+'</span>'+sourceLabel(n)+'<span class="ntitle">'+esc(n.title)+'</span>';
        row.sig=itemSig;
      }
      if(box.children[index]!==row.el){if(box.insertBefore)box.insertBefore(row.el,box.children[index]||null);else box.appendChild(row.el);}index++;
    }
    for(const [key,row] of rows)if(!used.has(key)){row.el.remove();rows.delete(key);}
    if(!used.size){const empty=doc.createElement('div');empty.className='newsempty';empty.textContent=meta.pending?'正在获取资讯…':meta.stale||meta.error?'资讯暂不可用，将自动重试':'近7天暂无符合来源与时间条件的相关资讯';box.appendChild(empty);}
    if(activeIndex>=0){
      const kept=[...rows.values()].some(row=>row.el===active);
      const links=[...rows.values()].filter(row=>row.tag==='a').map(row=>row.el);
      const target=kept?active:links[Math.min(activeIndex,links.length-1)]||q.newshead;
      target?.focus?.({preventScroll:true});
    }
    box.scrollTop=scroll;
  }
    function distribute() {
      for(const [symbol,q] of getCards()) {
        if(!getWatchlist().includes(symbol))continue;
        renderNews(q,data[symbol] || [],metadata[symbol] || {pending:true});
      }
    }
    function prune(){const keep=new Set(getWatchlist());for(const key of Object.keys(data))if(!keep.has(key))delete data[key];for(const key of Object.keys(metadata))if(!keep.has(key))delete metadata[key];}
  function invalidate() {prune(); generation++;network.abort?.('news'); }
    async function refreshNews() {
      prune();const requested=[...getWatchlist()], key=requested.join(',');
      if(!key){invalidate();return true;}
      if(inFlight?.key===key && inFlight.generation===generation)return inFlight.promise;
      const current=++generation;
      for(const symbol of requested) if(!Object.hasOwn(data,symbol))metadata[symbol]={pending:true};
      distribute();
      const entry={key,generation:current,promise:null};
      entry.promise=(async()=>{
        try {
          for(let offset=0;offset<requested.length;offset+=12){
            if(current!==generation || key!==getWatchlist().join(','))return false;
            const batch=requested.slice(offset,offset+12);
            const r=await network.request('news','/api/news?symbols='+encodeURIComponent(batch.join(','))+'&t='+Date.now(),{replace:true});
            if(!r.ok)throw new Error('HTTP '+r.status);
            const payload=await r.json(), meta=PANEL.decodeNewsMetadata(r.headers);
            if(current!==generation || key!==getWatchlist().join(','))return false;
            for(const symbol of batch){
              const items=payload?.[symbol];
              metadata[symbol]=meta[symbol] || (Array.isArray(items)?{}:{error:'未返回此标的资讯',stale:true});
              if(Array.isArray(items))data[symbol]=items;
            }
            distribute();
          }
          distribute();return !requested.some(symbol=>metadata[symbol]?.error || metadata[symbol]?.stale);
        } catch(error) {
          if(current!==generation)return false;
          for(const symbol of requested)metadata[symbol]={stale:true,error:error.message};
          distribute();return false;
        } finally {if(inFlight===entry)inFlight=null;}
      })();
      inFlight=entry;return entry.promise;
    }
    return Object.freeze({renderNews,distribute,tick:distribute,refreshNews,invalidate,cacheSize:()=>Object.keys(data).length});
  };
  window.PANEL_NEWS_CONTROLLER=Object.freeze({createNewsController});
})();
