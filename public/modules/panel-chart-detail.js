(() => {
  const createChartDetailView=({document,formatterFor,UP,DOWN})=>{
    const engine=window.PANEL_CHART_ENGINE.createChartEngine({UP,DOWN,
      fmtDate:window.PANEL_FORMAT.fmtDate,formatterFor,maSeries:window.PANEL_CHART.maSeries});
    const fmt=window.PANEL_FORMAT,periods=[['intraday','一日'],['fiveDay','五日'],['daily30','日K'],['weekly','周K'],['monthly','月K'],['yearly','年K']];
    let dialog=null,current=null,tf='intraday',five=null,remote=null,requestId=0,fetchAbort=null,poll=null,
      drawFrame=null,resizeObserver=null,scrollStyle='',focusReturn=null,openedHistory=false,manualRotate=null,
      hover=null,drag=null,lastTap=null,view={};
    const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
    const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const zone=()=>current?.d?.regularChart?.exchangeZone||'UTC';
    const zoneLabel=()=>zone()==='America/New_York'?'美东':zone()==='Asia/Shanghai'?'北京时间':zone();
    const time=(ms,selectedZone=zone())=>{
      if(!number(ms))return '时间未提供';
      try{return new Intl.DateTimeFormat('zh-CN',{timeZone:selectedZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));}
      catch{return new Date(ms).toISOString().slice(0,16);}
    };
    const reason={SOURCE_HAS_NO_BOOK:'来源未提供盘口',INSTRUMENT_TYPE:'该品种无盘口',RETAINED_BOOK:'盘口已过期',
      NO_RECEIVED_TRADES:'该时段尚未收到逐笔',TRADE_STREAM_NOT_CONFIGURED:'逐笔源未配置',
      FIVE_DAY_SOURCE_GAPS:'五日历史覆盖不足',FIVE_DAY_SOURCE_UNAVAILABLE:'五日历史来源不可用',
      FIVE_DAY_SESSION_OPEN:'当日常规时段尚未收盘',
      SOURCE_COOLDOWN:'五日历史来源限流冷却中',REGULAR_HISTORY_NOT_AVAILABLE:'常规历史暂不可用'};
    function ensure(){
      if(dialog)return;
      dialog=make('dialog','chart-detail-dialog');dialog.setAttribute('aria-labelledby','chart-detail-title');
      dialog.innerHTML=`<div class="chart-detail-shell">
        <header class="chart-detail-head"><div class="chart-detail-identity"><strong id="chart-detail-title">证券行情</strong><span class="cd-status"></span></div>
        <div class="cd-quote"><strong class="cd-price">—</strong><span class="cd-change">—</span><small class="cd-baseline"></small><small class="cd-extension"></small></div>
        <div class="cd-facts"></div><button type="button" class="cd-close" aria-label="关闭行情详情">×</button></header>
        <div class="chart-detail-body"><main class="cd-main"><div class="cd-chart-info" role="status"></div>
          <div class="cd-plot"><canvas class="cd-canvas" tabindex="0" aria-label="详情行情图，左右键浏览数据点"></canvas>
            <canvas class="cd-cursor" aria-hidden="true"></canvas></div><div class="cd-point" role="status"></div></main>
          <aside class="cd-side"><div class="cd-book"><h3>买卖盘口 · 一档</h3><div class="cd-book-status"></div>
            <div class="cd-book-row"><span>卖一</span><b class="cd-ask">—</b><span class="cd-ask-size">—</span></div>
            <div class="cd-book-row"><span>买一</span><b class="cd-bid">—</b><span class="cd-bid-size">—</span></div><small class="cd-book-meta"></small></div>
            <div class="cd-tape"><div class="cd-side-tabs"><button type="button" data-side="tape" aria-pressed="true">逐笔明细</button>
              <button type="button" data-side="stats" aria-pressed="false">成交统计</button></div>
              <div class="cd-tape-status"></div><div class="cd-tape-list"></div><div class="cd-tape-stats" hidden></div></div></aside></div>
        <footer class="chart-detail-foot"><nav class="cd-periods" aria-label="行情周期"></nav>
          <div class="cd-tools"><button type="button" data-action="in" aria-label="放大图表">＋</button><button type="button" data-action="out" aria-label="缩小图表">－</button>
          <button type="button" data-action="fit">全览</button><button type="button" data-action="latest">最新</button>
          <button type="button" data-action="shot">导出PNG</button><button type="button" data-action="rotate">横向显示</button></div></footer></div>`;
      const nav=dialog.querySelector('.cd-periods');
      for(const [key,label] of periods){const b=make('button','',label);b.type='button';b.dataset.tf=key;nav.appendChild(b);}
      document.body.appendChild(dialog);
      dialog.querySelector('.cd-close').addEventListener('click',()=>close());
      dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
      dialog.querySelectorAll('[data-tf]').forEach(b=>b.addEventListener('click',()=>void selectPeriod(b.dataset.tf)));
      dialog.querySelectorAll('[data-side]').forEach(b=>b.addEventListener('click',()=>selectSide(b.dataset.side)));
      dialog.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.action)));
      const cv=dialog.querySelector('.cd-canvas');
      cv.addEventListener('pointermove',e=>pointerMove(e));cv.addEventListener('pointerleave',()=>{if(!drag){hover=null;paintCursor();}});
      cv.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;
        const p=view.plot;drag={id:e.pointerId,start:local(e,p),winStart:view.winStart??0,moved:false};
        try{cv.setPointerCapture(e.pointerId);}catch{}
      });
      cv.addEventListener('pointerup',e=>{if(!drag||e.pointerId!==drag.id)return;
        const point=local(e,view.plot),travel=Math.hypot(point.x-drag.start.x,point.y-drag.start.y),isTap=travel<12;
        drag=null;if(isTap){const now=Date.now();if(lastTap&&now-lastTap.at<300&&
          Math.hypot(lastTap.x-point.x,lastTap.y-point.y)<12){lastTap=null;view.followEnd=true;queueDraw();}
          else lastTap={at:now,x:point.x,y:point.y};}
      });
      cv.addEventListener('pointercancel',()=>{drag=null;});
      cv.addEventListener('wheel',e=>{if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();zoom(e.deltaY>0?'out':'in',e);},{passive:false});
      cv.addEventListener('keydown',e=>{const p=view.plot;if(!p?.n)return;
        if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();hover=e.key==='Home'?0:e.key==='End'?p.n-1:
          Math.max(0,Math.min(p.n-1,(hover??p.n-1)+(e.key==='ArrowLeft'?-1:1)));paintCursor();}
        if(e.key==='Escape'){e.preventDefault();close();}
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
      if(drag&&drag.id===e.pointerId){const dx=point.x-drag.start.x;
        if(Math.abs(dx)>3)drag.moved=true;
        if(drag.moved){const max=Math.max(0,p.all.length-p.vis),step=p.timeline?Math.max(1,p.W/p.vis):p.slot;
          const next=Math.max(0,Math.min(max,Math.round(drag.winStart-dx/step)));
          if(next!==view.winStart){view.winStart=next;view.followEnd=next>=max;queueDraw();}}return;}
      const idx=nearest(p,point.x);if(idx!==hover){hover=idx;paintCursor();}
    }
    function paintCursor(){const p=view.plot,cursor=dialog?.querySelector('.cd-cursor');if(!p||!cursor)return;
      const c=cursor.getContext('2d');c.setTransform(cursor.width/p.W,0,0,cursor.height/p.H,0,0);
      engine.drawCursor(view,p,hover,c);
      const b=p.bars[hover??p.n-1];if(!b)return;
      const money=formatterFor(view._chartData).money;
      dialog.querySelector('.cd-point').textContent=time(b.t*1000)+' '+zoneLabel()+' · '+(p.candle?
        '开 '+money(b.o)+' 高 '+money(b.h)+' 低 '+money(b.l)+' 收 '+money(b.c):'价 '+money(b.c))+
        ' · 区间量 '+(number(b.v)==null?'暂缺':fmt.fmtVol(b.v)+' 股')+(view._vwapSeries?.[p.a+(hover??p.n-1)]!=null?
        ' · 估算均价 '+money(view._vwapSeries[p.a+(hover??p.n-1)]):'');
    }
    function chartModel(){
      const q=current;if(!q?.d)return null;
      const candle=tf!=='intraday'&&tf!=='fiveDay';
      const fiveChart=five&&{...q.d.regularChart,bars:five.bars,regularSessions:five.regularSessions,
        previousCloseReference:five.previousCloseReference,tradeDate:five.tradeDates?.at(-1),
        source:five.source,volumeUnit:five.volumeUnit};
      const data=tf==='fiveDay'?{...q.d,regularChart:fiveChart,intradayLiveStatus:'unavailable'}:q.d;
      const bars=tf==='fiveDay'?five?.bars||[]:tf==='intraday'?q.d.regularChart?.bars||[]:q.historyStore?.getSeries(tf)||[];
      return {data,bars,candle};
    }
    function draw(){drawFrame=null;if(!current||!dialog?.open)return;
      const model=chartModel(),cv=dialog.querySelector('.cd-canvas'),cursor=dialog.querySelector('.cd-cursor');
      if(!model||!model.bars.length){view.plot=null;for(const c of [cv,cursor])c.getContext('2d').clearRect(0,0,c.width,c.height);
        dialog.querySelector('.cd-point').textContent='该周期历史暂不可用';return;}
      const plotBox=dialog.querySelector('.cd-plot').getBoundingClientRect();
      const rotated=dialog.classList.contains('is-rotated');
      const width=rotated?plotBox.height:plotBox.width,height=rotated?plotBox.width:plotBox.height;
      const dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
      view={...view,d:model.data,_chartData:model.data,tf:tf==='fiveDay'?'intraday':tf,cv,
        historyStore:current.historyStore,_displayIntraday:model.candle?null:model.bars,
        _sampled:false,_fiveDay:tf==='fiveDay',_detail:true,_displayZone:zone(),_zoneLabel:zoneLabel(),
        _estimatedVwap:!model.candle,maEnabled:{5:true,10:true,20:true},visN:view.visN||{},
        followEnd:view.followEnd??true,winStart:view.winStart??null,
        _chartWidth:Math.max(300,Math.round(width)),_chartHeight:Math.max(210,Math.round(height))};
      const p=engine.computePlot(view);view.plot=p;
      for(const c of [cv,cursor]){c.width=Math.round(p.W*dpr);c.height=Math.round(p.H*dpr);c.style.width=p.W+'px';c.style.height=p.H+'px';}
      p.ctx=cv.getContext('2d');p.ctx.setTransform(cv.width/p.W,0,0,cv.height/p.H,0,0);
      engine.drawPlot(view,p,hover);paintCursor();
      const chart=tf==='fiveDay'?five:current.d.regularChart;
      const label=tf==='fiveDay'?'五日 '+(five?.coveredDays||0)+'/5 个交易日':
        tf==='intraday'?'一日 '+(chart?.tradeDate||'日期待核验'):'交易所历史K线';
      dialog.querySelector('.cd-chart-info').textContent=label+' · '+p.all.length+' 个价格点 · '+(chart?.source||'来源待核验')+
        (chart?.resolution?' '+chart.resolution:'')+
        (chart?.coverage==='single-exchange'?' · 单交易所覆盖':chart?.coverage==='us-sip'?' · SIP 汇总覆盖':'')+
        (chart?.adjustment==='source-default-unverified'?' · 价格复权口径待核验':'')+
        (chart?.reason?' · '+(reason[chart.reason]||chart.reason):'')+
        (chart?.volumeQuality?.status==='missing'?' · 区间成交量暂缺':'')+
        (!model.candle?(view._vwapSeries?.some(v=>v!=null)?' · 橙线：OHLCV 估算均价':' · 均价暂缺'):' · 橙线：MA5');
    }
    function queueDraw(){if(drawFrame!=null)return;drawFrame=requestAnimationFrame(draw);}
    function renderSummary(){if(!current||!dialog)return;const d=current.d;if(!d)return;
      const money=formatterFor(d).money,change=number(d.change),pct=number(d.changePct),up=change==null?null:change>=0;
      dialog.querySelector('#chart-detail-title').textContent=(current.friendly?.textContent?.trim()||d.displayName||current.symbol)+' · '+current.symbol;
      dialog.querySelector('.cd-status').textContent=(d.priceSession||d.marketState||'状态待核验')+' · '+time(d.quoteAt)+' '+zoneLabel()+' · 图表 '+(d.regularChart?.tradeDate||'日期待核验');
      dialog.querySelector('.cd-price').textContent=number(d.price)==null?'—':money(d.price);
      const changeEl=dialog.querySelector('.cd-change');changeEl.textContent=change==null||pct==null?'涨跌基准待核验':
        (up?'+':'')+money(change)+' ('+(up?'+':'')+pct.toFixed(2)+'%)';changeEl.style.color=up==null?'':up?UP:DOWN;
      dialog.querySelector('.cd-baseline').textContent='较上一交易日常规收盘 '+
        (d.previousCloseTradeDate||'日期待核验')+' · '+(number(d.prevClose)==null?'基准待核验':money(d.prevClose));
      const ext=d.priceSession==='PRE'?d.ext?.pre:d.priceSession==='POST'?d.ext?.post:null;
      dialog.querySelector('.cd-extension').textContent=ext?.price==null?'':
        (d.priceSession==='PRE'?'盘前':'盘后')+' '+money(ext.price)+' · '+
        (number(ext.change)==null?'基准待核验':(ext.change>=0?'+':'')+money(ext.change)+' ('+
          (ext.changePct>=0?'+':'')+ext.changePct.toFixed(2)+'%)');
      const facts=[['今开',d.open],['昨收',d.prevClose],['最高',d.dayHigh],['最低',d.dayLow],['成交量',d.volume],['成交额',null]];
      dialog.querySelector('.cd-facts').textContent=facts.map(([label,v])=>label+' '+(number(v)==null?'—':label==='成交量'?fmt.fmtVol(v):money(v))).join('  ·  ');
    }
    function renderBook(){if(!dialog)return;const b=remote?.book,money=formatterFor(current?.d||{}).money;
      dialog.querySelector('.cd-book-status').textContent=b?.status==='ready'?'实时盘口':b?.reason?reason[b.reason]||b.reason:'盘口暂不可用';
      dialog.querySelector('.cd-ask').textContent=number(b?.ask?.price)==null?'—':money(b.ask.price);
      dialog.querySelector('.cd-bid').textContent=number(b?.bid?.price)==null?'—':money(b.bid.price);
      const size=b?.sizeUnit==='shares'?'股':b?.sizeUnit==='lots'?'手':'单位待核验';
      dialog.querySelector('.cd-ask-size').textContent=number(b?.ask?.size)==null?'—':fmt.fmtVol(b.ask.size)+' '+size;
      dialog.querySelector('.cd-bid-size').textContent=number(b?.bid?.size)==null?'—':fmt.fmtVol(b.bid.size)+' '+size;
      dialog.querySelector('.cd-book-meta').textContent=b?.source?
        b.source+' · '+(b.coverage||'覆盖待核验')+' · '+time(b.asOf)+' '+zoneLabel()+(b.stale?' · 已过期':''):
        '无可用盘口来源；成交价不代替买卖报价';
    }
    function renderTape(){if(!dialog)return;const tape=remote?.tape,events=tape?.events||[],list=dialog.querySelector('.cd-tape-list'),stats=dialog.querySelector('.cd-tape-stats');
      const stream=tape?.stream,streamNote=stream?.state&&stream.state!=='streaming'?
        ' · 行情流 '+stream.state+(stream.errorCode?' ('+stream.errorCode+')':''):'',
        duplicateNote=events.some(e=>e.quality)?' · 来源无唯一成交ID，重连可能重复':'';
      dialog.querySelector('.cd-tape-status').textContent=(events.length?'已接收成交片段 · '+events.length+' 笔 · '+
        time(tape.coverage?.firstAt)+' 至 '+time(tape.coverage?.lastAt)+' '+zoneLabel():reason[tape?.reason]||'逐笔暂无数据')+
        streamNote+duplicateNote;
      list.replaceChildren();for(const e of events.slice(-200).reverse()){
        const row=make('div','cd-trade-row');row.textContent=time(e.at)+' · '+formatterFor(current?.d||{}).money(e.price)+
        ' · '+fmt.fmtVol(e.size)+' 股 · '+(e.exchange||e.source)+' · 方向未知'+
        (e.reportState!=='reported'?' · '+(e.reportState==='corrected'?'已更正，原成交量不计入统计':'已撤销'):'' );list.appendChild(row);
      }
      if(!events.length)list.textContent='当前目标交易日常规时段无已接收成交；不会用报价采样补造逐笔。';
      const valid=events.filter(e=>e.reportState==='reported'),total=valid.reduce((sum,e)=>sum+(number(e.size)||0),0),
        prices=valid.map(e=>e.price).filter(v=>number(v)!=null);
      stats.textContent=valid.length?'已接收片段 '+valid.length+' 笔 · 片段成交量 '+fmt.fmtVol(total)+' 股 · '+
        '片段最低 '+formatterFor(current?.d||{}).money(Math.min(...prices))+' / 最高 '+
        formatterFor(current?.d||{}).money(Math.max(...prices))+'。不是全天成交统计；无主动买卖方向。':
        '当前无可验证成交事件，成交统计暂缺。';
      if(valid.length){const buckets=new Map();for(const e of valid){const start=Math.floor(e.at/1800000)*1800000;
        buckets.set(start,(buckets.get(start)||0)+e.size);}
        stats.textContent+=' 时间分布（已接收片段）：'+[...buckets].sort((a,b)=>a[0]-b[0])
          .map(([at,size])=>time(at)+' '+fmt.fmtVol(size)+' 股').join('；');}
    }
    function selectSide(side){dialog.querySelectorAll('[data-side]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.side===side)));
      dialog.querySelector('.cd-tape-list').hidden=side!=='tape';dialog.querySelector('.cd-tape-stats').hidden=side!=='stats';}
    async function fetchDetail(range='1d'){
      fetchAbort?.abort();const controller=fetchAbort=new AbortController(),id=++requestId;
      try{const response=await fetch('/api/chart/detail?symbol='+encodeURIComponent(current.symbol)+'&range='+range,
        {signal:controller.signal,cache:'no-store'});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const value=await response.json();if(id!==requestId||!current||controller.signal.aborted)return;
        remote=value;if(range==='5d')five=value.fiveDay;
        renderBook();renderTape();queueDraw();
      }catch(error){if(controller.signal.aborted)return;
        dialog.querySelector('.cd-tape-status').textContent='详情接口暂不可用：'+error.message;
        if(range==='5d'){five=null;queueDraw();}
      }
    }
    async function selectPeriod(value){if(!current)return;tf=value;hover=null;view={visN:{},followEnd:true,winStart:null};
      dialog.querySelectorAll('[data-tf]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tf===tf)));
      if(tf==='fiveDay'){five=null;queueDraw();await fetchDetail('5d');return;}
      if(tf!=='intraday'&&!current.historyStore?.getSeries(tf)?.length){const selected=current,job=current.historyStore?.load(tf);
        queueDraw();await job;if(current===selected&&tf===value)queueDraw();return;}
      queueDraw();
    }
    function zoom(kind,e){const p=view.plot;if(!p?.n)return;let vis=view.visN?.[view.tf]||p.vis;
      vis=kind==='in'?Math.max(5,Math.round(vis/1.4)):Math.min(p.all.length,Math.round(vis*1.4));
      if(!view.visN)view.visN={};view.visN[view.tf]=vis;
      if(e){const anchor=p.a+nearest(p,local(e,p).x);view.winStart=Math.max(0,Math.min(p.all.length-vis,Math.round(anchor-(anchor-p.a)*vis/p.vis)));view.followEnd=false;}
      queueDraw();}
    function action(value){if(value==='rotate'){manualRotate=!dialog.classList.contains('is-rotated');layout();return;}
      if(value==='in'||value==='out'){zoom(value);return;}
      if(value==='fit'){view.visN[view.tf]=view.plot?.all?.length||1;view.followEnd=true;view.winStart=null;queueDraw();return;}
      if(value==='latest'){view.followEnd=true;view.winStart=null;queueDraw();return;}
      if(value==='shot'){const canvas=dialog.querySelector('.cd-canvas'),cursor=dialog.querySelector('.cd-cursor'),out=make('canvas');
        out.width=canvas.width;out.height=canvas.height;const c=out.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,out.width,out.height);
        c.drawImage(canvas,0,0);c.drawImage(cursor,0,0);const a=make('a');a.href=out.toDataURL('image/png');
        a.download=current.symbol+'_'+tf+'_regular.png';a.click();}
    }
    function layout(){if(!dialog?.open)return;const vp=window.visualViewport;
      const w=vp?.width||window.innerWidth,h=vp?.height||window.innerHeight;
      dialog.style.setProperty('--cd-vw',w+'px');dialog.style.setProperty('--cd-vh',h+'px');
      dialog.style.setProperty('--cd-vv-top',(vp?.offsetTop||0)+'px');
      dialog.style.setProperty('--cd-vv-left',(vp?.offsetLeft||0)+'px');
      const rotate=manualRotate===null?w<h&&w<700:manualRotate;
      dialog.classList.toggle('is-rotated',rotate);dialog.querySelector('[data-action="rotate"]').textContent=rotate?'恢复竖向':'横向显示';
      queueDraw();
    }
    function onPop(){if(current)close(true);}
    function close(fromPop=false){if(!current)return;
      current=null;requestId++;fetchAbort?.abort();fetchAbort=null;clearInterval(poll);poll=null;
      resizeObserver?.disconnect();resizeObserver=null;
      window.removeEventListener('resize',layout);window.visualViewport?.removeEventListener('resize',layout);
      window.visualViewport?.removeEventListener('scroll',layout);
      document.removeEventListener('fullscreenchange',layout);window.removeEventListener('popstate',onPop);
      if(drawFrame!=null)cancelAnimationFrame(drawFrame);drawFrame=null;
      if(document.fullscreenElement===dialog)void document.exitFullscreen?.().catch(()=>{});
      try{window.screen?.orientation?.unlock?.();}catch{}
      dialog.close();document.body.style.overflow=scrollStyle;focusReturn?.focus?.();focusReturn=null;
      if(openedHistory&&!fromPop)history.back();openedHistory=false;
      remote=null;five=null;view={};hover=null;drag=null;lastTap=null;manualRotate=null;
    }
    function open(q,opener){ensure();if(current)close();current=q;focusReturn=opener||q.cv;
      scrollStyle=document.body.style.overflow;document.body.style.overflow='hidden';
      tf='intraday';remote=null;five=null;view={visN:{},followEnd:true,winStart:null};hover=null;
      dialog.showModal();history.pushState({chartDetail:true},'',location.href);openedHistory=true;
      window.addEventListener('popstate',onPop);window.addEventListener('resize',layout);
      window.visualViewport?.addEventListener('resize',layout);window.visualViewport?.addEventListener('scroll',layout);
      document.addEventListener('fullscreenchange',layout);
      resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>queueDraw()):null;
      resizeObserver?.observe(dialog.querySelector('.cd-plot'));
      renderSummary();void selectPeriod('intraday');layout();dialog.querySelector('.cd-close').focus();
      void fetchDetail();poll=setInterval(()=>{if(current)void fetchDetail(tf==='fiveDay'?'5d':'1d');},10000);
      if(window.innerWidth<700&&dialog.requestFullscreen){
        void dialog.requestFullscreen().then(()=>window.screen?.orientation?.lock?.('landscape')).catch(()=>layout());
      }
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
    return Object.freeze({mount,update:q=>{if(current===q){renderSummary();queueDraw();}},
      remove:q=>{if(current===q)close();},close});
  };
  window.PANEL_CHART_DETAIL=Object.freeze({createChartDetailView});
})();
