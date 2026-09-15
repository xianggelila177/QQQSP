(() => {
 const createMacroContext=({document,network,root,status,isOpen=()=>true})=>{
  const {esc,fmtTime8}=window.PANEL_FORMAT;let pending=null,nextAt=0,generation=0,last=null;
  const checkTime=value=>{const date=new Date(Number(value)+8*3600000);return Number.isFinite(date.getTime())?date.toISOString().slice(5,19).replace('T',' '):'未知';};
  const sourceLink=e=>{try{const u=new URL(e.link);return /^https?:$/.test(u.protocol)?' · <a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer">原始发布来源</a>':'';}catch{return '';}};
  const names={ready:'窗口可比',warming:'采样积累中',stale:'时间陈旧或未知',error:'来源暂不可用',unavailable:'尚无数据',loading:'正在请求来源',daily:'日度参考',delayed:'来源延迟报价',closed:'来源显示休市'};
  const nodeKey=node=>node.nodeType===1?(node.getAttribute('data-event-id')||node.getAttribute('data-factor-id')):null;
  function patchNode(old,fresh){
   if(old.nodeType!==fresh.nodeType||old.nodeName!==fresh.nodeName){old.replaceWith(fresh);return fresh;}
   if(old.nodeType!==1){if(old.nodeValue!==fresh.nodeValue)old.nodeValue=fresh.nodeValue;return old;}
   for(const attr of [...old.attributes])if(!(old.tagName==='DETAILS'&&attr.name==='open')&&!fresh.hasAttribute(attr.name))old.removeAttribute(attr.name);
   for(const attr of [...fresh.attributes])if(!(old.tagName==='DETAILS'&&attr.name==='open')&&old.getAttribute(attr.name)!==attr.value)old.setAttribute(attr.name,attr.value);
   patchNodes(old,[...fresh.childNodes]);return old;
  }
  function patchNodes(parent,nodes){
   const previous=[...parent.childNodes],keyed=new Map(previous.filter(nodeKey).map(node=>[nodeKey(node),node]));
   let cursor=parent.firstChild;const used=new Set();
   for(const fresh of nodes){const key=nodeKey(fresh),old=key?keyed.get(key):cursor&&!nodeKey(cursor)?cursor:null;
    const inPlace=old&&old===cursor,current=old?patchNode(old,fresh):fresh;used.add(current);
    if(!inPlace&&current!==cursor)parent.insertBefore(current,cursor);cursor=current.nextSibling;
   }
   for(const old of previous)if(!used.has(old)&&old.parentNode===parent)old.remove();
  }
  function reconcile(parent,html){
   if(parent.__renderedHtml===html)return;parent.__renderedHtml=html;
   const active=document.activeElement,hadFocus=parent.contains(active),scroll=parent.scrollTop;
   const row=hadFocus?[...parent.children].findIndex(x=>x.contains(active)):-1;
   const template=document.createElement('template');template.innerHTML=html;patchNodes(parent,[...template.content.childNodes]);parent.scrollTop=scroll;
   if(hadFocus&&!parent.contains(active)){const next=parent.children[Math.max(0,Math.min(row,parent.children.length-1))];const target=next?.querySelector('summary,a,button')||parent;target.setAttribute('tabindex',target.getAttribute('tabindex')||'-1');target.focus({preventScroll:true});}
  }
  function factorMarkup(f,opened=new Set()){
    const value=typeof f.price==='number'&&Number.isFinite(f.price)?f.price.toLocaleString('zh-CN',{maximumFractionDigits:4}):'—';
    const mins=(f.windowMs||60000)/60000;
    const change=typeof f.change==='number'&&Number.isFinite(f.change)?`${f.change>0?'+':''}${f.change.toFixed(3)}${f.changeUnit==='%'?'%':f.changeUnit==='百分点'?'个百分点':'（来源数值差）'}`:'等待同窗数据';
    const tone=f.change>0?'positive':f.change<0?'negative':'unknown';
    const paused=['error','stale','unavailable'].includes(f.status);
    const windowText=f.daily?(paused?'日度参考已过期，等待来源恢复':'日度参考，不参与分钟比较'):f.status==='delayed'?(f.feedDelayMinutes>0?'来源延迟 '+f.feedDelayMinutes+' 分钟，持续刷新':'来源标记为延迟报价，持续刷新'):f.status==='closed'?'休市参考价，仍定期检查':f.status==='loading'?'正在请求候选来源':paused?(f.price===null?'来源请求失败，按计划重试':'保留参考价，暂停分钟比较'):`近${mins}分钟 ${change}`;
    const diagNames={EAI_AGAIN:'DNS解析失败',ENOTFOUND:'域名未解析',ECONNRESET:'连接中断',ETIMEDOUT:'请求超时',MACRO_SOURCE_TIMEOUT:'候选来源等待超时',MACRO_SYMBOL_EMPTY:'响应缺少品种或有效日期',MACRO_BATCH_EMPTY:'批量响应没有有效行情',MACRO_OLD_QUOTE:'已丢弃较旧报价',SOURCE_COOLDOWN:'限流冷却'};
    const sourceUrl=f.sourceUrl?sourceLink({link:f.sourceUrl}):'';
    return `<section class="macro-factor" data-factor-id="${esc(f.id||f.symbol)}"><div class="factor-name">${esc(f.name)}</div><div class="factor-price">${esc(value)} <small>${esc(f.unit)}</small></div><div class="factor-window ${tone}">${esc(windowText)}</div><div class="factor-meta">${esc(f.symbol)} · ${esc(names[f.status]||'等待')}<br>${esc(f.source||'未取得来源')} · ${f.daily?'数据日 '+esc(f.observationDate||'未知'):f.quoteAt?'来源时间 '+fmtTime8(f.quoteAt):'未取得可核验成交时点'}<br>${esc(f.availability||'')}${f.status==='warming'?' · 已积累'+Math.floor((f.sampledMs||0)/1000)+'秒':''}<br>检查 ${f.sourceCheckedAt?checkTime(f.sourceCheckedAt):'尚未成功'}${f.nextCheckAt?' · 下次 '+checkTime(f.nextCheckAt):''}</div><details class="factor-details" data-factor-id="${esc(f.id||f.symbol)}"${opened.has(f.id||f.symbol)?' open':''}><summary>来源口径</summary><div>${esc(f.feedCoverage||'未核验')}${sourceUrl}<br>来源声明延迟：${typeof f.feedDelayMinutes==='number'?esc(String(f.feedDelayMinutes))+'分钟':'未核验'}<br>${esc(f.priceBasis||'')}<br>检查 ${f.sourceCheckedAt?checkTime(f.sourceCheckedAt):'尚未成功'}${f.windowStart?'<br>区间 '+fmtTime8(f.windowStart)+' — '+fmtTime8(f.windowEnd):''}${f.sourceTimeText?'<br>来源原文时间 '+esc(f.sourceTimeText)+'（'+esc(f.sourceTimeZone||'来源时区')+'）':''}${f.nextCheckAt?'<br>下次最早检查 '+checkTime(f.nextCheckAt):''}${(f.diagnostics||[]).map(d=>'<br>'+esc(d.source+'：'+d.status+(d.code?' · '+(diagNames[d.code]||d.code):''))+(d.retryAt?' · 最早重试 '+fmtTime8(d.retryAt):'')).join('')}${f.error?'<br>'+esc(f.error):''}</div></details></section>`;

  }
  function render(payload){
   const calendar=document.getElementById('macroCalendar'),c=payload.calendar;
   if(calendar&&c){reconcile(calendar,'<p class="calendar-note">'+esc(c.note||'')+(c.error?' · '+esc(c.error):'')+'</p>'+(c.items||[]).map(e=>'<article class="calendar-event" data-event-id="'+esc(e.id||[e.event,e.reference,e.releaseAt].join('|'))+'"><div><strong>'+esc(e.event)+'</strong> · '+esc(e.reference)+' · '+fmtTime8(e.releaseAt)+' · 重要性 '+esc(({1:'低',2:'中',3:'高'})[e.importance]||'未知')+(e.status==='scheduled'?' · 待发布':'')+'</div><div class="calendar-values"><span>实际 '+esc(e.actual??'未发布')+'</span><span>一致预期 '+esc(e.consensus??'缺失')+'</span><span>前值 '+esc(e.previous??'缺失')+'</span><span>实际−预期 '+(typeof e.surprise==='number'?esc(String(e.surprise))+' 个百分点':'待验证')+'</span></div><div>'+esc(e.label)+' · '+(e.consensusCapturedAt?'本机发布前记录 '+fmtTime8(e.consensusCapturedAt):'未在本机记录发布前预期')+'</div><details><summary>口径与修订</summary><p>'+esc(e.caveat)+'<br>当前共识 '+esc(e.currentConsensus??'缺失')+' · 模型预测（非共识） '+esc(e.modelForecast??'缺失')+'<br>前次公布值（修订前） '+esc(e.previousBeforeRevision??'未提供')+' · 来源 '+esc(e.source)+sourceLink(e)+'<br>计划时点精度 '+(e.timePrecision==='exact'?'明确':'估计')+'</p></details></article>').join(''));}
   last=payload;const ready=payload.factors.filter(f=>f.fresh).length;
   status.textContent=`跨资产观察 · ${payload.factors.filter(f=>f.price!==null).length}/${payload.factors.length} 项有报价 · ${ready}项有近期来源时间 · ${payload.factors.filter(f=>f.comparisonBasis==='observation').length}项服务器观察 · ${payload.factors.filter(f=>f.daily).length}项日度参考 · ${payload.factors.filter(f=>f.status==='delayed').length}项来源延迟 · 后台独立采集`+(payload.refreshing?' · 正在补充来源':'');
   status.title='时间新近不代表交易所全市场实时权限；延迟未知的来源仍需核验。';
   const opened=new Set([...(root.querySelectorAll?.('details[open]')||[])].map(n=>n.dataset.factorId));
   reconcile(root,payload.factors.map(f=>{
    return factorMarkup(f,opened);
   }).join(''));
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
  return {renderFactor:factorMarkup,apply(payload){last=payload;if(isOpen()&&!document.hidden)render(payload);},redraw(){if(last&&isOpen()&&!document.hidden)render(last);},refresh,tick(){if(isOpen()&&!document.hidden&&Date.now()>=nextAt)void refresh();},cancel(){generation++;network.abort?.('macro-context');},snapshot:()=>last};
 };
 window.PANEL_MACRO_CONTEXT=Object.freeze({createMacroContext});
})();
