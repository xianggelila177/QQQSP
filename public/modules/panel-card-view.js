(() => {
  const createCardView = ({ document, panelsEl, stripEl, chartController, formatterFor, cardCurOf, nameOf, onRemove, onRetry, onCurrency, humanizeAge, UP, DOWN, getReadIntervalMs=()=>0, canPollDetails=()=>!document.hidden, quoteClock=null, onNewsToggle=()=>{} }) => {
    const { esc, fmtVol, pct, fmtTime8 } = window.PANEL_FORMAT;
    const FRIENDLY = {QQQ:'纳指100 ETF',SPY:'标普500 ETF'};
    const visibleName=d=>{
      const us=String(d.market||'').startsWith('美股')||d.src==='naver-us';
      const valid=value=>typeof value==='string'&&value.trim()&&(!us||!/\p{Script=Hangul}/u.test(value));
      return ([nameOf(d.symbol),d.displayName,d.symbol].find(valid)||d.symbol).trim();
    };
    const TF = (window.PANEL_TIMEFRAMES?.all || [['intraday','分时'],['daily30','日K'],['weekly','周K'],['monthly','月K'],['yearly','年K']]).map(t=>Array.isArray(t)?t:[t.key,t.label]);
    const cardCache=new Map(), lastPrice=new Map();
    const reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedMotion?.addEventListener?.('change',()=>{if(reducedMotion.matches)for(const q of cardCache.values())q.priceAnimation?.cancel();});
    let fundamentalsView=null,detailView=null,chartDetailView=null;
    // Measure natural content, never the stretched card or a previous minimum.
    // A shared observer only schedules work when a band's intrinsic size changes.
    const layoutRecords = new Map(), layoutSizes = new Map();
    let layoutFrame = null;
    function scheduleBands() {
      if (layoutFrame != null || typeof requestAnimationFrame !== 'function') return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        const maxima = new Map([['range',22]]);
        for (const record of layoutRecords.values()) maxima.set(record.name, Math.max(maxima.get(record.name) || 0, record.height));
        for (const name of new Set([...layoutSizes.keys(),...maxima.keys()])) {
          const size = Math.ceil(maxima.get(name) || 0);
          if (layoutSizes.get(name) !== size) {
            layoutSizes.set(name,size);
            panelsEl.style.setProperty('--card-band-'+name,size+'px');
          }
        }
      });
    }
    const bandObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      for (const entry of entries) {
        const record = layoutRecords.get(entry.target);
        if (record) record.height = entry.contentRect.height;
      }
      scheduleBands();
    }) : null;
    function mountBands(q) {
      if (!bandObserver || typeof q.el.insertBefore !== 'function') return;
      q.layoutContents = [];
      const regions = {identity:'.cardhead',meta:'.quote-meta',summary:'.numrow',tabs:'.chart-card-toolbar',chartstatus:'.chart-statusbar',chartmeta:'.ohlcbar',chart:'.chartframe',range:'.xslide',actions:'.zoombar',statistics:'.statistics'};
      for (const [name,selector] of Object.entries(regions)) {
        const element = q.el.querySelector(selector); if (!element) continue;
        const slot=document.createElement('div'), content=document.createElement('div');
        slot.className='layout-band'; content.className='layout-content';
        slot.dataset.band=name;
        slot.style.setProperty('--band-size','var(--card-band-'+name+',0px)');
        element.parentNode.insertBefore(slot,element);slot.appendChild(content);content.appendChild(element);
        layoutRecords.set(content,{name,height:content.getBoundingClientRect().height});
        q.layoutContents.push(content);bandObserver.observe(content);
      }
      scheduleBands();
    }
  function cardHTML(sym) {
    return `
    <section class="price-card" id="card-${esc(sym)}" data-sym="${esc(sym)}">
      <div class="cardhead">
        <div class="headname"><span class="friendly"></span><span class="mkttag" data-mkt=""></span><span class="instrument-tag">待识别</span><span class="sym">${esc(sym)}</span></div>
        <span class="card-actions"><span class="chip stale-warn" hidden>数据延迟</span><span class="chip state"></span><button class="cardretry" hidden type="button">重试</button><button class="cardclose" title="移除自选">×</button></span>
      </div>
      <div class="quote-meta"><span class="quote-details"></span><span class="quote-age" data-testid="quote-age"></span><span class="source-check-age"></span></div>
      <div class="numrow">
        <div class="num">
          <div class="numline"><span class="phasetag" hidden></span><span class="cur">—</span><span class="unit">USD</span></div>
          <div class="delta"><span class="c change">—</span><span class="c pct">—</span></div>
          <div class="change-baseline">较昨收基准</div>
          <div class="extrow" hidden></div>
          <div class="fx-note" hidden></div>
        </div>
        <div class="ccyseg">
          <button data-ccy="USD" class="on">USD</button>
          <button data-ccy="CNY">CNY</button>
          <button data-ccy="NATIVE" title="按来源报价单位显示，不换汇">原币</button>
        </div>
      </div>
      <div class="chart-card-toolbar"><div class="tabbar">${TF.map(t=>`<button class="tfbtn" data-tf="${t[0]}">${t[1]}</button>`).join('')}</div>${window.PANEL_CHART_WORKSPACE?.settingsMarkup('chart-'+sym)||''}</div>
      <div class="meter"><div class="chart-statusbar"><span class="chart-state" role="status"></span><span class="chart-style" role="group" aria-label="图形类型"><button type="button" data-chart-style="candle" aria-pressed="true"><span aria-hidden="true">╂</span> K线</button><button type="button" data-chart-style="line" aria-pressed="false"><span aria-hidden="true">⌁</span> 分时</button></span><span class="chart-modes"><button type="button" data-chart-mode="history">来源历史</button><button type="button" data-chart-mode="samples">报价采样</button></span><button type="button" class="chart-retry" hidden>重试历史</button><button type="button" class="chart-expand" title="展开图表" aria-label="展开横向行情详情">⛶</button></div><div class="ohlcbar">—</div><div class="chartframe"><canvas class="chart-main" role="img" aria-label="行情图表"></canvas><canvas class="chart-cursor" aria-hidden="true"></canvas></div><div class="chart-point sr-only"></div><div class="chart-summary sr-only"></div></div>
      ${window.PANEL_FUNDAMENTALS.markup()}
      <details class="newsbox"><summary class="newshead">相关资讯</summary><div class="newslist"><div class="newsempty">加载中…</div></div></details>
    </section>`;
  }

  function ensureCard(sym) {
    if (cardCache.has(sym)) return cardCache.get(sym);
    panelsEl.insertAdjacentHTML('beforeend', cardHTML(sym));
    const el = panelsEl.lastElementChild;
    const q = {
      el, newsbox:el.querySelector('.newsbox'), symbol:sym, tf: 'intraday', d: null, fetchStatus:'pending',requestPending:true,
      quoteMeta: el.querySelector('.quote-meta'),
      quoteDetails: el.querySelector('.quote-details'), quoteAge: el.querySelector('.quote-age'), sourceCheckAge: el.querySelector('.source-check-age'),
      fxNote: el.querySelector('.fx-note'),
      state: el.querySelector('.state'), staleWarn: el.querySelector('.stale-warn'),
      friendly: el.querySelector('.friendly'), mkttag: el.querySelector('.mkttag'),
      cur: el.querySelector('.cur'), unit: el.querySelector('.unit'), phasetag: el.querySelector('.phasetag'),
      change: el.querySelector('.change'), pct: el.querySelector('.pct'),
      changeBaseline:el.querySelector('.change-baseline'),
      extRow: el.querySelector('.extrow'), newslist: el.querySelector('.newslist'), newshead: el.querySelector('.newshead'),
      open: el.querySelector('.grid .open'), high: el.querySelector('.grid .high'), low: el.querySelector('.grid .low'),
      prev: el.querySelector('.grid .prev'), volume: el.querySelector('.grid .volume'),
      w52h: el.querySelector('.grid .w52h'), w52l: el.querySelector('.grid .w52l'), exch: el.querySelector('.grid .exch'),
      cv: el.querySelector('canvas'), ohlc: el.querySelector('.ohlcbar'), winStart: null, followEnd: true, slider: null, visN: {}, hoverIdx: null,
      tabs: [...el.querySelectorAll('.tfbtn')], ccybtns: [...el.querySelectorAll('[data-ccy]')],
    };
    q.retryBtn = el.querySelector('.cardretry');
    q.retryBtn.hidden = true;
    q.retryBtn.setAttribute('aria-label', '重新获取 ' + sym + ' 行情');
    q.retryBtn.addEventListener('click', async () => {
      q.retryBtn.disabled = true;
      try { await onRetry(); } finally { q.retryBtn.disabled = false; }
    });
    q.closeBtn = el.querySelector('.cardclose');
    q.closeBtn.setAttribute('aria-label', '移除 ' + sym + ' 自选');
    q.closeBtn.addEventListener('click', () => onRemove(sym));
    chartController.mount(q);
    fundamentalsView ||= window.PANEL_FUNDAMENTALS.createView({document,cards:cardCache,formatterFor,onLayout:scheduleBands});
    fundamentalsView.mount(q);
    detailView ||= window.PANEL_DETAIL.createDetailView({document});
    detailView.mount(q);
    chartDetailView ||= window.PANEL_CHART_DETAIL.createChartDetailView({document,formatterFor,UP,DOWN,canPoll:canPollDetails,quoteClock});
    chartDetailView.mount(q);
    mountBands(q);
    q.ccybtns.forEach(b => b.addEventListener('click', () => onCurrency(sym, b.dataset.ccy)));
    q.ccybtns.forEach(b => {b.classList.toggle('on', b.dataset.ccy === cardCurOf(sym));b.setAttribute('aria-pressed',String(b.dataset.ccy === cardCurOf(sym)));});
    // strip ticker
    const it = document.createElement('a'); it.className='tick'; it.href='#card-'+sym;
    it.innerHTML = `<span class="tf">${esc(FRIENDLY[sym]||sym)}</span> <b class="tp">—</b> <em class="tch">—</em>`;
    it.addEventListener('click',(e)=>{e.preventDefault();window.PANEL_STATE.scrollToCard(el);});
    stripEl.appendChild(it); q.strip = it;
    q.newsbox?.addEventListener('toggle',()=>onNewsToggle(sym));
    cardCache.set(sym, q);
    return q;
  }

  function extHTML(label, s, money, data) {
    const up = s.change == null ? null : s.change >= 0; const cl = up==null ? 'inherit' : up ? UP : DOWN; const sg = up ? '+' : '';
    const chg = s.change == null ? '涨跌暂缺' : sg + money(s.change) + ' (' + sg + s.changePct.toFixed(2) + '%)';
    const base=s.referencePrice??(s.price!=null&&s.change!=null?s.price-s.change:null);
    const matches=value=>base!=null&&value!=null&&Math.abs(base-value)<.02;
    const venueDate=value=>{const at=quoteTimeMs(value);return at&&Number.isFinite(data.gmtoff)?new Date(at+data.gmtoff*1000).toISOString().slice(0,10):null;};
    const quoteDay=venueDate(data.quoteAt),regularDay=venueDate(data.regularQuoteAt);
    const sameDay=quoteDay&&regularDay&&quoteDay===regularDay;
    const baseline=s.referenceTradeDate?(label==='盘前'?'较上一交易日常规收盘':'较本交易日常规收盘')+' '+s.referenceTradeDate:
      matches(data.regularPrice)?(label==='盘后'&&sameDay?'较本交易日常规收盘':'较常规收盘'):matches(data.prevClose)?'较昨收基准':'基准待核验';
    const details=[s.high!=null?'高 '+esc(money(s.high)):null,s.low!=null?'低 '+esc(money(s.low)):null,s.volume!=null?'量 '+esc(fmtVol(s.volume)):null].filter(Boolean);
    const html='<span class="exttag">' + label + '变化</span>'
      + '<b style="color:' + cl + '">' + money(s.price) + '</b>'
      + '<span style="color:' + cl + ';font-weight:600">' + chg + '</span>'
      + '<span class="extmeta">'+baseline+(base!=null?' '+esc(money(base)):'')+'</span>'
      + (details.length?'<span class="extmeta">'+details.join(' · ')+'</span>':'');
    return {html,regularPriceShown:matches(data.regularPrice)&&money(base)===money(data.regularPrice)};
  }
  // T2: 卡片头部延迟徽标分级 — staleInfo.reason 细分原因, title 写详细说明; 文案只承诺重试
  function applyStaleBadge(q, d, now=quoteClock ? quoteClock.now() : Date.now()){
    const freshness=window.PANEL_STATE.selectFreshness(d,now,{readIntervalMs:getReadIntervalMs()});
    if(!q.staleWarn) return freshness;
    const si=d.staleInfo;
    if(d.recovery||si?.reason==='offline-cache'){
      q.staleWarn.textContent='离线缓存·旧报价';
      q.staleWarn.title='暂时无法取得新报价，显示重启前保存的数据；恢复后自动更新。报价时间未改变。';
    } else if(si && si.reason==='rate-limited'){
      const etaS=si.etaMs>0 ? Math.max(1, Math.ceil(si.etaMs/1000)) : 0;
      q.staleWarn.textContent='上游限流'+(etaS ? '·约'+etaS+'s后重试' : '');
      q.staleWarn.title='上游数据源限流中：当前价格可能来自旧快照，面板会在重试时间到达后再次请求'+(etaS ? '，约 '+etaS+' 秒后重试' : '');
    } else if(si && si.reason==='cooldown'){
      q.staleWarn.textContent='数据延迟·自动重试中';
      q.staleWarn.title='数据源冷却中，面板正在自动重试，恢复后自动更新';
    } else if(['source-overdue','stream-check-overdue'].includes(freshness.reason)){
      q.staleWarn.textContent='来源检查超时';
      q.staleWarn.title='来源检查已超过允许的检查间隔，尚未确认更新。报价时间保持不变。';
    } else if(['quote-overdue','trade-age-exceeded'].includes(freshness.reason)){
      q.staleWarn.textContent='报价久未更新';
      q.staleWarn.title='报价年龄已超过当前时段及来源声明延迟允许的范围；保留原值和原时间，等待本来源提供更新报价。';
    } else if(['quote-time-unknown','quote-time-invalid','source-time-unknown','source-time-invalid'].includes(freshness.reason)){
      q.staleWarn.textContent=freshness.reason.startsWith('quote-')?'报价时间未核验':'来源检查时间未核验';
      q.staleWarn.title='原始时间缺失或异常，不能用本次页面响应时间替代。';
    } else if(d.stale){
      q.staleWarn.textContent='数据延迟';
      q.staleWarn.title='部分数据延迟，正在自动重试';
    } else if(freshness.stale){
      q.staleWarn.textContent='来源数据待更新';
      q.staleWarn.title='来源保留了旧值或返回了异常状态，等待可核验的更新。';
    }
    q.staleWarn.hidden=!freshness.stale;
    return freshness;
  }

  function quoteTimeMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  }
  function updateQuoteMeta(q, now = quoteClock ? quoteClock.now() : Date.now()) {
    const d = q.d; if (!d || !q.quoteMeta) return;
    applyStaleBadge(q,d,now);
    const at = quoteTimeMs(d.quoteAt ?? d.ts);
    const ageText = '报价年龄 ' + window.PANEL_STATE.formatQuoteAge(d.quoteAt ?? d.ts, now);
    // Keep source diagnostics in the source-health/detail views, not below every price.
    if (q.quoteAge) {
      if (q.quoteDetails) { q.quoteDetails.textContent = ''; q.quoteDetails.hidden = true; }
      if (q.sourceCheckAge) { q.sourceCheckAge.textContent = ''; q.sourceCheckAge.hidden = true; }
      if (q.quoteAge.textContent !== ageText) q.quoteAge.textContent = ageText;
      q.quoteAge.dataset.quoteAsofMs = at == null ? '' : String(at);
      q.quoteAge.dataset.ageComputedAtMs = String(now);
      q.quoteAge.dataset.ageTickSeq = String((Number(q.quoteAge.dataset.ageTickSeq) || 0) + 1);
    } else q.quoteMeta.textContent = ageText;
    q.quoteMeta.title = '';
  }

  function render(q) {
    const d = q.d; if (!d) return;
    // Historical bars live in the independent store. Quote refreshes must never
    // copy them into d.charts, where a later quote response can overwrite them.
    const format = formatterFor(d), money = format.money;
    q.currency = d.currency || 'USD';
    updateQuoteMeta(q);
    const up = d.change == null ? null : d.change >= 0;
    // 价格 flash
    q.cur.className = 'cur';
    const prev = lastPrice.get(d.symbol);
    if (prev!=null && prev!==d.price && !reducedMotion?.matches) {
      q.cur.classList.remove('flash-up','flash-down');
      if(q.cur.animate){q.priceAnimation?.cancel();q.priceAnimation=q.cur.animate([{opacity:0.35},{opacity:1}],{duration:420,easing:'ease-out'});}
      else q.cur.classList.add(d.price>prev?'flash-up':'flash-down');
    }
    if (d.price!=null) lastPrice.set(d.symbol,d.price);
    q.cur.textContent = money(d.price);
    const wants = cardCurOf(d.symbol);
    const canConvert = format.canConvert;
    q.unit.textContent = format.unit;
    const fxNotes=[d.instrumentNote,format.sourceDescription];
    if(!canConvert && !(d.instrumentType === 'INDEX' || d.priceUnit === 'POINTS'))fxNotes.push('汇率暂缺或过期，当前显示原币 '+format.unit);
    if(format.referenceConversion)fxNotes.push('按欧洲央行 '+(d.fxDate||'日期未知')+' 参考汇率交叉换算，非实时汇率');
    if(q.fxNote){q.fxNote.textContent=fxNotes.filter(Boolean).join(' · ');q.fxNote.hidden=!q.fxNote.textContent;}
    q.el.classList.toggle('index-card', (d.instrumentType === 'INDEX' || d.priceUnit === 'POINTS'));
    q.ccybtns.forEach(b => { b.disabled = (d.instrumentType === 'INDEX' || d.priceUnit === 'POINTS');const selected=!b.disabled && b.dataset.ccy===cardCurOf(d.symbol);b.classList.toggle('on',selected);b.setAttribute('aria-pressed',String(selected)); });
    // T5: 汇率缺失提示 — CNY 显示目标但 currency2cny 未提供(上游限流)时, 单位加悬停说明(显示值维持 '—'/原币, 数值逻辑不变)
    q.unit.title = (!(d.instrumentType === 'INDEX' || d.priceUnit === 'POINTS') && wants !== 'NATIVE' && !canConvert)
      ? '汇率暂缺或过期，显示原币' : '';
    const ph = d.instrumentType==='FUTURE' ? '期货来源报价（非现货指数）' : d.quoteKind==='reported-trade' ? '最新报告成交（非官方收盘价）' : {PRE:'最近盘前报价', POST:'最近盘后报价', REGULAR:'常规时段报价'}[d.priceSession];
    if (q.phasetag) { q.phasetag.hidden = !ph; if (ph) q.phasetag.textContent = ph; }
    q.change.textContent = d.change==null?'—':(d.change>=0?'+':'')+money(d.change);
    q.pct.textContent = pct(d.changePct);
    q.change.className = 'change c' + (up==null?'':(up?' up':' down'));
    q.pct.className = 'pct c' + (up==null?'':(up?' up':' down'));

    if (q.friendly) q.friendly.textContent = FRIENDLY[d.symbol] || visibleName(d);
    const typeTag=q.el.querySelector('.instrument-tag');
    if(typeTag)typeTag.textContent=d.instrumentTypeSource==='inferred'?'待识别':({EQUITY:'股票',ETF:'ETF',MUTUALFUND:'基金',INDEX:'指数',FUTURE:'期货',CURRENCY:'汇率'}[d.instrumentType]||'待识别');
    if (q.mkttag) { const mk = d.market || '市场未核验'; q.mkttag.dataset.mkt = mk; q.mkttag.textContent = mk; }
    applyStaleBadge(q, d);   // T2: stale 徽标分级 — 上游限流(含重试倒计时)/冷却重试/旧后端 d.stale 兼容
    const calendarEstimate = d.calendarCoverage && d.calendarCoverage.known === false;
    const calendar=window.PANEL_STATE.calendarStatus(d);
    const stName={REGULAR:(calendarEstimate ? '常规时段·节假日未核验' : '交易中'),PRE:'盘前',POST:'盘后',AUCTION:'集合竞价',BREAK:'午间休市',CLOSED:'已收盘',HOLIDAY:'休市',UNKNOWN:calendar.pending?'交易时段待公布':'时段未核验'}[d.marketState]||'时段未核验';
    q.marketLabel=stName;q.marketTitle=calendar.message||(calendarEstimate ? '交易日历覆盖不足，此时段状态仅为估计' : '');applyRequestState(q);
    const baseline=window.PANEL_FORMAT.quoteBaseline(d,money);
    if(q.changeBaseline){q.changeBaseline.textContent=baseline.text;q.changeBaseline.title=baseline.title;}

    // 盘前/盘后独立报价行
    if (q.extRow) {
      const ex = d.ext; let extended = null;
      if (d.priceSession === 'PRE' && ex && ex.pre) extended = extHTML('盘前', ex.pre, money,d);
      else if (d.priceSession === 'POST' && ex && ex.post) extended = extHTML('盘后', ex.post, money,d);
      let eh=extended?.html||'';
      if (['PRE','POST'].includes(d.priceSession) && d.regularPrice != null && !extended?.regularPriceShown) eh += '<span class="regular-close">常规时段收盘 ' + money(d.regularPrice) + '</span>';
      q.extRow.innerHTML = eh; q.extRow.hidden = !eh;
    }
    q.open.textContent=money(d.open); q.high.textContent=money(d.dayHigh); q.low.textContent=money(d.dayLow);
    q.prev.textContent=money(d.prevClose);
    const previousLabel=q.prev.parentElement?.querySelector?.('label');if(previousLabel)previousLabel.textContent=baseline.shortLabel; q.volume.textContent=fmtVol(d.volume);
    q.w52h.textContent=money(d.week52High); q.w52l.textContent=money(d.week52Low);
    q.exch.textContent=d.exchangeName || '—';
    fundamentalsView?.render(q);

    chartController.drawChart(q);
    chartDetailView?.update(q);
  }

  function renderStrip(d) {
    if (!cardCache.has(d.symbol)) return;
    const q = cardCache.get(d.symbol);
    const money = formatterFor(d).money;
    const up = d.change==null?null:d.change>=0;
    q.strip.querySelector('.tp').textContent = money(d.price) + ' ' + ((d.instrumentType === 'INDEX' || d.priceUnit === 'POINTS') ? '点' : q.unit.textContent);
    const tch = q.strip.querySelector('.tch');
    tch.textContent = pct(d.changePct);
    tch.className='tch'+(up==null?'':(up?' up':' down'));
  }

    function applyRequestState(q) {
      const failed=q.fetchStatus==='error',pending=q.fetchStatus==='pending';
      q.el.classList.toggle('fetch-error',failed);q.el.classList.toggle('first-pending',pending&&!q.d);q.el.setAttribute('aria-busy',String(pending&&!q.d));
      if(q.retryBtn)q.retryBtn.hidden=!failed;
      if(q.state){q.state.textContent=[failed?'拉取失败':pending?(q.d?'等待更新':'等待报价'):null,q.marketLabel].filter(Boolean).join(' · ');q.state.className='chip state'+(!failed&&!pending&&q.d?.marketState==='REGULAR'?' open':'');q.state.title=q.marketTitle||'';}
    }
    function setFetchStatus(q,status) {
      q.requestPending=status==='pending';
      // A pending response does not prove that a previous failure recovered.
      if(status!=='pending'||q.fetchStatus!=='error')q.fetchStatus=status;
      applyRequestState(q);
    }

    function remove(symbol) { const q=cardCache.get(symbol);if(!q)return;fundamentalsView?.remove(q);detailView?.remove(q);chartDetailView?.remove(q);chartController.unmount(q);for(const content of q.layoutContents||[]){bandObserver?.unobserve(content);layoutRecords.delete(content);}scheduleBands();q.el.remove();q.strip?.remove();cardCache.delete(symbol);lastPrice.delete(symbol); }
    return Object.freeze({ ensureCard, render, renderStrip, updateQuoteMeta, setFetchStatus, cardCache, remove, syncVisibility:()=>chartDetailView?.syncVisibility() });
  };
  window.PANEL_CARD_VIEW=Object.freeze({createCardView});
})();
