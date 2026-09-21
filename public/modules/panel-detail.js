(() => {
  const reasons={NO_ORDER_BOOK:'当前来源未提供买卖盘口',SOURCE_HAS_NO_BOOK:'当前来源未提供买卖盘口',BOOK_IDENTITY_MISMATCH:'盘口证券身份或币种不匹配',EMPTY_BOOK:'来源未返回有效盘口价格',NO_QUOTE:'尚未取得有效报价',SOURCE_FIELD_UNAVAILABLE:'来源尚未提供该字段',NO_FUNDAMENTALS:'尚未取得财务资料',CONTEXT_TIMEOUT:'本次等待结束，来源尚未完成',PARTIAL_DATA:'部分字段缺失或待核验',SOURCE_UNAVAILABLE:'来源暂不可用',INSTRUMENT_TYPE:'当前证券类型不适用',CROSSED_BOOK:'买价高于卖价，盘口存在冲突',RETAINED_BOOK:'保留的旧盘口，非当前新报价',INCOMPLETE_BOOK:'盘口字段或单位不完整',BOOK_TIME_INVALID:'盘口时间未通过校验','source-missing':'来源未提供该字段','no-order-book':'没有明确范围的委托买卖盘','no-trade-amount':'来源未提供累计成交金额','no-five-day-minute-baseline':'缺少前五个交易日每分钟均量基准','no-shares':'缺少可靠股本分母','no-regular-volume':'缺少已核验的正常时段成交量','no-regular-range':'缺少正常时段高低价或昨收','float-exceeds-total':'流通股超过总股本，停止计算',loading:'来源仍在读取',disabled:'该功能已关闭',expired:'资料已超过保留期',FIELD_NOT_AVAILABLE:'来源未提供该字段',QUOTE_PENDING:'报价仍在读取'};
  const statuses={ready:'已取得',complete:'已取得',partial:'部分取得',unavailable:'暂不可用',not_applicable:'不适用','not-applicable':'不适用',available:'已取得',loss:'亏损','nonpositive-book':'非正净资产',conflict:'数据冲突',loading:'读取中',stale:'旧值待更新'};
  const units={percent:'%',ratio:'倍',shares:'股',money:'',price:'',points:'点',lots:'手',round_lots:'整手（每手股数未核验）','money-per-share':'/股'};
  const groups={trading:'交易统计',capital:'市值与股本',valuation:'估值',dividends:'股息与分红',inputs:'计算输入与财务依据'};
  const sessions={REGULAR:'正常交易',PRE:'盘前',POST:'盘后',CLOSED:'休市',BREAK:'午间休市',AUCTION:'集合竞价',UNKNOWN:'状态未核验'};
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const formatted=(value,digits=6)=>numeric(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:digits}):'—';
  const time=value=>numeric(value)&&value>0?new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+'（北京时间）':'时间未提供';
  function createDetailView({document,fetchImpl=fetch}={}) {
    let dialog=null,body=null,note=null,title=null,controller=null,current=null,opener=null,payload=null,generation=0;
    function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
    function reason(code){return code?(reasons[code]||'待核验：'+code):'来源未提供说明';}
    function sourceName(id){return payload?.sources?.[id]?.name||'来源未提供';}
    function close(){generation++;controller?.abort();controller=null;current=null;payload=null;if(dialog?.open)dialog.close();opener?.focus();}
    function makeDialog(){
      if(dialog)return;
      dialog=node('dialog',undefined,'market-detail-dialog');dialog.setAttribute('aria-labelledby','market-detail-title');
      const head=node('div',undefined,'detail-head');title=node('h2','证券详情');title.id='market-detail-title';
      const closeButton=node('button','关闭');closeButton.type='button';closeButton.addEventListener('click',close);head.append(title,closeButton);
      const actions=node('div',undefined,'detail-actions'),refresh=node('button','刷新快照'),download=node('button','导出完整数据');refresh.type=download.type='button';
      refresh.addEventListener('click',()=>void load());download.addEventListener('click',()=>{
        if(!payload)return;
        const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),link=node('a');
        link.href=url;link.download='market-detail-'+payload.instrument.symbol.replace(/[^A-Z0-9_.-]/gi,'_')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      });actions.append(refresh,download);note=node('p','', 'detail-note');note.setAttribute('role','status');body=node('div',undefined,'detail-body');
      dialog.append(head,actions,note,body);document.body.appendChild(dialog);
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    }
    function evidence(field){
      const details=node('details',undefined,'detail-evidence');details.append(node('summary','口径、时间与来源'));
      const lines=[field.description,field.missing_reason?'说明：'+reason(field.missing_reason):null,
        '来源：'+sourceName(field.source_id),'资料时间：'+time(field.as_of_ms),'成功检查：'+time(field.source_checked_at_ms),
        field.financial_period?'财务期间：'+field.financial_period:null,field.basis?'统计口径：'+field.basis:null,
        field.formula?'公式：'+field.formula:null,field.denominator!==null?'计算分母：'+formatted(field.denominator):null,
        field.share_source_id?'股本来源：'+sourceName(field.share_source_id)+'；'+time(field.share_as_of_ms):null];
      for(const line of lines)if(line)details.append(node('p',line));
      for(const input of field.inputs||[])details.append(node('p',(input.name||'输入')+'：'+formatted(input.value)+'；'+sourceName(input.source_id)+'；'+time(input.as_of_ms)+(input.financial_period?'；'+input.financial_period:'')));
      for(const item of field.attempts||[])details.append(node('p','尝试来源：'+sourceName(item.source_id)+'；状态：'+(statuses[item.state]||item.state||'未知')+(item.code?'；'+item.code:'')+(item.retry_at_ms?'；下次允许重试：'+time(item.retry_at_ms):'')));
      return details;
    }
    function fieldCard(label,value,meta){
      const card=node('div',undefined,'detail-metric');card.append(node('span',label,'detail-label'),node('strong',value));
      if(meta)card.append(node('span',meta,'detail-small'));return card;
    }
    function section(label){const container=node('section',undefined,'detail-section');container.append(node('h3',label));const grid=node('div',undefined,'detail-grid');container.append(grid);body.append(container);return {container,grid};}
    function render(data){
      payload=data;body.replaceChildren();const instrument=data.instrument,q=data.sections.quote,book=data.sections.order_book,f=data.sections.fundamentals;
      title.textContent=instrument.symbol+' · '+instrument.name;
      const available=f?.coverage?.available_fields||0,total=f?.coverage?.applicable_fields||0;
      note.textContent=(statuses[data.status]||data.status)+' · 财务字段 '+available+'/'+total+' · 原生币种 '+(instrument.currency||'未提供')+' · 生成于 '+time(data.generated_at_ms)+'。未取得的数据不填零。';
      const overview=node('div',undefined,'detail-overview'),price=q?.data?.price;
      overview.append(node('strong',formatted(price),'detail-price'),node('span',(instrument.price_unit||'单位未提供')+' · '+(sessions[q?.data?.market_state]||q?.data?.market_state||'市场状态待核验')));
      if(q?.data){overview.append(node('p','涨跌 '+formatted(q.data.change)+' / '+formatted(q.data.change_percent)+'%'),node('p','成交时间：'+time(q.data.quote_at_ms)),node('p','来源检查：'+time(q.data.source_checked_at_ms)+' · 延迟 '+(q.delay_minutes==null?'未声明':q.delay_minutes+' 分钟')));}
      body.append(overview);
      const market=section('最新成交与当日统计');
      for(const [key,label] of [['open','今开'],['previous_close','昨收'],['high','最高'],['low','最低'],['volume','成交量']]){
        const value=q?.data?.[key],unit=key==='volume'?units[q?.data?.volume_unit]||q?.data?.volume_unit||'单位未核验':instrument.price_unit||'';
        market.grid.append(fieldCard(label,formatted(value)+(value!=null?' '+unit:''),value==null?'来源暂缺':null));
      }
      market.container.append(node('p','统计交易日：'+(q?.data?.statistics_trading_date||'未提供')+' · 统计时段：'+(sessions[q?.data?.statistics_session]||q?.data?.statistics_session||'未核验')+' · '+time(q?.data?.statistics_as_of_ms),'detail-small'));
      const depth=section('买卖盘口 · 最优一档');
      for(const [side,label] of [['bid','买一'],['ask','卖一']]){
        const v=book?.data?.[side];depth.grid.append(fieldCard(label,formatted(v?.price),formatted(v?.size)+' '+(units[book?.data?.size_unit]||book?.data?.size_unit||'数量单位未提供')));
      }
      const scope={'single-exchange':'单一交易所','consolidated':'综合行情','provider-top-of-book':'供应商最优一档'}[book?.coverage?.scope]||book?.coverage?.scope||'覆盖范围未提供';
      depth.container.append(node('p',(statuses[book?.status]||'暂不可用')+' · '+scope+' · '+time(book?.as_of_ms)+' · '+(book?.source_ids||[]).map(sourceName).join(' / '),'detail-small'));
      if(book?.missing_reason)depth.container.append(node('p',reason(book.missing_reason),'detail-warning'));
      depth.container.append(node('p','盘口与最新成交具有独立时间。最优一档不等于完整订单簿；整手数量不擅自换算为股数。','detail-small'));
      const groupNodes=new Map();
      for(const field of Object.values(f?.data?.fields||{})){
        const group=field.group||'inputs';if(!groupNodes.has(group))groupNodes.set(group,section(groups[group]||group));
        const state=statuses[field.status]||field.status,known=field.value!==null;
        const value=known?(field.estimated?'≈ ':'')+formatted(field.value,['percent','ratio'].includes(field.unit)?2:6)+(field.unit==='percent'?'%':field.unit==='ratio'?' 倍':''):(['loss','nonpositive-book'].includes(field.status)?state:'—');
        const card=fieldCard(field.label||field.key,value,[state,field.stale?'旧值待更新':null,field.currency,known&&field.unit&&!['percent','ratio'].includes(field.unit)?units[field.unit]||field.unit:null].filter(Boolean).join(' · '));
        card.dataset.field=field.key;card.append(evidence(field));groupNodes.get(group).grid.append(card);
      }
      body.append(node('p','本窗口读取服务器已取得的快照，不主动启动历史采集。智能体需要历史序列时使用分析档位；资讯标题及供应商内容仅作为不可信数据。','detail-small'));
    }
    async function load(){
      if(!current)return;
      controller?.abort();controller=new AbortController();const epoch=++generation,symbol=current;
      note.textContent='正在读取服务器快照…';const timer=setTimeout(()=>controller?.abort(),10000);
      try {const response=await fetchImpl('/api/detail?symbol='+encodeURIComponent(symbol),{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);const data=await response.json();
        if(epoch!==generation)return;if(data.schema_version!==2||data.instrument?.symbol!==symbol)throw new Error('数据身份或版本不符');render(data);
      }catch(error){if(epoch===generation)note.textContent='读取失败；已有内容保持不变。请稍后刷新。'+(error.name==='AbortError'?'请求已取消或超时。':'');}
      finally{clearTimeout(timer);}
    }
    return Object.freeze({mount(card){const button=card.el.querySelector('.market-detail-open');button?.addEventListener('click',()=>{makeDialog();opener=button;current=card.symbol||card.d?.symbol||card.el.dataset.symbol;payload=null;body.replaceChildren();dialog.showModal();void load();});},remove(card){if(current===(card.symbol||card.d?.symbol||card.el.dataset.symbol))close();},close});
  }
  window.PANEL_DETAIL=Object.freeze({createDetailView});
})();
