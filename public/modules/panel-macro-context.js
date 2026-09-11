(() => {
 const createMacroContext=({document,network,root,status,isOpen=()=>true})=>{
  const {esc,fmtTime8}=window.PANEL_FORMAT;let pending=null,nextAt=0,generation=0,last=null;
  const sourceLink=e=>{try{const u=new URL(e.link);return /^https?:$/.test(u.protocol)?' · <a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer">原始发布来源</a>':'';}catch{return '';}};
  const names={ready:'窗口可比',warming:'采样积累中',stale:'时间陈旧或未知',error:'来源暂不可用',unavailable:'尚无数据'};
  function render(payload){
   const calendar=document.getElementById('macroCalendar'),c=payload.calendar;
   if(calendar&&c){calendar.innerHTML='<p class="calendar-note">'+esc(c.note||'')+(c.error?' · '+esc(c.error):'')+'</p>'+(c.items||[]).map(e=>'<article class="calendar-event"><div><strong>'+esc(e.event)+'</strong> · '+esc(e.reference)+' · '+fmtTime8(e.releaseAt)+' · 重要性 '+esc(({1:'低',2:'中',3:'高'})[e.importance]||'未知')+(e.status==='scheduled'?' · 待发布':'')+'</div><div class="calendar-values"><span>实际 '+esc(e.actual??'未发布')+'</span><span>一致预期 '+esc(e.consensus??'缺失')+'</span><span>前值 '+esc(e.previous??'缺失')+'</span><span>实际−预期 '+(typeof e.surprise==='number'?esc(String(e.surprise))+' 个百分点':'待验证')+'</span></div><div>'+esc(e.label)+' · '+(e.consensusCapturedAt?'本机发布前记录 '+fmtTime8(e.consensusCapturedAt):'未在本机记录发布前预期')+'</div><details><summary>口径与修订</summary><p>'+esc(e.caveat)+'<br>当前共识 '+esc(e.currentConsensus??'缺失')+' · 模型预测（非共识） '+esc(e.modelForecast??'缺失')+'<br>前次公布值（修订前） '+esc(e.previousBeforeRevision??'未提供')+' · 来源 '+esc(e.source)+sourceLink(e)+'<br>计划时点精度 '+(e.timePrecision==='exact'?'明确':'估计')+'</p></details></article>').join('');}
   last=payload;const ready=payload.factors.filter(f=>f.fresh).length;
   status.textContent=`跨资产观察 · ${ready}/${payload.factors.length} 个来源时间在两分钟内 · 约30秒检查`+(payload.refreshing?' · 正在补充来源':'');
   status.title='时间新近不代表交易所全市场实时权限；延迟未知的来源仍需核验。';
   root.innerHTML=payload.factors.map(f=>{
    const value=typeof f.price==='number'&&Number.isFinite(f.price)?f.price.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
    const change=typeof f.change==='number'&&Number.isFinite(f.change)?`${f.change>0?'+':''}${f.change.toFixed(3)}${f.changeUnit==='%'?'%':'（来源数值差）'}`:'等待同窗数据';
    const tone=f.change>0?'positive':f.change<0?'negative':'unknown';
    return `<section class="macro-factor"><div class="factor-name">${esc(f.name)}</div><div class="factor-price">${esc(value)} <small>${esc(f.unit)}</small></div><div class="factor-window ${tone}">近15分钟 ${esc(change)}</div><div class="factor-meta">${esc(f.symbol)} · ${esc(names[f.status]||'等待')}<br>${esc(f.source||'未取得来源')} · 成交 ${f.quoteAt?fmtTime8(f.quoteAt):'时间未知'}</div><details class="factor-details"><summary>来源口径</summary><div>${esc(f.feedCoverage||'未核验')}<br>来源声明延迟：${typeof f.feedDelayMinutes==='number'?esc(String(f.feedDelayMinutes))+'分钟':'未核验'}<br>${esc(f.priceBasis||'')}<br>检查 ${f.sourceCheckedAt?fmtTime8(f.sourceCheckedAt):'尚未成功'}${f.windowStart?'<br>区间 '+fmtTime8(f.windowStart)+' — '+fmtTime8(f.windowEnd):''}${f.error?'<br>'+esc(f.error):''}</div></details></section>`;
   }).join('');
   const observation=document.getElementById('macroObservation');if(observation)observation.textContent=payload.observations?.join(' ')||'尚无可比窗口，不能据此判断资金轮动。';
  }
  async function refresh(){
   if(!isOpen()||document.hidden||pending)return pending;
   const epoch=generation;nextAt=Date.now()+30000;status.textContent=last?'正在检查跨资产来源，保留上次观察':'正在读取跨资产来源…';
   pending=(async()=>{try{
    const response=await network.request('macro-context','/api/macro/context');if(!response.ok)throw new Error('HTTP '+response.status);
    const payload=await response.json();if(!Array.isArray(payload?.factors))throw new Error('跨资产数据格式错误');
    if(epoch!==generation)return;render(payload);nextAt=Date.now()+(payload.refreshing?5000:30000);
   }catch(e){if(epoch!==generation)return;status.textContent='跨资产来源暂不可用'+(last?'，上次观察不代表当前状态':'');status.title=String(e.message);nextAt=Date.now()+60000;
    const observation=document.getElementById('macroObservation');if(observation)observation.textContent='无法取得当前观察，暂停更新判断；请核对来源时间。';
   }finally{pending=null;}})();return pending;
  }
  return {refresh,tick(){if(isOpen()&&!document.hidden&&Date.now()>=nextAt)void refresh();},cancel(){generation++;network.abort?.('macro-context');},snapshot:()=>last};
 };
 window.PANEL_MACRO_CONTEXT=Object.freeze({createMacroContext});
})();
