(() => {
 const createMacroController=({document,network,client,box,filters,status,retry,isOpen=()=>true,onChange=()=>{}})=>{
  const {esc,fmtTime8}=window.PANEL_FORMAT;
  let all=[],filter='重点',inFlight=null,updatedAt=0,stale=false,error=null,sources={},refreshing=false,generation=0;
  let stream=null,streamState='connecting',lastPayload=null,lastEventAt=0,nextFallback=0,suspended=false;
  const monitorStatus=document.getElementById('macroMonitorStatus');
  let followupTimer=null,followups=0;const filterNodes=new Map(),rows=new Map();let renderedNews='';
  const contextRoot=document.getElementById('macroFactors'),contextStatus=document.getElementById('macroContextStatus');
  const context=contextRoot&&contextStatus&&window.PANEL_MACRO_CONTEXT?window.PANEL_MACRO_CONTEXT.createMacroContext({document,network,root:contextRoot,status:contextStatus,isOpen}):null;
  function renderStatus(loading=false){
   status.dataset.state=loading?'loading':error||stale?(all.length?'stale':'error'):refreshing?'refreshing':all.length?'ready':'empty';
   status.textContent=loading?(all.length?'正在更新，保留已有证据':'正在获取宏观资讯…'):error||stale?(all.length?'部分来源不可用 · 请核对每条发布时间':'宏观资讯暂不可用'):refreshing?'后台更新中 · 保留最近内容':all.length?'宏观证据已更新':'暂无宏观资讯';
   if(updatedAt)status.textContent+=' · 最近成功 '+fmtTime8(updatedAt);
   status.title=Object.entries(sources).map(([name,info])=>name+'：'+(info.error||info.stale?'缓存/不可用':'正常')).join('；');retry.hidden=!(error||stale);retry.disabled=loading;
  }
  const chosen=item=>filter==='全部'||filter==='观察'&&item.assessment?.importance==='watch'||filter==='重点'&&item.assessment?.importance==='focus'&&item.assessment?.status!=='background'||filter===item.topic;
  function renderFilters(){
   const topics=['重点','观察','全部',...new Set(all.map(x=>x.topic).filter(Boolean))];if(!topics.includes(filter))filter='重点';
   for(const [topic,b]of filterNodes)if(!topics.includes(topic)){b.remove();filterNodes.delete(topic);}
   for(const topic of topics){let b=filterNodes.get(topic);if(!b){b=document.createElement('button');b.type='button';b.className='mfbtn';b.dataset.f=topic;b.addEventListener('click',()=>{filter=topic;box.scrollTop=0;renderFilters();renderList();});filters.appendChild(b);filterNodes.set(topic,b);}b.textContent=topic;b.classList.toggle('on',topic===filter);b.setAttribute('aria-pressed',String(topic===filter));}
  }
  const section=(label,values)=>values?.length?`<div class="evidence-section"><strong>${esc(label)}</strong><p>${values.map(v=>esc(v)).join('<br>')}</p></div>`:'';
  function markup(item){
   const a=item.assessment||{},url=client.safeURL(item.link),impacts=a.impacts||[{target:'纳指100',direction:'unknown',label:'待验证',rationale:'尚未分析'}];
   const scope=a.scope==='feed-excerpt'?'标题＋订阅摘要':'仅标题';const tier=a.evidenceTier==='official'?'官方原始源':'媒体报道';
   const facts=(a.facts||[]).map(f=>`${f.label}：${f.value}`);
   const additional=(item.reports||[]).filter(r=>r.link&&r.link!==item.link).slice(0,4).map(r=>{const u=client.safeURL(r.link);return u?`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(r.src||'转载来源')}</a>`:'';}).join(' · ');
   return `<div class="event-head"><span class="ntime">${fmtTime8(item.t)}</span><span class="mtopic">${esc(item.topic||a.topic||'宏观')}</span><span class="evidence-tier">${esc(tier)} · ${scope}</span><span class="nsrc">${esc(item.src||'未知来源')}</span>${item.groupedCount>1?`<span class="evidence-tier">同一调查 · ${item.groupedCount}条期限信息已归组</span>`:''}</div>
    ${url?`<a class="event-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`:`<div class="event-link">${esc(item.title)}</div>`}
    <div class="impact-row">${impacts.map(x=>`<span class="impact-chip ${['positive','negative','mixed','unknown'].includes(x.direction)?x.direction:'unknown'}">${esc(x.target)} · ${esc(x.label||'待验证')}</span>`).join('')}<span class="impact-origin">事件条件分析${a.region&&a.region!=='UNKNOWN'?' · '+esc(({UK:'英国',US:'美国',EU:'欧元区',CN:'中国',JP:'日本',KR:'韩国',MULTI:'多地区'})[a.region]||a.region):''}${a.status==='background'?' · 历史背景':''}</span></div>
    <p class="event-summary">${esc(a.summary||'缺少事件证据，不沿用旧版情绪标签。')}</p>
    <details class="macro-evidence"><summary>查看依据、传导条件与反证</summary>
    ${section('已取得的来源信息',facts)}${section('识别的传导证据',(a.signals||[]).map(s=>(({reported:'报道描述','reported-expectations':'报道中的预期',scenario:'未落地情景',opinion:'作者观点'})[s.basis]||'条件')+'：'+s.evidence))}${section('为什么可能产生影响',impacts.map(x=>x.target+'：'+x.rationale))}${section('成立条件',a.conditions)}${section('反证与其他解释',a.counterEvidence)}${section('仍需核验',a.missing)}
    <p class="evidence-note">${esc(a.horizon||'不作为交易指令')}。这里只读取标题或订阅摘要，并未阅读全文；报道中的“预期”未核验是否为发布前冻结共识。转载数量不等于独立确认。</p>${additional?'<p class="related-reports">相同报道入口：'+additional+'</p>':''}</details>`;
  }
  function renderList(){
   const list=all.filter(chosen).sort((a,b)=>({focus:2,watch:1,background:0}[b.assessment?.importance]||0)-({focus:2,watch:1,background:0}[a.assessment?.importance]||0)||b.t-a.t),used=new Set(),scroll=box.scrollTop;
   for(const [i,item]of list.entries()){
    const key=String(item.id||[item.link,item.title,item.t].join('|'));used.add(key);let row=rows.get(key);
    if(!row){const el=document.createElement('article');el.className='macro-event';row={el,sig:null};rows.set(key,row);}
    const sig=JSON.stringify([item.title,item.t,item.link,item.src,item.topic,{...item.assessment,assessedAt:0},item.reports]);
    if(row.sig!==sig){const open=row.el.querySelector('details')?.open;row.el.innerHTML=markup(item);if(open)row.el.querySelector('details').open=true;row.sig=sig;}
    if(box.children[i]!==row.el)box.insertBefore(row.el,box.children[i]||null);
   }
   for(const [key,row]of rows)if(!used.has(key)){row.el.remove();rows.delete(key);}
   for(const n of [...box.children])if(n.classList.contains('newsempty'))n.remove();
   if(!list.length){const el=document.createElement('p');el.className='newsempty';el.textContent=error||stale?'资讯来源暂不可用，已有内容可在“全部”查看':filter==='重点'?'暂无满足宏观证据筛选的内容，可切换“全部”查看背景资讯':'该分类暂无资讯';box.appendChild(el);}box.scrollTop=scroll;
  }
  async function refreshLegacy({followup=false}={}){
   if(!isOpen()||document.hidden)return true;void context?.refresh();if(inFlight)return inFlight;
   if(!followup){followups=0;clearTimeout(followupTimer);followupTimer=null;}
   const epoch=generation;renderStatus(true);
   inFlight=(async()=>{try{
    const response=await network.request('macro','/api/macro');if(!response.ok)throw new Error('HTTP '+response.status);
    const payload=await response.json();if(!Array.isArray(payload?.items))throw new Error('宏观数据格式错误');if(epoch!==generation)return false;
    sources=payload.sources||{};stale=payload.stale===true;error=payload.error||null;refreshing=payload.refreshing===true;
    if(payload.items.length||!(stale||error))all=payload.items;if(Number(payload.updatedAt)>0)updatedAt=Number(payload.updatedAt);
    renderFilters();renderList();renderStatus();onChange();
    if(isOpen()&&refreshing&&followups<6){followups++;followupTimer=setTimeout(()=>{followupTimer=null;void refreshLegacy({followup:true});},2000);}return !(stale||error);
   }catch(e){if(epoch!==generation)return false;refreshing=false;stale=all.length>0;error=e.message;renderFilters();renderList();renderStatus();return false;}finally{inFlight=null;}})();return inFlight;
  }
  function renderMonitor(){
   if(!monitorStatus)return;const m=lastPayload?.monitor;
   monitorStatus.textContent=!m?'后台监控连接中':!m.enabled?'后台监控已关闭':(m.running?'后台持续监控':'后台未运行')+' · '+({live:'推送已连接',connecting:'连接中',retry:'推送重连中，缓存读取兜底',paused:'页面已离开'}[streamState]||'缓存读取')+' · '+all.length+'条资讯';
   monitorStatus.title=m?[(m.lanes.news?.error?'资讯：'+m.lanes.news.error:''),(m.lanes.context?.error?'因子：'+m.lanes.context.error:''),m.persistence?.loadError,m.persistence?.saveError,m.delivery?.note].filter(Boolean).join('；'):'';
  }
  function applySnapshot(payload){
   if(!payload?.news||!Array.isArray(payload.news.items)||!Array.isArray(payload.context?.factors))throw new Error('宏观快照格式错误');
   lastPayload=payload;const n=payload.news;all=n.items;sources=n.sources||{};stale=!!n.stale;error=n.error||null;refreshing=!!n.refreshing;updatedAt=Number(n.updatedAt)||0;
   context?.apply(payload.context);renderMonitor();
   if(isOpen()&&!document.hidden){const signature=JSON.stringify(all.map(x=>[x.title,x.t,x.src,x.topic,{...x.assessment,assessedAt:0},x.reports]));if(signature!==renderedNews){renderedNews=signature;renderFilters();renderList();}renderStatus();}onChange();
  }
  function connect(){
   if(stream||suspended)return;streamState='connecting';renderMonitor();
   if(typeof window.EventSource!=='function'){streamState='retry';return;}
   try{
    const own=stream=new window.EventSource('/api/macro/stream');
    own.addEventListener('macro',event=>{if(stream!==own)return;try{streamState='live';lastEventAt=Date.now();applySnapshot(JSON.parse(event.data));}catch{streamState='retry';nextFallback=0;renderMonitor();}});
    own.onerror=()=>{if(stream!==own)return;streamState='retry';nextFallback=0;renderMonitor();};
   }catch{stream=null;streamState='retry';}
  }
  async function readSnapshot(){
   if(inFlight)return inFlight;nextFallback=Date.now()+60000;
   inFlight=(async()=>{try{const response=await network.request('macro-snapshot','/api/macro/snapshot');if(!response.ok)throw new Error('HTTP '+response.status);applySnapshot(await response.json());return true;}catch(e){error=e.message;renderMonitor();if(isOpen())renderStatus();return false;}finally{inFlight=null;}})();return inFlight;
  }
  async function refreshMacro({force=false}={}){
   if(lastPayload?.monitor?.enabled===false)return refreshLegacy();
   if(lastPayload){context?.redraw();if(isOpen()&&!document.hidden){renderFilters();renderList();renderStatus();}if(!force&&streamState==='live')return true;}
   return readSnapshot();
  }
  retry.addEventListener('click',()=>refreshMacro({force:true}));
  window.addEventListener?.('pagehide',()=>{suspended=true;stream?.close();stream=null;streamState='paused';});
  window.addEventListener?.('pageshow',()=>{suspended=false;connect();nextFallback=0;});
  connect();
  return Object.freeze({refreshMacro,tick(){
   if(suspended)return;
   if(lastPayload?.monitor?.enabled===false){context?.tick();return;}
   if(streamState==='live'&&Date.now()-lastEventAt>95000){streamState='retry';renderMonitor();}
   if(streamState!=='live'&&Date.now()>=nextFallback)void readSnapshot();
  },cancel(){generation++;clearTimeout(followupTimer);followupTimer=null;network.abort?.('macro');context?.cancel();},items:()=>all,filterNodes});
 };
 window.PANEL_MACRO_CONTROLLER=Object.freeze({createMacroController});
})();
