(() => {
 const createMacroController=({document,network,client,box,filters,status,retry,isOpen=()=>true,onChange=()=>{}})=>{
  const {esc,fmtTime8}=window.PANEL_FORMAT;
  let all=[],filter='重点',inFlight=null,updatedAt=0,stale=false,error=null,sources={},refreshing=false,generation=0;
  let followupTimer=null,followups=0;const filterNodes=new Map(),rows=new Map();
  const contextRoot=document.getElementById('macroFactors'),contextStatus=document.getElementById('macroContextStatus');
  const context=contextRoot&&contextStatus&&window.PANEL_MACRO_CONTEXT?window.PANEL_MACRO_CONTEXT.createMacroContext({document,network,root:contextRoot,status:contextStatus,isOpen}):null;
  function renderStatus(loading=false){
   status.dataset.state=loading?'loading':error||stale?(all.length?'stale':'error'):refreshing?'refreshing':all.length?'ready':'empty';
   status.textContent=loading?(all.length?'正在更新，保留已有证据':'正在获取宏观资讯…'):error||stale?(all.length?'部分来源不可用 · 请核对每条发布时间':'宏观资讯暂不可用'):refreshing?'后台更新中 · 保留最近内容':all.length?'宏观证据已更新':'暂无宏观资讯';
   if(updatedAt)status.textContent+=' · 最近成功 '+fmtTime8(updatedAt);
   status.title=Object.entries(sources).map(([name,info])=>name+'：'+(info.error||info.stale?'缓存/不可用':'正常')).join('；');retry.hidden=!(error||stale);retry.disabled=loading;
  }
  const chosen=item=>filter==='全部'||filter==='重点'&&['focus','watch'].includes(item.assessment?.importance)&&item.assessment?.status!=='background'||filter===item.topic;
  function renderFilters(){
   const topics=['重点','全部',...new Set(all.map(x=>x.topic).filter(Boolean))];if(!topics.includes(filter))filter='重点';
   for(const [topic,b]of filterNodes)if(!topics.includes(topic)){b.remove();filterNodes.delete(topic);}
   for(const topic of topics){let b=filterNodes.get(topic);if(!b){b=document.createElement('button');b.type='button';b.className='mfbtn';b.dataset.f=topic;b.addEventListener('click',()=>{filter=topic;renderFilters();renderList();});filters.appendChild(b);filterNodes.set(topic,b);}b.textContent=topic;b.classList.toggle('on',topic===filter);b.setAttribute('aria-pressed',String(topic===filter));}
  }
  const section=(label,values)=>values?.length?`<div class="evidence-section"><strong>${esc(label)}</strong><p>${values.map(v=>esc(v)).join('<br>')}</p></div>`:'';
  function markup(item){
   const a=item.assessment||{},url=client.safeURL(item.link),impacts=a.impacts||[{target:'纳指100',direction:'unknown',label:'待验证',rationale:'尚未分析'}];
   const scope=a.scope==='feed-excerpt'?'标题＋订阅摘要':'仅标题';const tier=a.evidenceTier==='official'?'官方原始源':'媒体报道';
   const facts=(a.facts||[]).map(f=>`${f.label}：${f.value}`);
   const additional=(item.reports||[]).filter(r=>r.link&&r.link!==item.link).slice(0,4).map(r=>{const u=client.safeURL(r.link);return u?`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(r.src||'转载来源')}</a>`:'';}).join(' · ');
   return `<div class="event-head"><span class="ntime">${fmtTime8(item.t)}</span><span class="mtopic">${esc(item.topic||a.topic||'宏观')}</span><span class="evidence-tier">${esc(tier)} · ${scope}</span><span class="nsrc">${esc(item.src||'未知来源')}</span></div>
    ${url?`<a class="event-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`:`<div class="event-link">${esc(item.title)}</div>`}
    <div class="impact-row">${impacts.map(x=>`<span class="impact-chip ${['positive','negative','mixed','unknown'].includes(x.direction)?x.direction:'unknown'}">${esc(x.target)} · ${esc(x.label||'待验证')}</span>`).join('')}<span class="impact-origin">本地条件规则${a.status==='background'?' · 历史背景':''}</span></div>
    <p class="event-summary">${esc(a.summary||'缺少事件证据，不沿用旧版情绪标签。')}</p>
    <details class="macro-evidence"><summary>查看依据、传导条件与反证</summary>
    ${section('已取得的来源信息',facts)}${section('为什么可能产生影响',impacts.map(x=>x.target+'：'+x.rationale))}${section('成立条件',a.conditions)}${section('反证与其他解释',a.counterEvidence)}${section('仍需核验',a.missing)}
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
  async function refreshMacro({followup=false}={}){
   if(!isOpen()||document.hidden)return true;void context?.refresh();if(inFlight)return inFlight;
   if(!followup){followups=0;clearTimeout(followupTimer);followupTimer=null;}
   const epoch=generation;renderStatus(true);
   inFlight=(async()=>{try{
    const response=await network.request('macro','/api/macro');if(!response.ok)throw new Error('HTTP '+response.status);
    const payload=await response.json();if(!Array.isArray(payload?.items))throw new Error('宏观数据格式错误');if(epoch!==generation)return false;
    sources=payload.sources||{};stale=payload.stale===true;error=payload.error||null;refreshing=payload.refreshing===true;
    if(payload.items.length||!(stale||error))all=payload.items;if(Number(payload.updatedAt)>0)updatedAt=Number(payload.updatedAt);
    renderFilters();renderList();renderStatus();onChange();
    if(isOpen()&&refreshing&&followups<6){followups++;followupTimer=setTimeout(()=>{followupTimer=null;void refreshMacro({followup:true});},2000);}return !(stale||error);
   }catch(e){if(epoch!==generation)return false;refreshing=false;stale=all.length>0;error=e.message;renderFilters();renderList();renderStatus();return false;}finally{inFlight=null;}})();return inFlight;
  }
  retry.addEventListener('click',()=>refreshMacro());
  return Object.freeze({refreshMacro,tick(){context?.tick();},cancel(){generation++;clearTimeout(followupTimer);followupTimer=null;network.abort?.('macro');context?.cancel();},items:()=>all,filterNodes});
 };
 window.PANEL_MACRO_CONTROLLER=Object.freeze({createMacroController});
})();
