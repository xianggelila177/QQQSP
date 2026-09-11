(() => {
  const createMacroController = ({ document, network, client, box, filters, status, retry, isOpen=()=>true, onChange = () => {} }) => {
    const { esc, fmtTime8 } = window.PANEL_FORMAT;
    let all=[], filter='全部', inFlight=null, updatedAt=0, stale=false, error=null, sources={}, refreshing=false;
    let followupTimer=null, followups=0;
    const filterNodes=new Map(), rows=new Map();
    function renderStatus(loading=false) {
      status.dataset.state=loading?'loading':error||stale?(all.length?'stale':'error'):refreshing?'refreshing':all.length?'ready':'empty';
      status.textContent = loading ? (all.length ? '正在更新宏观资讯，保留缓存' : '正在获取宏观资讯…')
        : error || stale ? (all.length ? '宏观资讯缓存 · 刷新暂不可用' : '宏观资讯获取失败，暂不可用')
        : refreshing ? '宏观资讯后台更新中，保留最近内容' : all.length ? '宏观资讯已更新' : '暂无宏观资讯';
      if(updatedAt)status.textContent+=' · 上次成功 '+fmtTime8(updatedAt);
      status.title=Object.entries(sources).map(([name,info])=>name+'：'+(info.error||info.stale?'缓存/暂不可用':'正常')+(info.updatedAt?'，'+fmtTime8(info.updatedAt):'，尚无成功更新')).join('；');
      retry.hidden=!(error || stale);retry.disabled=loading;
    }
    function renderFilters() {
      const topics=['全部',...new Set(all.map(item=>item.topic).filter(Boolean))];
      if(!topics.includes(filter))filter='全部';
      for(const [topic,button] of filterNodes) if(!topics.includes(topic)){
        if(document.activeElement===button)filterNodes.get('全部')?.focus();
        button.remove();filterNodes.delete(topic);
      }
      for(const topic of topics){
        let button=filterNodes.get(topic);
        if(!button){button=document.createElement('button');button.className='mfbtn';button.type='button';button.dataset.f=topic;button.textContent=topic;button.addEventListener('click',()=>{filter=topic;renderFilters();renderList();});filters.appendChild(button);filterNodes.set(topic,button);}
        button.classList.toggle('on',topic===filter);button.setAttribute('aria-pressed',String(topic===filter));
      }
    }
    function renderList() {
      const list=all.filter(item=>filter==='全部'||item.topic===filter), used=new Set();
      const active=document.activeElement, keepScroll=box.scrollTop;
      for(const [i,item] of list.entries()){
        const url=client.safeURL(item.link), key=String(item.id || item.link || [item.title,item.src,item.t].join('|'));
        used.add(key);let row=rows.get(key);
        if(row && row.tag!== (url?'a':'div')){row.el.remove();rows.delete(key);row=null;}
        if(!row){const el=document.createElement(url?'a':'div');el.className=url?'mlink':'macro-text';row={el,tag:url?'a':'div',sig:null};rows.set(key,row);}
        const sig=JSON.stringify([item.title,item.t,item.src,item.topic,item.sent,url]);
        if(sig!==row.sig){
          if(url){row.el.href=url;row.el.target='_blank';row.el.rel='noopener noreferrer';}
          const sent=['利好','利空','中性'].includes(item.sent)?item.sent:'中性';
          row.el.innerHTML='<div class="mitem"><span class="ntime">'+fmtTime8(item.t)+'</span><span class="stag s-'+sent+'" title="标题关键词规则判断，存在误判可能">规则·'+sent+'</span><span class="mtopic">'+esc(item.topic)+'</span><span class="nsrc">'+esc(item.src)+'</span><span class="ntitle">'+esc(item.title)+'</span></div>';row.sig=sig;
        }
        if(box.children[i]!==row.el){if(box.insertBefore)box.insertBefore(row.el,box.children[i]||null);else box.appendChild(row.el);}
      }
      for(const [key,row] of rows)if(!used.has(key)){row.el.remove();rows.delete(key);}
      for(const node of [...box.children]) if(node.classList.contains('newsempty'))node.remove();
      if(!list.length){const empty=document.createElement('div');empty.className='newsempty';empty.textContent=error||stale?'宏观资讯暂不可用，可点击重试':'暂无宏观资讯';box.appendChild(empty);}
      if(active && [...rows.values()].some(row=>row.el===active))active.focus({preventScroll:true});
      box.scrollTop=keepScroll;
    }
    async function refreshMacro({followup=false}={}) {
      if(!isOpen())return true;
      if(inFlight)return inFlight;
      if(!followup){followups=0;clearTimeout(followupTimer);followupTimer=null;}
      renderStatus(true);
      inFlight=(async()=>{
        try{
          const response=await network.request('macro','/api/macro?t='+Date.now());
          if(!response.ok)throw new Error('HTTP '+response.status);
          const payload=await response.json();
          if(!Array.isArray(payload?.items))throw new Error('宏观数据格式错误');
          sources=payload.sources || {};
          stale=payload.stale===true;error=payload.error || null;
          refreshing=payload.refreshing===true;
          if(payload.items.length || !(stale || error))all=payload.items;
          if(Number(payload.updatedAt)>0)updatedAt=Number(payload.updatedAt);
          renderFilters();renderList();renderStatus();onChange();
          if(isOpen() && refreshing && followups<6){followups++;followupTimer=setTimeout(()=>{followupTimer=null;void refreshMacro({followup:true});},2000);}
          return !(stale || error);
        }catch(cause){refreshing=false;stale=all.length>0;error=cause.message;renderFilters();renderList();renderStatus();return false;}
        finally{inFlight=null;}
      })();return inFlight;
    }
    retry.addEventListener('click',()=>refreshMacro());
    return Object.freeze({refreshMacro,cancel(){clearTimeout(followupTimer);followupTimer=null;network.abort?.('macro');},items:()=>all,filterNodes});
  };
  window.PANEL_MACRO_CONTROLLER=Object.freeze({createMacroController});
})();
