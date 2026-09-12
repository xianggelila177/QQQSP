(() => {
  const createChartController = ({ document, formatterFor, formatKey, client, flash, UP, DOWN, dpr = 1 }) => {
    const { fmtDate, fmtVol } = window.PANEL_FORMAT;
    const pointTime=t=>fmtDate(t,true)+':'+String(new Date(t*1000).getUTCSeconds()).padStart(2,'0');
    const DPR = Math.min(2, Math.max(1, dpr));
    const engine = client.createChartEngine({ UP, DOWN, fmtDate, formatterFor, maSeries:client.maSeries });
    const arrays = new WeakMap(); let sequence=0;
    const seriesFor=(q,tf)=>{if(tf==='intraday'&&q._displayIntraday)return q._displayIntraday;const stored=tf!=='intraday'?q.historyStore?.getSeries(tf):null;return stored!=null?stored:q.d?.charts?.[tf] || (tf==='daily30' ? q.d?.charts?.daily : []) || [];};
    const idOf = value => { if(!arrays.has(value)) arrays.set(value,++sequence); return arrays.get(value); };
    const chartData = q => { const meta=q.historyStore?.getMeta(q.tf)?.meta; return meta ? {...q.d,currency:meta.currency||q.d.currency,instrumentType:meta.instrumentType||q.d.instrumentType} : q.d; };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for(const entry of entries) { const q=cards.get(entry.target); if(!q)continue; q.visible=entry.isIntersecting; if(q.visible && q._dirty)drawChart(q,true); }
    }, {rootMargin:'100px'}) : null;
    const cards=new Map();let historyRefreshTimer=null;
    const resizeQueue=new Set();let resizeFrame=null;
    function scheduleResize(q){resizeQueue.add(q);if(resizeFrame!=null)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;for(const card of resizeQueue)if(!card._unmounted){card._pointerRect=null;drawChart(card,true);}resizeQueue.clear();});}
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      for(const entry of entries) { const q=cards.get(entry.target); if(!q)continue; const width=entry.contentRect.width; if(width>0 && width!==q._chartWidth){q._chartWidth=width;scheduleResize(q);} }
    }) : null;
    function mount(q) {
      const el=q.el, sym=q.symbol;
      q._observe=window.PANEL_CHART_ENGINE.createObservationSeries?.();
      q.chartState=el.querySelector('.chart-state');q.chartRetry=el.querySelector('.chart-retry');q.chartModes=el.querySelector('.chart-modes');
      q._intradayMode='auto';
      el.querySelectorAll('[data-chart-mode]').forEach(b=>b.addEventListener('click',()=>{q._intradayMode=b.dataset.chartMode;q.followEnd=true;q.winStart=null;q.hoverIdx=null;drawChart(q,true);}));
      q.chartRetry?.addEventListener('click',async()=>{
        if(q.tf==='intraday'||q._unmounted)return;const tf=q.tf;const job=q.historyStore.load(tf);drawChart(q,true);await job;if(!q._unmounted&&q.tf===tf)drawChart(q,true);
      });
      q.views={}; q.visible=true; q._dirty=false; q._unmounted=false;
      q.historyStore=(window.PANEL_HISTORY_STORE && typeof window.fetch==='function') ? window.PANEL_HISTORY_STORE.createHistoryStore({symbol:sym}) : {
        getSeries:tf=>q.d?.charts?.[tf] || (tf==='daily30'?q.d?.charts?.daily:[]) || [], getRevision:()=>0,
        getMeta:tf=>({status:(q.d?.charts?.[tf]||[]).length?'ready':'unknown'}), load:async()=>{}, abort:()=>{}
      };
      const view=()=>q.views[q.tf] ||= {winStart:null,followEnd:true,hoverIdx:null,keyboardSelection:false};
      for(const key of ['winStart','followEnd','hoverIdx','keyboardSelection']) Object.defineProperty(q,key,{configurable:true,get:()=>view()[key],set:value=>{view()[key]=value;}});
      q.cursor=el.querySelector('.chart-cursor');
      q.cv.setAttribute('tabindex','0'); q.cv.setAttribute('aria-label',sym+' 行情图表，左右键选择历史点，Home 和 End 选择可见首尾');
      q.cv.setAttribute('aria-describedby','chart-point-'+sym);
      q.point=el.querySelector('.chart-point'); q.point.id='chart-point-'+sym; q.point.setAttribute('aria-live','off');
      q.refreshHistory=async()=>{
        if(q.historyPreparedAt&&Date.now()-q.historyPreparedAt<120000)return;
        if(q._unmounted||q.visible===false||document.hidden||q.tf==='intraday'||!q.d||q._loadingBefore)return;
        const tf=q.tf;
        if(q.historyStore.getMeta(tf)?.status==='loading')return;
        const savedView=q.views[tf],anchor=!q.followEnd?q.plot?.bars[0]?.periodStart:null;
        const before=anchor?q.plot?.bars.at(-1)?.periodEndExclusive:undefined;
        const limit=before?Math.min(500,(q.visN[tf]||window.PANEL_TIMEFRAMES?.get(tf)?.visible||60)+19):undefined;
        const job=q.historyStore.load(tf,{before,limit});drawChart(q,true);await job;
        if(q._unmounted)return;
        if(anchor&&savedView){const idx=seriesFor(q,tf).findIndex(b=>b.periodStart===anchor);if(idx>=0)savedView.winStart=idx;}
        if(q.tf===tf)drawChart(q,true);
      };
      if(!historyRefreshTimer)historyRefreshTimer=setInterval(()=>{for(const card of cards.values())void card.refreshHistory();},60000);

    q.tabs[0].classList.add('on');
    q.tabs.forEach((b, i) => b.setAttribute('aria-pressed', String(i === 0)));
    q.tabs.forEach(b => b.addEventListener('click', async () => {
      q.tf = b.dataset.tf; const tf=q.tf; q.tabs.forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',String(x===b));});
      const spec=window.PANEL_TIMEFRAMES?.get(tf) || {kind:tf==='intraday'?'quote':'history',visible:tf==='yearly'?20:60};
      let job;
      if(spec?.kind==='history' && (!q.historyStore.getSeries(tf).length||['error','stale'].includes(q.historyStore.getMeta(tf)?.status)))job=q.historyStore.load(tf);
      if(q.d)drawChart(q,true);
      if(job){await job;if(!q._unmounted&&q.tf===tf&&q.d)drawChart(q,true);}
    }));
    const met = el.querySelector('.meter');
    const sl = document.createElement('input'); sl.type = 'range'; sl.className = 'xslide'; sl.min = '0'; sl.max = '0'; sl.value = '0'; sl.hidden = true;
    sl.setAttribute('aria-label', sym + ' 图表时间范围');
    met.appendChild(sl); q.slider = sl;

    sl.addEventListener('input', async () => {
      if (!q.d) return; q.winStart = +sl.value; q.followEnd = q.winStart >= +sl.max;
      const tf=q.tf, savedView=view(),meta=q.historyStore?.getMeta(tf), bars=seriesFor(q,tf), anchor=bars[0]?.periodStart;
      if(q.winStart===0 && tf!=='intraday' && meta?.meta?.hasMore && anchor && !q._loadingBefore){
        q._loadingBefore=true;
        try{
          await q.historyStore.load(tf,{before:anchor});
          if(q._unmounted)return;
          const next=seriesFor(q,tf),idx=next.findIndex(b=>b.periodStart===anchor);
          if(idx>=0){savedView.winStart=idx;savedView.followEnd=false;}
        }finally{q._loadingBefore=false;}
        if(q.tf!==tf)return;
      }
      drawChart(q);
    });
    // 缩放按钮(移动端友好): + / − / 全部
    const zb = document.createElement('div'); zb.className = 'zoombar';
    zb.innerHTML = '<button data-z="in" aria-label="放大">+</button><button data-z="out" aria-label="缩小">−</button><button data-z="fit" aria-label="全部">全览</button><button data-z="latest" aria-label="跟随最新">最新</button><button data-z="shot" aria-label="导出图表PNG">导出</button>';
    met.appendChild(zb);
    zb.addEventListener('click', (e) => {
      const z = e.target && e.target.dataset && e.target.dataset.z; if (!z || !q.d) return;
      const history = seriesFor(q,q.tf); if (!history.length) return;
      const live=q.tf==='intraday'&&!q._sampled?window.PANEL_CHART_ENGINE.livePointFor(q.d):null;
      const all=live?history.concat(live):history;
      if (z === 'latest') { q.followEnd = true; q.winStart = null; q.hoverIdx = null; q.keyboardSelection=false; drawChart(q); return; }
      if (z === 'shot') {   // 导出当前图表PNG(白底合成, 高清DPR尺寸)
        const out = document.createElement('canvas'); out.width = q.cv.width; out.height = q.cv.height;
        const c2 = out.getContext('2d'); c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, out.width, out.height);
        c2.drawImage(q.cv, 0, 0); if(q.cursor) c2.drawImage(q.cursor,0,0);
        const dl = document.createElement('a');
        dl.download = ((q.d && q.d.symbol) || 'chart') + '_' + q.tf + '.png';
        dl.href = out.toDataURL('image/png');
        document.body.appendChild(dl); dl.click(); dl.remove();
        flash('图表已导出 PNG','success');
        return;
      }
      let vis = q.visN[q.tf] || (window.PANEL_TIMEFRAMES?.get(q.tf)?.visible || (q.tf==='yearly'?20:60));
      if (z === 'in') vis = Math.max(window.PANEL_TIMEFRAMES?.get(q.tf)?.minVisible || 1, Math.round(vis / 1.4));
      else if (z === 'out') vis = Math.min(all.length, Math.round(vis * 1.4));
      else vis = all.length;
      q.visN[q.tf] = vis; if(q.followEnd) q.winStart = null; drawChart(q);
    });

      cards.set(q.cv,q); observer?.observe(q.cv); resize?.observe(q.cv);
      attachHover(q);
    }
    function unmount(q) { if(q.historyRefreshTimer)clearInterval(q.historyRefreshTimer); q.historyStore?.abort(); q._unmounted=true; observer?.unobserve(q.cv); resize?.unobserve(q.cv); cards.delete(q.cv);if(!cards.size){clearInterval(historyRefreshTimer);historyRefreshTimer=null;} }
  function historyQuality(q,b){
    if(q.tf==='intraday')return '';
    const e=q.historyStore?.getMeta(q.tf),m=e?.meta;if(!m)return '';
    const state=b.periodState==='open'?'未收盘':b.periodState==='closed'?'已收盘':'收盘状态未知';
    const cov=b.coverageStatus||m.coverageStatus||m.coverage?.status||'unknown';
    const coverage=cov==='complete-to-asof'?'覆盖至数据截止日':cov==='partial'?'历史范围不完整':'历史覆盖未知';
    const basis=/source-default-unverified$/.test(m.adjustmentBasis||'')?'来源复权口径未确认':m.adjustmentBasis||'未知';
    const volume=m.volumeUnit==='shares'?'股':m.volumeUnit==='source-unit-unverified'?'成交量单位未确认':m.volumeUnit||'未知';
    const stale=e.status==='stale'||m.stale?' · 数据过期':e.status==='loading'?' · 更新中':'';
    return ' · '+state+' · '+coverage+' · 来源 '+sourceName(m.source)+' · '+basis+' · '+volume+' · 数据截至 '+(m.historyAsOf||'未知')+stale;
  }
  // 顶部 OHLC 信息栏(交易所式): 默认显最新一根, 悬停联动
    function ohlcHTML(q, p, i) {
    const money = formatterFor(chartData(q)).money;
    const bi = (i != null && i >= 0 && i < p.n) ? i : p.n - 1;
    const b = p.bars[bi]; if (!b) return '';
    if(b._sample){const esc=window.PANEL_FORMAT.esc;return '<b>'+esc(pointTime(b.t))+'</b> 报价采样 <b>'+esc(money(b.c))+'</b> · 无成交量数据 · '+esc(q._observationNote||'非完整历史');}
    if(b._live){
      const last=p.history.at(-1),esc=window.PANEL_FORMAT.esc;
      return '<b>'+esc(pointTime(b.t))+'</b> 最新报价点 <b>'+esc(money(b.c))+'</b> · '+esc(b.source)+' · 无成交量数据'+
        ' · 历史分时截至 '+esc(pointTime(last.t))+'（早 '+Math.max(0,Math.round(b.t-last.t))+' 秒）';
    }
    const base = p.bars[0].c;
    const chg = p.candle ? b.c - b.o : b.c - base;
    const chgP = p.candle ? (b.o ? chg / b.o * 100 : 0) : (base ? chg / base * 100 : 0);
    const up = chg >= 0, cl = up ? UP : DOWN, sg = up ? '+' : '';
    const c = v => '<b style="color:' + cl + '">' + window.PANEL_FORMAT.esc(v) + '</b>';
    const periodLabel=q.tf==='yearly'?b.periodStart?.slice(0,4):q.tf==='monthly'?b.periodStart?.slice(0,7):q.tf==='weekly'?b.periodStart:fmtDate(b.t,q.tf==='intraday');
    const quality=historyQuality(q,b)+(q.tf==='intraday'&&q._observationNote?' · '+q._observationNote:'');
    let s = '<b>' + window.PANEL_FORMAT.esc(periodLabel) + '</b>  ';
    if (p.candle) s += '开' + c(money(b.o)) + ' 高' + c(money(b.h)) + ' 低' + c(money(b.l)) + ' 收' + c(money(b.c)) + ' 较开盘' + c(sg + money(chg) + ' (' + sg + chgP.toFixed(2) + '%)') + ' 量' + c(fmtVol(b.v)) + '  '
      + p.periods.map(per => { const mc=window.PANEL_CHART_ENGINE.CHART_THEME.ma[per].text,v = p.ma[per][p.a + bi]; return '<span style="color:' + mc + '">MA' + per + ' ' + (v == null ? '—' : money(v)) + '</span>'; }).join(' ');
    else s += '价' + c(money(b.c)) + ' 区间涨跌' + c(sg + money(chg) + ' (' + sg + chgP.toFixed(2) + '%)') + ' 量' + c(fmtVol(b.v));
    s += window.PANEL_FORMAT.esc(quality);
    return s;
  }

  function attachHover(q) {
    if (q.hoverAttached) return; q.hoverAttached = true;
    const cv = q.cv;
    function idxAt(clientX) {
      const p = q.plot; if (!p || !p.n) return null;
      const rect = q._pointerRect ||= cv.getBoundingClientRect();
      const x0 = (clientX - rect.left) * (p.W / rect.width);
      return Math.max(0, Math.min(p.n - 1, Math.floor((x0 - p.L) / p.slot)));
    }
    function setHover(i) { if (!q.plot) return; q.hoverIdx = i; updatePoint(q); }
    function clearHover() { if (!q.plot || q.keyboardSelection) return; q.hoverIdx = null; updatePoint(q); }
    cv.addEventListener('keydown', e => {
      const p=q.plot; if(!p?.n || !['ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key)) return;
      e.preventDefault(); q.keyboardSelection=e.key !== 'Escape';
      if(q.keyboardSelection)q.followEnd=false;
      const current=q.hoverIdx ?? p.n-1;
      setHover(e.key === 'Home' ? 0 : e.key === 'End' ? p.n-1 : e.key === 'Escape' ? null : Math.max(0,Math.min(p.n-1,current+(e.key === 'ArrowRight' ? 1 : -1))));
    });
    cv.addEventListener('pointerenter',()=>{q._pointerRect=cv.getBoundingClientRect();});
    cv.addEventListener('mousemove', (e) => { const i = idxAt(e.clientX); if (i != null && i !== q.hoverIdx) {q.keyboardSelection=false;setHover(i);} });
    cv.addEventListener('mouseleave', clearHover);
    cv.addEventListener('touchstart', (e) => { const i = idxAt(e.touches[0].clientX); if (i != null) setHover(i); }, { passive: true });
    cv.addEventListener('touchmove', (e) => { const i = idxAt(e.touches[0].clientX); if (i != null) setHover(i); }, { passive: true });
    cv.addEventListener('touchend', clearHover);
    // 滚轮缩放: 锚定光标下的那根蜡烛(交易所式)
    cv.addEventListener('wheel', (e) => {
      const p = q.plot; if (!(e.ctrlKey||e.metaKey)||!p||!p.n||!p.all.length) return;
      const newVis = Math.max(window.PANEL_TIMEFRAMES?.get(q.tf)?.minVisible || 1, Math.min(p.all.length, Math.round(p.vis * (e.deltaY > 0 ? 1.2 : 1 / 1.2))));
      if (newVis === p.vis) return; e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const gi = p.a + Math.floor(((e.clientX - rect.left) * (p.W / rect.width) - p.L) / p.slot);
      let ns = Math.round(gi - (gi - p.a) * newVis / p.vis);
      ns = Math.max(0, Math.min(p.all.length - newVis, ns));
      q.visN[q.tf] = newVis; q.winStart = ns; q.followEnd = ns >= p.all.length - newVis;
      drawChart(q);
    }, { passive: false });
    // 拖拽平移(桌面+触摸统一): Pointer Events + setPointerCapture — 指针移出画布仍持续跟踪, 触摸端由此获得拖拽能力
    let drag = null,dragFrame=null;
    const scheduleDrag=()=>{if(dragFrame!==null)return;dragFrame=requestAnimationFrame(()=>{dragFrame=null;if(cv.isConnected!==false)drawChart(q);});};
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 鼠标仅左键拖拽
      drag = { x: e.clientX, s: q.winStart, id: e.pointerId };
      try { if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId); } catch {}
      try { cv.style.cursor = 'grabbing'; } catch {}
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id || !q.plot) return;
      const rect = cv.getBoundingClientRect();
      const dSlots = (e.clientX - drag.x) * (q.plot.W / rect.width) / q.plot.slot;
      const maxStart = Math.max(0, q.plot.all.length - q.plot.vis);
      const ns = Math.max(0, Math.min(maxStart, Math.round(drag.s - dSlots)));
      if (ns !== q.winStart) { q.winStart = ns; q.followEnd = ns >= maxStart; scheduleDrag(); }
    });
    const endDrag = (e) => { if (drag && (!e || e.pointerId === drag.id)) { drag = null; try { cv.style.cursor = 'crosshair'; } catch {} } };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
  }

  // T4: 图表空态文案 — 腾讯分时源限流时给出可解释提示(价格仍实时); 日K缺失单独文案
  function emptyChartText(q){
    const spec=window.PANEL_TIMEFRAMES?.get(q.tf) || {label:q.tf==='yearly'?'年K':q.tf==='monthly'?'月K':q.tf==='weekly'?'周K':'日K'};
    const state=q.historyStore?.getMeta(q.tf)?.status;
    if(state==='loading') return spec.label+'加载中…';
    if(state==='error') return spec.label+' · 历史来源暂不可用'+(q.historyStore?.getMeta(q.tf)?.retryAt>Date.now()?' · 来源冷却中':' · 可点击重试历史');
    if(q.tf !== 'intraday') return spec.label+'暂缺';
    const src = q.d && q.d.src;
    return (src === 'tx-us' || src === 'tx-cn') ? '分时暂不可用 · 请查看报价时间' : '暂无数据';
  }


    function updatePoint(q) {
      const p=q.plot; if(!p?.n)return;
      const i=q.hoverIdx != null && q.hoverIdx<p.n ? q.hoverIdx : p.n-1;
      if(q.ohlc)q.ohlc.innerHTML=ohlcHTML(q,p,i);
       const b=p.bars[i], money=formatterFor(chartData(q)).money;
      const periodLabel=q.tf==='yearly'?b.periodStart?.slice(0,4):q.tf==='monthly'?b.periodStart?.slice(0,7):q.tf==='weekly'?b.periodStart:(b._live?pointTime(b.t):fmtDate(b.t));
       const quality=historyQuality(q,b)+(q.tf==='intraday'&&q._observationNote?' · '+q._observationNote:'');
       const detail=q.symbol+' '+periodLabel+' · '+(b._live?'最新报价点 '+money(b.c)+' · '+b.source+' · 无成交量数据':(p.candle ? '开 '+money(b.o)+' 高 '+money(b.h)+' 低 '+money(b.l)+' 收 '+money(b.c) : '价 '+money(b.c))+' · 量 '+fmtVol(b.v))+quality+' · 第 '+(p.a+i+1)+'/'+p.all.length+' 点';
      if(q.point){q.point.setAttribute('aria-live',q.keyboardSelection?'polite':'off');q.point.textContent=detail;}
      if(q.cursor){ const ctx=q.cursor.getContext('2d'); ctx.setTransform(q.cursor.width/p.W,0,0,q.cursor.height/p.H,0,0); engine.drawCursor(q,p,q.hoverIdx,ctx); }
    }
    function applyPrewarm(q,prepared){
      if(q._unmounted||prepared.symbol!==q.symbol)return;
      q.historyPreparedAt=Date.now();q.historyPrepared=prepared;
      for(const spec of window.PANEL_TIMEFRAMES.all.filter(x=>x.kind==='history')){
        const value=prepared.periods?.[spec.apiPeriod];
        if(value){
          const failed=prepared.status==='stale'||prepared.status==='error';
          q.historyStore.hydrate?.(spec.key,{...value,prewarmed:true,refreshing:prepared.status==='refreshing',...(failed?{status:'stale',stale:true,errorCode:prepared.error,retryAt:prepared.retryAt}:{} )});
        }else if(['error','stale'].includes(prepared.status)){
          const e=q.historyStore.getMeta(spec.key);e.status=e.bars?.length?'stale':'error';e.errorCode=prepared.error;e.retryAt=prepared.retryAt;
        }
      }
      if(q.d&&q.tf!=='intraday')drawChart(q);
    }
    function drawChart(q, force=false) {
      if(q.d&&q._observe){const view=q._observe(q.d,q._intradayMode);q._displayIntraday=view.bars;q._sampled=view.sampled;q._observationNote=view.note;}
      const all=seriesFor(q,q.tf);
      updateChartStatus(q);
       if(q._unmounted)return; if(q.visible === false && !force){q._dirty=true;return;}
      q._dirty=false;
      if(!all.length){
        q.plot=null;q.hoverIdx=null;q._sig='';q._drawKey='';
        if(q.ohlc)q.ohlc.textContent=emptyChartText(q);
        const summary=q.el.querySelector('.chart-summary');if(summary)summary.textContent=q.symbol+' '+emptyChartText(q);
        for(const cv of [q.cv,q.cursor]) if(cv)cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
        if(q.point)q.point.textContent=q.symbol+' '+emptyChartText(q);
        if(q.slider){q.slider.hidden=true;q.slider.value=0;}
        return;
      }
      const last=all[all.length-1];
      const live=q.tf==='intraday'&&!q._sampled?window.PANEL_CHART_ENGINE.livePointFor(q.d):null;
      const liveKey=live?JSON.stringify(live):'';
       const revision=q.tf==='intraday'?q.d.intradayVer:q.historyStore?.getRevision(q.tf)??(q.d.daily30Ver??q.d.daily30Version);
      const key=[q.tf,idOf(all),revision,all.length,last?.t,last?.o,last?.h,last?.l,last?.c,last?.v,liveKey,q.winStart,q.followEnd,q.visN[q.tf],q._chartWidth,JSON.stringify(q.maEnabled),formatKey(chartData(q)),q.historyStore?.getMeta(q.tf)?.status].join('|');
      if(!force && key===q._drawKey)return;
       q._chartData=chartData(q); const p=engine.computePlot(q);
      const width=Math.round(p.W*DPR),height=Math.round(p.H*DPR);
      for(const cv of [q.cv,q.cursor]) if(cv){if(cv.width!==width)cv.width=width;if(cv.height!==height)cv.height=height;cv.style.width='100%';cv.style.height=p.H+'px';}
      p.ctx=q.cv.getContext('2d');p.ctx.setTransform(width/p.W,0,0,height/p.H,0,0);q.plot=p;
      engine.drawPlot(q,p,null); q._sig=key;
      q._drawKey=[q.tf,idOf(all),revision,all.length,last?.t,last?.o,last?.h,last?.l,last?.c,last?.v,liveKey,q.winStart,q.followEnd,q.visN[q.tf],q._chartWidth,JSON.stringify(q.maEnabled),formatKey(chartData(q)),q.historyStore?.getMeta(q.tf)?.status].join('|');
      updatePoint(q);
       const summary=q.el.querySelector('.chart-summary');if(summary)summary.textContent=q.symbol+' '+(window.PANEL_TIMEFRAMES?.get(q.tf)?.label|| (q.tf==='intraday'?'分时':'日K'))+'，'+p.n+' 个数据点，末值 '+formatterFor(q._chartData).money(p.all.at(-1).c)+(live?' · 最新报价点 '+live.source+' · 历史分时截至 '+pointTime(last.t):'');
      if(q.slider){q.slider.min=0;q.slider.max=Math.max(0,p.all.length-p.vis);q.slider.value=p.a;q.slider.hidden=p.all.length-p.vis<=0;}
    }

    const sourceName=source=>({'nasdaq-history':'Nasdaq 历史','nasdaq-intraday':'Nasdaq 分时','eastmoney-history':'东方财富历史','naver-fchart':'Naver 韩国历史','yahoo':'Yahoo','sina':'新浪','tencent':'腾讯'})[source]||source||'未知来源';
    function updateChartStatus(q){
      if(q._unmounted)return;
      const e=q.historyStore?.getMeta(q.tf),intra=q.tf==='intraday',m=e?.meta;
      const label=window.PANEL_TIMEFRAMES?.get(q.tf)?.label||'日K';
      const cooling=!intra&&e?.retryAt>Date.now();
      const checked=intra?q.d?.slowFields?.intraday?.updatedAt:m?.sourceCheckedAt;
      let text=intra?(q._sampled?'报价采样 · 非完整历史':'来源分时 · '+sourceName(q.d?.slowFields?.intraday?.source||q.d?.src)):
        e?.status==='loading'?label+' · 加载中…':e?.status==='error'?label+' · 历史来源暂不可用':
        m?label+' · '+sourceName(m.source)+(e.status==='stale'?' · 缓存历史':m.prewarmed?' · 后台已预备':'')+(m.refreshing?' · 后台更新中':''):label+(q.historyPrepared?' · 后台正在准备':' · 尚未加载');
      text+=intra?' · 北京时间 UTC+8':' · 交易所交易日';
      if(intra&&q.d?.slowFields?.intraday?.timeBasis==='epoch-unverified')text+=' · 来源时间口径待核验';
      if(cooling)text+=' · '+Math.ceil((e.retryAt-Date.now())/1000)+' 秒后可重试';
      if(q.chartState&&q.chartState.textContent!==text){q.chartState.textContent=text;q.chartState.title=checked?'来源检查 '+pointTime(checked/1000):'';}
      if(q.chartRetry){q.chartRetry.hidden=intra||!['error','stale'].includes(e?.status);q.chartRetry.disabled=cooling||e?.status==='loading';}
      if(q.chartModes){q.chartModes.hidden=!intra;q.chartModes.querySelectorAll('button').forEach(b=>{const on=b.dataset.chartMode===(q._sampled?'samples':'history');b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));});}
    }
    // Only error text changes here. No history fetch or canvas work every second.
    const tickStatus=()=>{for(const q of cards.values())if(q.historyStore?.getMeta(q.tf)?.retryAt)updateChartStatus(q);};
    if(!resize)window.addEventListener('resize',()=>{for(const q of cards.values()){q._chartWidth=null;scheduleResize(q);}});
    window.addEventListener('scroll',()=>{for(const q of cards.values())q._pointerRect=null;},{passive:true});
    const refreshVisible=()=>{for(const q of cards.values())q.refreshHistory?.();};
    window.addEventListener('focus',refreshVisible);
    document.addEventListener?.('visibilitychange',()=>{if(!document.hidden)refreshVisible();});
    return Object.freeze({ mount, unmount, applyPrewarm, drawChart, tickStatus });
  };
  window.PANEL_CHART_CONTROLLER=Object.freeze({createChartController});
})();
