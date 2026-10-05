(() => {
  const createChartDetailView=({document,formatterFor,UP,DOWN,network=window.PANEL_NETWORK.createNetwork({timeoutMs:30000}),canPoll=()=>!document.hidden,quoteClock=null})=>{
    const engine=window.PANEL_CHART_ENGINE.createChartEngine({UP,DOWN,
      fmtDate:window.PANEL_FORMAT.fmtDate,formatterFor,maSeries:window.PANEL_CHART.maSeries});
    const fmt=window.PANEL_FORMAT,periods=window.PANEL_TIMEFRAMES.all.flatMap(period=>period.key==='intraday'?[['intraday','一日'],['fiveDay','五日']]:[[period.key,period.label]]);
    let dialog=null,current=null,tf='intraday',tapeSession='auto',five=null,remote=null,poll=null,
      drawFrame=null,resizeObserver=null,manualRotate=null,
      hover=null,drag=null,lastTap=null,view={},pageAway=false,pollingAllowed=null;
    const historyReadAt=new Map(),fiveCache=new Map(),savedViews=new Map(),olderAttempts=new Map();
    let marketView=null,historyUnsubscribe=null,olderJob=null,currentViews=null;
    const viewport=window.PANEL_CHART_VIEWPORT;
    const clock=quoteClock||{now:Date.now};
    const ageTicker=window.PANEL_SCHEDULER.createDisplayTicker(()=>{if(current)renderSummary();},{now:()=>clock.now()});
    const modal=window.PANEL_DETAIL_DIALOG.createDetailDialog({document,window,onBack:()=>close(true)});
    const marketModel=window.PANEL_MARKET_DETAIL_MODEL.createMarketDetailModel({network,canRead:()=>!!current&&!pageAway&&canPoll(),onChange:(value,error)=>{
      if(!current)return;remote=value;renderMarket();if(error)dialog.querySelector('.cd-tape-status').textContent='详情接口暂不可用：'+error;
    }});
    let chartStyle='candle',chartJob=null,chartEpoch=0,settingsBinding=null,chartSettings=null,sideOpen=true,
      drawingStore=null,drawingTool=null,drawingDraft=null,drawingIdentity=null,fiveIdentityKey=null;
    const workspace=()=>window.PANEL_CHART_WORKSPACE;
    const drawings=()=>window.PANEL_CHART_DRAWINGS;
    const fiveKey=q=>[q?.symbol,q?.d?.currency,q?.d?.regularChart?.tradeDate||'unknown'].join(':');
    function cachedFive(q){const hit=fiveCache.get(fiveKey(q));return hit&&Date.now()-hit.savedAt<86400000?{...hit.value,stale:!!hit.value.stale||Date.now()-(hit.value.sourceCheckedAt||hit.savedAt)>120000,refreshing:true}:null;}
    function saveFive(q,value){if(!value?.bars?.length)return;const key=fiveKey(q);
      fiveCache.delete(key);fiveCache.set(key,{value,savedAt:Date.now()});
      while(fiveCache.size>30)fiveCache.delete(fiveCache.keys().next().value);
    }
    function cancelChart(){chartEpoch++;chartJob?.controller.abort();chartJob=null;}
    function rememberView(period=tf){
      if(!currentViews)return;
      currentViews[period]={...viewport.createView(),winStart:view.winStart,followEnd:view.followEnd,
        fullSession:view.fullSession,chartStyle,visN:{...view.visN},visible:view.plot?.vis,
        anchor:view.plot?viewport.captureAnchor(view.plot.all,view):view.anchor||null};
    }
    const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
    const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const periodLabel=(bar,period)=>period==='yearly'?bar.periodStart?.slice(0,4):
      period==='monthly'?bar.periodStart?.slice(0,7):bar.periodStart;
    const volumeLabel=unit=>unit==='shares'?'股':unit==='lots'?'手':unit==='contracts'?'张':
      !unit||unit==='source-unit-unverified'?'单位待核验':unit;
    const zone=()=>current?.d?.regularChart?.exchangeZone||'UTC';
    const zoneLabel=()=>zone()==='America/New_York'?'美东':zone()==='Asia/Shanghai'?'北京时间':zone();
    const time=(ms,selectedZone=zone(),withSeconds=false)=>{
      if(!number(ms))return '时间未提供';
      try{return new Intl.DateTimeFormat('zh-CN',{timeZone:selectedZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(withSeconds?{second:'2-digit'}:{}),hour12:false}).format(new Date(ms));}
      catch{return new Date(ms).toISOString().slice(0,withSeconds?19:16);}
    };
    const reason={SOURCE_HAS_NO_BOOK:'来源未提供盘口',INSTRUMENT_TYPE:'该品种无盘口',RETAINED_BOOK:'盘口已过期',
      NO_RECEIVED_TRADES:'该时段尚未收到逐笔',TRADE_STREAM_NOT_CONFIGURED:'逐笔源未配置',
      FIVE_DAY_SOURCE_GAPS:'五日历史覆盖不足',FIVE_DAY_SOURCE_UNAVAILABLE:'五日历史来源不可用',
      FIVE_DAY_SESSION_OPEN:'当日常规时段尚未收盘',
      CLOSING_PRINT_COVERAGE_UNVERIFIED:'收盘成交覆盖待核验',DETAIL_LOADING:'盘口加载中',DETAIL_REQUEST_FAILED:'详情刷新失败，盘口暂不可用',DETAIL_PAUSED:'后台已暂停，盘口待重新检查',
      SOURCE_COOLDOWN:'五日历史来源限流冷却中',REGULAR_HISTORY_NOT_AVAILABLE:'常规历史暂不可用',CHART_SOURCE_STALE:'历史来源刷新失败，保留旧图'};
    function ensure(){
      if(dialog)return;
      dialog=make('dialog','chart-detail-dialog');dialog.setAttribute('aria-labelledby','chart-detail-title');
      dialog.innerHTML=`<div class="chart-detail-shell">
        <header class="chart-detail-head"><div class="chart-detail-identity"><strong id="chart-detail-title">证券行情</strong><span class="cd-status"></span></div>
        <div class="cd-quote"><strong class="cd-price">—</strong><span class="cd-change">—</span><small class="cd-baseline"></small><small class="cd-extension"></small></div>
        <div class="cd-facts"></div><div class="cd-head-actions"><button type="button" data-action="side" aria-expanded="true" aria-controls="chart-detail-market">收起盘口</button><button type="button" class="cd-close" aria-label="关闭行情详情">×</button></div></header>
        <div class="cd-toolbar"><nav class="cd-periods" aria-label="行情周期"></nav><div class="cd-toolbar-options"><div class="cd-style" role="group" aria-label="图表类型">
          <button type="button" data-chart-style="candle" aria-pressed="true">蜡烛 K线</button>
          <button type="button" data-chart-style="line" aria-pressed="false">分时线</button></div><div class="cd-settings">${workspace()?.settingsMarkup('detail')||''}</div>
          <details class="cd-help"><summary>操作帮助</summary><div><p>拖动浏览历史；Ctrl / ⌘ + 滚轮缩放；双击回到最新。</p><p>聚焦图表后，← → 浏览，Home / End 到首尾，+ / − 缩放，L 跟随最新。绘图工具点击设置锚点，Esc 取消绘图或关闭详情。</p><p>指标按所选周期的真实数据计算，样本不足留空。绘图仅保存于本机；盘口与逐笔缺失会保留来源说明。</p></div></details></div></div>
        <div class="cd-range" role="group" aria-label="可见 K 线数量"><span>可视范围</span><button type="button" data-range="30">30 根</button><button type="button" data-range="90">90 根</button><button type="button" data-range="180">180 根</button><button type="button" data-range="all">全部已加载</button><span class="cd-range-state"></span></div>
        <div class="chart-detail-body"><main class="cd-main"><div class="cd-chart-info" role="status"></div>
          <div class="cd-readout"><div class="cd-point" role="status"></div><div class="cd-studies"></div><div class="chart-scale-note" role="status"></div></div>
          <div class="cd-plot"><canvas class="cd-canvas" tabindex="0" aria-label="详情行情图，左右键浏览数据点，加减键缩放，L 跟随最新"></canvas>
            <canvas class="cd-drawing-layer" aria-hidden="true"></canvas><canvas class="cd-cursor" aria-hidden="true"></canvas></div>
          <details class="cd-quality"><summary>图表来源与范围</summary><p class="cd-chart-quality"></p></details></main>
          <aside id="chart-detail-market" class="cd-side"><div class="cd-book"><h3>买卖盘口 · 一档</h3><div class="cd-book-status" role="status"></div>
            <div class="cd-book-row"><span>卖一</span><b class="cd-ask">—</b><span class="cd-ask-size">—</span></div>
            <div class="cd-book-row"><span>买一</span><b class="cd-bid">—</b><span class="cd-bid-size">—</span></div><small class="cd-book-meta"></small><details class="cd-quality"><summary>盘口来源与范围</summary><p class="cd-book-quality"></p></details></div>
            <div class="cd-tape"><label class="cd-tape-filter">逐笔时段 <select class="cd-tape-session" aria-label="逐笔时段">
              <option value="auto">最近时段</option><option value="regular">常规</option><option value="pre">盘前</option><option value="post">盘后</option>
              </select></label><div class="cd-side-tabs"><button type="button" data-side="tape" aria-pressed="true">逐笔明细</button>
              <button type="button" data-side="stats" aria-pressed="false">成交统计</button></div>
              <div class="cd-tape-status" role="status"></div><details class="cd-quality"><summary>逐笔来源与范围</summary><p class="cd-tape-quality"></p></details><div class="cd-tape-list"></div><div class="cd-tape-stats" hidden></div></div></aside></div>
        <footer class="chart-detail-foot"><div class="cd-draw-tools" role="group" aria-label="绘图工具"><button type="button" data-draw="horizontal" aria-pressed="false">水平线</button><button type="button" data-draw="trend" aria-pressed="false">趋势线</button><button type="button" data-draw="measure" aria-pressed="false">区间测量</button><button type="button" data-draw="undo">撤销</button><button type="button" data-draw="clear">清除</button><span class="cd-draw-state" role="status"></span></div>
          <div class="cd-tools"><button type="button" data-action="older" hidden>加载更早</button><span class="cd-history-state" role="status"></span><button type="button" data-action="in" aria-label="放大图表">＋</button><button type="button" data-action="out" aria-label="缩小图表">－</button>
          <button type="button" data-action="fit">全览</button><button type="button" data-action="latest">最新</button>
          <button type="button" data-action="shot">导出PNG</button><button type="button" data-action="rotate" aria-pressed="false">横向显示</button><button type="button" data-action="fullscreen" aria-pressed="false">全屏</button></div></footer></div>`;
      const nav=dialog.querySelector('.cd-periods');
      for(const [key,label] of periods){const b=make('button','',label);b.type='button';b.dataset.tf=key;nav.appendChild(b);}
      document.body.appendChild(dialog);
      marketView=window.PANEL_MARKET_DETAIL_VIEW.createMarketDetailView({document,root:dialog});
      dialog.querySelector('.cd-close').addEventListener('click',()=>close());
      dialog.querySelector('.cd-tape-session').addEventListener('change',event=>void selectTapeSession(event.target.value));
      dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
      dialog.querySelectorAll('[data-tf]').forEach(b=>b.addEventListener('click',()=>void selectPeriod(b.dataset.tf)));
      dialog.querySelectorAll('[data-side]').forEach(b=>b.addEventListener('click',()=>selectSide(b.dataset.side)));
      dialog.querySelectorAll('[data-chart-style]').forEach(b=>b.addEventListener('click',()=>{
        chartStyle=b.dataset.chartStyle;view.chartStyle=chartStyle;queueDraw();
      }));
      dialog.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.action)));
      dialog.querySelectorAll('[data-draw]').forEach(b=>b.addEventListener('click',()=>selectDrawingTool(b.dataset.draw)));
      dialog.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>{
        if(!view.plot)return;view.visN={...view.visN,[view.tf]:b.dataset.range==='all'?view.plot.all.length:Number(b.dataset.range)};
        view.followEnd=true;view.winStart=null;view.fullSession=b.dataset.range==='all';queueDraw();
      }));
      const cv=dialog.querySelector('.cd-canvas');
      cv.addEventListener('pointermove',e=>pointerMove(e));cv.addEventListener('pointerleave',()=>{if(!drag){hover=null;paintCursor();}});
      cv.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;
        if(drawingTool){placeDrawing(e);return;}
        const p=view.plot;drag={id:e.pointerId,start:local(e,p),winStart:view.winStart??0,moved:false};
        try{cv.setPointerCapture(e.pointerId);}catch{}
      });
      cv.addEventListener('pointerup',e=>{if(!drag||e.pointerId!==drag.id)return;
        const point=local(e,view.plot),travel=Math.hypot(point.x-drag.start.x,point.y-drag.start.y),isTap=travel<12;
        drag=null;if(isTap){const now=Date.now();if(lastTap&&now-lastTap.at<300&&
          Math.hypot(lastTap.x-point.x,lastTap.y-point.y)<12){lastTap=null;view.followEnd=true;view.fullSession=false;queueDraw();}
          else lastTap={at:now,x:point.x,y:point.y};}
      });
      cv.addEventListener('pointercancel',()=>{drag=null;});
      cv.addEventListener('wheel',e=>{if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();zoom(e.deltaY>0?'out':'in',e);},{passive:false});
      cv.addEventListener('keydown',e=>{const p=view.plot;if(!p?.n)return;
        if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();hover=e.key==='Home'?0:e.key==='End'?p.n-1:
          Math.max(0,Math.min(p.n-1,(hover??p.n-1)+(e.key==='ArrowLeft'?-1:1)));paintCursor();}
        if(['+','=','-','_'].includes(e.key)){e.preventDefault();zoom(e.key==='-'||e.key==='_'?'out':'in');}
        if(e.key.toLowerCase()==='l'){e.preventDefault();action('latest');}
        if(e.key==='Escape'){e.preventDefault();if(drawingTool||drawingDraft){selectDrawingTool(null);e.stopPropagation?.();}else close();}
      });
    }
    function local(e,p){
      const rect=dialog.querySelector('.cd-canvas').getBoundingClientRect(),w=p?.W||rect.width,h=p?.H||rect.height;
      return dialog.classList.contains('is-rotated')?
        {x:(e.clientY-rect.top)*w/Math.max(1,rect.height),y:(rect.right-e.clientX)*h/Math.max(1,rect.width)}:
        {x:(e.clientX-rect.left)*w/Math.max(1,rect.width),y:(e.clientY-rect.top)*h/Math.max(1,rect.height)};
    }
    function nearest(p,x){let lo=0,hi=p.n-1;while(lo<hi){const mid=(lo+hi)>>1;if(p.x(mid)<x)lo=mid+1;else hi=mid;}
      return lo>0&&Math.abs(p.x(lo-1)-x)<Math.abs(p.x(lo)-x)?lo-1:lo;}
    function pointerMove(e){const p=view.plot;if(!p?.n)return;const point=local(e,p);
      if(drawingTool){const anchor=drawings()?.pointFromPlot(p,point.x,point.y);
        if(drawingDraft?.points.length&&anchor)drawingDraft={...drawingDraft,points:[drawingDraft.points[0],anchor]};
        paintDrawings();hover=nearest(p,point.x);paintCursor();return;}
      if(drag&&drag.id===e.pointerId){const dx=point.x-drag.start.x;
        if(Math.abs(dx)>3)drag.moved=true;
        if(drag.moved){drag.last=point;const max=Math.max(0,p.all.length-p.vis),step=p.timeline?Math.max(1,p.W/p.vis):p.slot;
          const next=Math.max(0,Math.min(max,Math.round(drag.winStart-dx/step)));
          if(next!==view.winStart){view.winStart=next;view.followEnd=next>=max;queueDraw();}
          if(next<=Math.max(2,Math.floor(p.vis*.1)))void loadOlder();}return;}
      const idx=nearest(p,point.x);if(idx!==hover){hover=idx;paintCursor();}
    }
    function selectDrawingTool(tool){
      if(tool==='undo'||tool==='clear'){drawingStore?.[tool](drawingIdentity);drawingDraft=null;paintDrawings();return;}
      drawingTool=tool===drawingTool?null:tool;drawingDraft=null;drag=null;
      dialog.querySelectorAll('[data-draw]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.draw===drawingTool)));
      dialog.querySelector('.cd-draw-state').textContent=drawingTool==='horizontal'?'点击价格区放置水平线':drawingTool?'点击起点，再点击终点':'拖动浏览 · 绘图保存在本机';
      paintDrawings();
    }
    function placeDrawing(event){const p=view.plot;if(!p?.n||!drawingStore||!drawingIdentity)return;
      const point=local(event,p),anchor=drawings()?.pointFromPlot(p,point.x,point.y);if(!anchor)return;
      if(drawingTool==='horizontal'){drawingStore.add(drawingIdentity,{type:drawingTool,points:[anchor]});drawingDraft=null;}
      else if(drawingDraft?.points.length){drawingStore.add(drawingIdentity,{type:drawingTool,points:[drawingDraft.points[0],anchor]});drawingDraft=null;}
      else drawingDraft={type:drawingTool,points:[anchor]};
      dialog.querySelector('.cd-draw-state').textContent=drawingDraft?'点击终点 · Esc 取消':'已保存于本机 · 可继续绘制';paintDrawings();
    }
    function paintDrawings(){const p=view.plot,canvas=dialog?.querySelector('.cd-drawing-layer');if(!p||!canvas)return;
      const ctx=canvas.getContext('2d');ctx.setTransform(canvas.width/p.W,0,0,canvas.height/p.H,0,0);ctx.clearRect(0,0,p.W,p.H);
      drawings()?.draw(ctx,p,drawingStore?.get(drawingIdentity)||[],{draft:drawingDraft,formatter:formatterFor(view._chartData).money});
    }
    function paintCursor(){const p=view.plot,cursor=dialog?.querySelector('.cd-cursor');if(!p||!cursor)return;
      const c=cursor.getContext('2d');c.setTransform(cursor.width/p.W,0,0,cursor.height/p.H,0,0);
      engine.drawCursor(view,p,hover,c);
      const b=p.bars[hover??p.n-1];if(!b)return;
      const money=formatterFor(view._chartData).money;
      const date=p.intraday?time(b.t*1000)+' '+zoneLabel():(periodLabel(b,tf)||'交易日未知');
      const missing=!p.intraday&&fmt.historyGapNote?.(current.historyStore?.getMeta(tf)?.meta,b);
      dialog.querySelector('.cd-point').textContent=date+' · '+(p.candle&&!b._live?
        '开 '+money(b.o)+' 高 '+money(b.h)+' 低 '+money(b.l)+' 收 '+money(b.c):(b._live?'最新报价点 ':'价 ')+money(b.c))+
        ' · 区间量 '+(number(b.v)==null?'暂缺':fmt.fmtVol(b.v)+' '+volumeLabel(view._volumeUnit))+(view._vwapSeries?.[p.a+(hover??p.n-1)]!=null?
        ' · 估算均价 '+money(view._vwapSeries[p.a+(hover??p.n-1)]):'')+(missing?' · '+missing:'');
      dialog.querySelector('.cd-studies').textContent=workspace()?.studyReadout?.(p,hover??p.n-1,money)||'';
    }
    function chartModel(){
      const q=current;if(!q?.d)return null;
      const candle=tf!=='intraday'&&tf!=='fiveDay';
      const entry=candle?q.historyStore?.getMeta(tf):null,meta=entry?.meta;
      const fiveData=fiveIdentityKey===fiveKey(q)&&five?.currency===q.d.currency?five:null;
      const fiveChart=fiveData&&{...q.d.regularChart,bars:fiveData.bars,regularSessions:fiveData.regularSessions,
        previousCloseReference:fiveData.previousCloseReference,tradeDate:fiveData.tradeDates?.at(-1),
        source:fiveData.source,volumeUnit:fiveData.volumeUnit,pointKind:fiveData.pointKind,resolution:fiveData.resolution,
        intervalSeconds:number(fiveData.intervalSeconds)>0?fiveData.intervalSeconds:({'1m':60,'5m':300}[fiveData.resolution]||null)};
      const data=tf==='fiveDay'?{...q.d,regularChart:fiveChart,intradayLiveStatus:'unavailable'}:
        candle?{...q.d,currency:meta?.currency||q.d.currency,instrumentType:meta?.instrumentType||q.d.instrumentType}:q.d;
      const bars=tf==='fiveDay'?fiveData?.bars||[]:tf==='intraday'?q.d.regularChart?.bars||[]:q.historyStore?.getSeries(tf)||[];
      return {data,bars,candle,entry,meta};
    }
    function chartInfo(model,count){
      const chart=model?.candle?model.meta:tf==='fiveDay'?five:current?.d?.regularChart,p=view.plot;
      const label=periods.find(([key])=>key===tf)?.[1]||'图表';
      const declaredInterval=tf!=='fiveDay'||number(five?.intervalSeconds)>0||['1m','5m'].includes(five?.resolution);
      const mode=p?.candle?(p.intraday?(declaredInterval&&number(p.intervalSeconds)>0?(p.intervalSeconds/60)+'分钟 蜡烛K线':'蜡烛K线 · 粒度待核验'):'蜡烛K线'):model?.candle||!declaredInterval?'收盘线':'分时线';
      const issues=[];
      if(tf==='fiveDay'&&five?.coveredDays<5)issues.push('覆盖 '+five.coveredDays+'/5 日');
      if(chart?.stale||model?.entry?.status==='stale')issues.push('缓存待更新');
      if(chart?.refreshing)issues.push('后台更新中');
      if(model?.entry?.status==='loading'&&!count)issues.push('加载中');
      if(!declaredInterval)issues.push('粒度待核验');
      if(chartStyle==='candle'&&p&&!p.candleAvailable)issues.push(p.candleUnavailableReason||'来源仅有价格点');
      if(!count)issues.push(reason[chart?.reason||chart?.missingReason]||'暂无数据');
      const quality=window.PANEL_MARKET_DETAIL_VIEW.chartQuality(chart||{},model?.meta||{},model?.entry||{});
      dialog.querySelector('.cd-chart-quality').textContent=quality.detail;
      return [label,mode,quality.short,...issues].filter(Boolean).join(' · ');
    }
    function draw(){drawFrame=null;if(!current||!dialog?.open)return;
      updateOlderButton();
      const model=chartModel(),cv=dialog.querySelector('.cd-canvas'),cursor=dialog.querySelector('.cd-cursor'),drawingCanvas=dialog.querySelector('.cd-drawing-layer');
      if(!model||!model.bars.length){view.plot=null;drawingDraft=null;drawingIdentity=null;dialog.querySelectorAll('[data-chart-style]').forEach(button=>{button.disabled=button.dataset.chartStyle==='candle';button.setAttribute('aria-pressed','false');});for(const c of [cv,cursor,drawingCanvas])c.getContext('2d').clearRect(0,0,c.width,c.height);
        dialog.querySelector('.cd-chart-info').textContent=chartInfo(model,0);
        dialog.querySelector('.cd-point').textContent='该周期历史暂不可用';dialog.querySelector('.cd-studies').textContent='';dialog.querySelector('.chart-scale-note').textContent='';dialog.querySelector('.cd-range-state').textContent='';return;}
      const identityMeta=model.candle?model.meta:tf==='fiveDay'?five:model.data.regularChart;
      const nextIdentity=JSON.stringify([current.symbol,tf,model.data.currency,identityMeta?.seriesId||null,identityMeta?.source||null,
        identityMeta?.adjustmentBasis||(typeof identityMeta?.adjustment==='string'?identityMeta.adjustment:identityMeta?.adjustment?.basis)||null,identityMeta?.priceScale||null]);
      if(nextIdentity!==drawingIdentity){drawingIdentity=nextIdentity;drawingDraft=null;}
      const plotBox=dialog.querySelector('.cd-plot').getBoundingClientRect();
      const rotated=dialog.classList.contains('is-rotated');
      const width=rotated?plotBox.height:plotBox.width,height=rotated?plotBox.width:plotBox.height;
      const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
      view={...view,d:model.data,_chartData:model.data,tf:tf==='fiveDay'?'intraday':tf,cv,
        _volumeUnit:model.candle?model.meta?.volumeUnit:tf==='fiveDay'?five?.volumeUnit:current.d.regularChart?.volumeUnit,
        historyStore:current.historyStore,_displayIntraday:model.candle?null:model.bars,
        _sampled:false,_fiveDay:tf==='fiveDay',_detail:true,_displayZone:zone(),_zoneLabel:zoneLabel(),
        _intervalUnknown:tf==='fiveDay'&&!(number(model.data.regularChart?.intervalSeconds)>0),
        _estimatedVwap:!model.candle,chartSettings,visN:view.visN||{},
        chartStyle,followEnd:view.followEnd??true,winStart:view.winStart??null,
        _chartWidth:Math.max(220,Math.round(width)),_chartHeight:Math.max(180,Math.round(height))};
      if(view.anchor&&!view.followEnd){view.winStart=viewport.restoreAnchor(model.bars,view.anchor,{visible:view.visible||1});view.anchor=null;}
      const p=engine.computePlot(view);view.plot=p;
      if(hover!=null)hover=Math.max(0,Math.min(p.n-1,hover));
      dialog.querySelector('[data-chart-style="line"]').textContent=model.candle||view._intervalUnknown?'收盘线':'分时线';
      dialog.querySelectorAll('[data-chart-style]').forEach(button=>{
        const candle=button.dataset.chartStyle==='candle';button.disabled=candle&&!p.candleAvailable;
        button.setAttribute('aria-pressed',String(button.dataset.chartStyle===(p.candle?'candle':'line')));
        button.title=button.disabled?p.candleUnavailableReason||'当前来源只提供价格点，无法绘制真实高低影线':'';
      });
      for(const c of [cv,drawingCanvas,cursor]){c.width=Math.round(p.W*dpr);c.height=Math.round(p.H*dpr);c.style.width=p.W+'px';c.style.height=p.H+'px';}
      p.ctx=cv.getContext('2d');p.ctx.setTransform(cv.width/p.W,0,0,cv.height/p.H,0,0);
      engine.drawPlot(view,p,hover);paintDrawings();paintCursor();
      dialog.querySelector('.chart-scale-note').textContent=p.scaleNotice||(p.scale==='percent'&&number(p.scaleBase)!=null?'0% = '+formatterFor(model.data).money(p.scaleBase)+'（可见首根收盘）':'');
      dialog.querySelector('.cd-range-state').textContent='可见 '+p.n+' / 已加载 '+p.all.length+' 根';
      dialog.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.range==='all'?view.fullSession===true:!view.fullSession&&view.visN?.[view.tf]===Number(b.dataset.range))));
      dialog.querySelector('.cd-chart-info').textContent=chartInfo(model,p.all.length);
    }
    function queueDraw(){if(drawFrame!=null)return;drawFrame=requestAnimationFrame(draw);}
    function renderSummary(){if(!current||!dialog)return;const d=current.d||{symbol:current.symbol};
      const money=formatterFor(d).money,change=number(d.change),pct=number(d.changePct),up=change==null?null:change>=0;
      dialog.querySelector('#chart-detail-title').textContent=(current.friendly?.textContent?.trim()||d.displayName||current.symbol)+' · '+current.symbol;
      dialog.querySelector('.cd-status').textContent='报价年龄 '+(window.PANEL_STATE?.formatQuoteAge(d.quoteAt??d.ts,clock.now())||'未知');
      dialog.querySelector('.cd-price').textContent=number(d.price)==null?'—':money(d.price);
      const changeEl=dialog.querySelector('.cd-change');changeEl.textContent=change==null||pct==null?'涨跌基准待核验':
        (up?'+':'')+money(change)+' ('+(up?'+':'')+pct.toFixed(2)+'%)';changeEl.style.color=up==null?'':up?UP:DOWN;
      const baseline=fmt.quoteBaseline(d,money);
      dialog.querySelector('.cd-baseline').textContent=baseline.text;
      const ext=d.priceSession==='PRE'?d.ext?.pre:d.priceSession==='POST'?d.ext?.post:null;
      dialog.querySelector('.cd-extension').textContent=ext?.price==null?'':
        (d.priceSession==='PRE'?'盘前':'盘后')+' '+money(ext.price)+' · '+
        (number(ext.change)==null||number(ext.changePct)==null?'基准待核验':(ext.change>=0?'+':'')+money(ext.change)+' ('+
          (ext.changePct>=0?'+':'')+ext.changePct.toFixed(2)+'%)');
      const facts=[['今开',d.open],[baseline.shortLabel,d.prevClose],['最高',d.dayHigh],['最低',d.dayLow],['成交量',d.volume]];
      dialog.querySelector('.cd-facts').textContent=facts.map(([label,v])=>label+' '+(number(v)==null?'—':label==='成交量'?fmt.fmtVol(v):money(v))).join('  ·  ');
    }
    function renderMarket(){if(!dialog||!current)return;
      const format=formatterFor(current.d||{});
      marketView.render(remote,{symbol:current.symbol,session:tapeSession,zone:zone(),money:format.money,
        formatKey:JSON.stringify([format.unit,format.money(1),current.d?.currency,current.d?.fxMap,current.d?.fxStale])});
    }
    function selectTapeSession(value){
      if(!current||!['auto','regular','pre','post'].includes(value))return Promise.resolve();
      tapeSession=value;dialog.querySelector('.cd-tape-session').value=value;resetRemote();
      return fetchDetail(tf==='fiveDay'?'5d':'1d');
    }
    function selectSide(side){dialog.querySelectorAll('[data-side]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.side===side)));marketView.selectSide(side);}
    function resetRemote(bookReason='DETAIL_LOADING',tapeReason='TAPE_LOADING'){
      marketModel.reset({session:tapeSession,bookReason,tapeReason});
    }
    function fetchDetail(range='1d'){
      return current?marketModel.read({symbol:current.symbol,range,session:tapeSession}):Promise.resolve();
    }
    function fetchFive(){
      if(!current||pageAway||!canPoll())return Promise.resolve();
      const selected=current,key=fiveKey(selected);
      if(chartJob?.key===key)return chartJob.promise;
      cancelChart();const controller=new AbortController(),epoch=chartEpoch;
      const job={key,controller,promise:null};chartJob=job;
      job.promise=(async()=>{try{
        const response=await network.request('five-day:'+selected.symbol,'/api/chart/detail?symbol='+encodeURIComponent(selected.symbol)+'&range=5d&sections=chart',{signal:controller.signal,cache:'no-store',replace:true});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const value=await response.json();if(epoch!==chartEpoch||controller.signal.aborted||current!==selected||fiveKey(selected)!==key)return;
        if(value.symbol!==selected.symbol||value.range!=='5d'||value.fiveDay?.currency!==selected.d.currency)throw new Error('五日数据身份不符');
        const next=value.fiveDay;
        if(next?.bars?.length){five=next;saveFive(selected,next);}else if(!five)five=next;
        else five={...five,stale:true,refreshing:false};
        if(tf==='fiveDay')queueDraw();
      }catch(error){if(epoch===chartEpoch&&!controller.signal.aborted&&current===selected){if(five)five={...five,stale:true,refreshing:false};if(tf==='fiveDay')queueDraw();}}
      finally{if(chartJob===job)chartJob=null;}})();return job.promise;
    }
    async function selectPeriod(value){if(!current)return;rememberView();tf=value;hover=null;drawingDraft=null;drag=null;
      const saved=currentViews[tf]||{...viewport.createView(),visN:{}};view={...saved,visN:{...saved.visN}};chartStyle=view.chartStyle;
      dialog.querySelector('[data-chart-style="line"]').textContent=tf==='intraday'||tf==='fiveDay'?'分时线':'收盘线';
      dialog.querySelectorAll('[data-tf]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tf===tf)));
      if(tf==='fiveDay'){fiveIdentityKey=fiveKey(current);five=cachedFive(current);queueDraw();void fetchDetail('5d');await fetchFive();return;}
      void fetchDetail('1d');
      if(tf!=='intraday'&&(!current.historyStore?.getSeries(tf)?.length||current.historyStore?.needsLoad?.(tf))){historyReadAt.set(tf,Date.now());const selected=current,job=current.historyStore?.load(tf);
        queueDraw();await job;if(current===selected&&tf===value)queueDraw();return;}
      if(tf!=='intraday')void refreshHistory();
      queueDraw();
    }
    async function refreshHistory(force=false){
      if(!current||pageAway||!canPoll()||tf==='intraday'||tf==='fiveDay')return;
      const selected=current,period=tf,store=selected.historyStore,entry=store?.getMeta?.(period),now=Date.now();
      if(!store?.load||entry?.status==='loading'||entry?.retryAt>now||!force&&now-(historyReadAt.get(period)??-Infinity)<60000)return;
      historyReadAt.set(period,now);
      const anchor=!view.followEnd?view.plot?.bars[0]?.periodStart:null,savedStart=view.winStart;
      const before=anchor?view.plot?.bars.at(-1)?.periodEndExclusive:undefined;
      const spec=window.PANEL_TIMEFRAMES.get(period),limit=before?Math.min(500,(view.plot?.vis||view.visN?.[period]||spec.visible)+spec.prewarm):undefined;
      const job=store.load(period,{before,limit});queueDraw();
      try{await job;}finally{
        if(current===selected&&tf===period){
          if(anchor&&!view.followEnd&&view.winStart===savedStart){const index=store.getSeries(period).findIndex(bar=>bar.periodStart===anchor);if(index>=0)view.winStart=index;}
          queueDraw();
        }
      }
    }
    const historyAnchors=new Map();
    function onHistoryChange(change){
      if(!current)return;const state=change.tf===tf?view:currentViews[change.tf];if(!state)return;
      if(change.phase==='before')historyAnchors.set(change.tf,viewport.captureAnchor(change.previous,state));
      else{
        const anchor=historyAnchors.get(change.tf);historyAnchors.delete(change.tf);
        if(anchor){state.winStart=viewport.restoreAnchor(change.bars,anchor,{visible:state.plot?.vis||state.visible||1});state.anchor=anchor;state.followEnd=false;
          if(change.tf===tf&&drag){drag.winStart=state.winStart;drag.start=drag.last||drag.start;}}
        if(change.tf===tf)queueDraw();
      }
    }
    function olderPage(){
      const spec=window.PANEL_TIMEFRAMES.get(tf),store=current?.historyStore,entry=store?.getMeta?.(tf),bars=store?.getSeries?.(tf)||[];
      const pagination=entry?.pagination,before=pagination?.before||bars[0]?.periodStart;
      return spec?.kind==='history'&&(pagination?pagination.hasMore:entry?.meta?.hasMore)===true&&/^\d{4}-\d{2}-\d{2}$/.test(before||'')&&store?.load?
        {store,entry,before,period:tf,bars}:null;
    }
    function updateOlderButton(){
      if(!dialog)return;const page=olderPage(),button=dialog.querySelector('[data-action="older"]');
      button.hidden=!page;button.disabled=!!page&&(!!olderJob||page.entry.status==='loading'||page.entry.retryAt>Date.now());
      button.textContent=olderJob?'加载中…':'加载更早';
      const history=tf!=='intraday'&&tf!=='fiveDay',entry=current?.historyStore?.getMeta?.(tf);
      dialog.querySelector('.cd-history-state').textContent=olderJob?'正在读取更早历史':page?.entry.retryAt>Date.now()?'来源冷却中':
        history&&(entry?.pagination?entry.pagination.hasMore:entry?.meta?.hasMore)===false?'已到来源历史起点':page&&['error','stale'].includes(page.entry.status)?'旧图可用，可重试更早历史':'';
    }
    async function loadOlder({manual=false}={}){
      const page=olderPage();if(!page||olderJob||page.entry.status==='loading'||page.entry.retryAt>Date.now())return;
      const key=JSON.stringify([current.symbol,page.period,page.before]);
      if(!manual&&Date.now()-(olderAttempts.get(key)||0)<30000)return;
      olderAttempts.set(key,Date.now());while(olderAttempts.size>150)olderAttempts.delete(olderAttempts.keys().next().value);
      const selected=current,state=view,job={key},visible=state.plot?.vis||1;
      // Pin the current date even when this is the first page and it still fits
      // in the viewport. Loading history must not silently follow a new end.
      const beforeState={...state,followEnd:false,winStart:state.winStart??state.plot?.a??0};
      const anchor=viewport.captureAnchor(page.bars,beforeState);state.followEnd=false;
      state.visN={...state.visN,[page.period]:visible};
      olderJob=job;updateOlderButton();
      try{
        await page.store.load(page.period,{before:page.before});
        if(current!==selected)return;
        if(!historyUnsubscribe&&anchor){const target=tf===page.period?view:currentViews[page.period];
          if(target)target.winStart=viewport.restoreAnchor(page.store.getSeries(page.period),anchor,{visible});
          if(tf===page.period&&drag){drag.winStart=view.winStart;drag.start=drag.last||drag.start;}}
      }finally{if(olderJob===job){olderJob=null;if(current===selected){updateOlderButton();queueDraw();}}}
    }
    function zoom(kind,e){const p=view.plot;if(!p?.n)return;let vis=p.vis;
      vis=viewport.zoomCount(vis,kind,p.all.length);
      if(!view.visN)view.visN={};view.visN[view.tf]=vis;view.fullSession=false;
      if(e){const anchor=p.a+nearest(p,local(e,p).x);view.winStart=Math.max(0,Math.min(p.all.length-vis,Math.round(anchor-(anchor-p.a)*vis/p.vis)));view.followEnd=false;}
      queueDraw();}
    function action(value){if(value==='older'){void loadOlder({manual:true});return;}if(value==='rotate'){manualRotate=!dialog.classList.contains('is-rotated');layout();return;}
      if(value==='side'){sideOpen=!sideOpen;renderSide();queueDraw();return;}
      if(value==='fullscreen'){
        const operation=document.fullscreenElement===dialog?document.exitFullscreen?.():dialog.requestFullscreen?.();
        Promise.resolve(operation).then(layout).catch(()=>{dialog.querySelector('.cd-draw-state').textContent='浏览器未允许全屏，可使用横向显示';layout();});return;
      }
      if(value==='in'||value==='out'){zoom(value);return;}
      if(value==='fit'){view.visN[view.tf]=view.plot?.all?.length||1;view.followEnd=true;view.winStart=null;view.fullSession=true;queueDraw();return;}
      if(value==='latest'){view.followEnd=true;view.winStart=null;view.fullSession=false;queueDraw();return;}
      if(value==='shot'){const canvas=dialog.querySelector('.cd-canvas'),cursor=dialog.querySelector('.cd-cursor'),out=make('canvas');
        out.width=canvas.width;out.height=canvas.height;const c=out.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,out.width,out.height);
        c.drawImage(canvas,0,0);c.drawImage(dialog.querySelector('.cd-drawing-layer'),0,0);c.drawImage(cursor,0,0);const a=make('a');a.href=out.toDataURL('image/png');
        a.download=current.symbol+'_'+tf+'_regular.png';a.click();}
    }
    function layout(){if(!dialog?.open)return;const vp=window.visualViewport;
      const w=vp?.width||window.innerWidth,h=vp?.height||window.innerHeight;
      dialog.style.setProperty('--cd-vw',w+'px');dialog.style.setProperty('--cd-vh',h+'px');
      dialog.style.setProperty('--cd-vv-top',(vp?.offsetTop||0)+'px');
      dialog.style.setProperty('--cd-vv-left',(vp?.offsetLeft||0)+'px');
      const rotate=manualRotate===true;
      dialog.classList.toggle('is-rotated',rotate);dialog.querySelector('[data-action="rotate"]').textContent=rotate?'恢复竖向':'横向显示';
      dialog.querySelector('[data-action="rotate"]').setAttribute('aria-pressed',String(rotate));
      const fullscreen=document.fullscreenElement===dialog,button=dialog.querySelector('[data-action="fullscreen"]');
      button.textContent=fullscreen?'退出全屏':'全屏';button.setAttribute('aria-pressed',String(fullscreen));button.hidden=!dialog.requestFullscreen;
      queueDraw();
    }
    function renderSide(){dialog.classList.toggle('is-side-collapsed',!sideOpen);dialog.querySelector('.cd-side').hidden=!sideOpen;
      const button=dialog.querySelector('[data-action="side"]');button.setAttribute('aria-expanded',String(sideOpen));button.textContent=sideOpen?'收起盘口':'盘口 / 逐笔';}
    function syncVisibility(){
      if(!current)return;
      const allowed=!pageAway&&canPoll();if(pollingAllowed===allowed)return;pollingAllowed=allowed;
      clearInterval(poll);poll=null;
      if(!allowed){ageTicker.stop();cancelChart();marketModel.cancel();resetRemote('DETAIL_PAUSED','PUBLIC_TRADES_UNAVAILABLE');return;}
      ageTicker.start();
      void fetchDetail(tf==='fiveDay'?'5d':'1d');
      if(tf==='fiveDay')void fetchFive();
      void refreshHistory(true);
      poll=setInterval(()=>{if(current){void fetchDetail(tf==='fiveDay'?'5d':'1d');if(tf==='fiveDay')void fetchFive();renderSummary();void refreshHistory();}},10000);
    }
    const onPageHide=()=>{pageAway=true;syncVisibility();},onPageShow=()=>{pageAway=false;syncVisibility();};
    function close(fromPop=false){if(!current)return;
      rememberView();ageTicker.stop();historyUnsubscribe?.();historyUnsubscribe=null;olderJob=null;
      settingsBinding?.destroy();settingsBinding=null;drawingDraft=null;drawingTool=null;drawingIdentity=null;
      cancelChart();marketModel.cancel();marketView.reset();current=null;clearInterval(poll);poll=null;
      resizeObserver?.disconnect();resizeObserver=null;
      window.removeEventListener('resize',layout);window.visualViewport?.removeEventListener('resize',layout);
      window.visualViewport?.removeEventListener('scroll',layout);
      document.removeEventListener('fullscreenchange',layout);
      document.removeEventListener('visibilitychange',syncVisibility);window.removeEventListener('pagehide',onPageHide);window.removeEventListener('pageshow',onPageShow);
      if(drawFrame!=null)cancelAnimationFrame(drawFrame);drawFrame=null;
      modal.close(fromPop);
      remote=null;five=null;fiveIdentityKey=null;view={};hover=null;drag=null;lastTap=null;manualRotate=null;pollingAllowed=null;historyReadAt.clear();historyAnchors.clear();
    }
    function open(q,opener){ensure();if(current)close();current=q;
      const key=JSON.stringify([q.symbol,q.d?.currency]);currentViews=savedViews.get(key)||{};savedViews.delete(key);savedViews.set(key,currentViews);
      while(savedViews.size>50)savedViews.delete(savedViews.keys().next().value);
      tf='intraday';tapeSession='auto';remote=null;fiveIdentityKey=fiveKey(q);five=cachedFive(q);const saved=currentViews.intraday||{...viewport.createView(),visN:{}};view={...saved,visN:{...saved.visN}};chartStyle=view.chartStyle;hover=null;pageAway=false;pollingAllowed=null;
      chartSettings=workspace()?.loadSettings()||{scale:'linear',volume:true,studies:{sma5:true,sma10:true,sma20:true,ema20:false,boll20:false,rsi14:false}};
      settingsBinding=workspace()?.bindSettings(dialog.querySelector('.cd-settings'),{settings:chartSettings,onChange:value=>{chartSettings=value;view.chartSettings=value;queueDraw();}})||null;
      drawingStore||=drawings()?.createDrawingStore({keyPrefix:'qqqsp:detail-drawings'});
      dialog.querySelector('.cd-draw-tools').hidden=!drawings();selectDrawingTool(null);renderSide();
      dialog.querySelector('.cd-tape-session').value='auto';resetRemote();selectSide('tape');
      modal.open(dialog,opener||q.cv);
      historyUnsubscribe=q.historyStore?.subscribe?.(onHistoryChange)||null;
      window.addEventListener('resize',layout);
      window.visualViewport?.addEventListener('resize',layout);window.visualViewport?.addEventListener('scroll',layout);
      document.addEventListener('fullscreenchange',layout);
      document.addEventListener('visibilitychange',syncVisibility);window.addEventListener('pagehide',onPageHide);window.addEventListener('pageshow',onPageShow);
      resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>queueDraw()):null;
      resizeObserver?.observe(dialog.querySelector('.cd-plot'));
      renderSummary();void selectPeriod('intraday');layout();dialog.querySelector('.cd-close').focus();
      syncVisibility();
    }
    function mount(q){const button=q.el.querySelector('.chart-expand'),cv=q.cv;
      button?.addEventListener('click',()=>open(q,button));cv?.addEventListener('dblclick',e=>{e.preventDefault();open(q,cv);});
      cv?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();open(q,cv);}});
      let tap=null,down=null;cv?.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse')down={x:e.clientX,y:e.clientY,at:Date.now()};});
      cv?.addEventListener('pointerup',e=>{if(e.pointerType==='mouse'||!down)return;
        const distance=Math.hypot(e.clientX-down.x,e.clientY-down.y),duration=Date.now()-down.at;down=null;
        if(distance>12||duration>400){tap=null;return;}
        if(tap&&Date.now()-tap.at<300&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<12){tap=null;open(q,cv);}
        else tap={x:e.clientX,y:e.clientY,at:Date.now()};
      });
    }
    return Object.freeze({mount,update:q=>{if(current===q){
        if(fiveKey(q)!==fiveIdentityKey){fiveIdentityKey=fiveKey(q);five=cachedFive(q);drawingDraft=null;cancelChart();if(tf==='fiveDay')void fetchFive();}
        renderSummary();renderMarket();queueDraw();}},
      remove:q=>{if(current===q)close();for(const key of savedViews.keys())if(JSON.parse(key)[0]===q.symbol)savedViews.delete(key);},close,syncVisibility});
  };
  window.PANEL_CHART_DETAIL=Object.freeze({createChartDetailView});
})();
