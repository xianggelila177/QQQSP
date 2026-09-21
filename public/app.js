(() => {
  const $ = (id) => document.getElementById(id);
  let activeToastClose=null;
  const panelsEl = $('panels');
  const stripEl = $('strip');
  const PANEL = window.PANEL_UTILS;
  if (!PANEL) throw new Error('panel helper modules missing');
  const panelNetwork = PANEL.createNetwork({ fetchImpl: fetch, timeoutMs: 20000 });
  const quoteClock = window.PANEL_STATE.createQuoteClock();
  const storage=window.PANEL_STATE.createSafeStorage(()=>window.localStorage,()=>queueMicrotask(()=>flash('浏览器存储不可用，偏好仅在本次页面会话中保留','warn')));
  const panelState = PANEL.createState(storage, { maxWatchlist: window.PANEL_STATE.MAX_WATCHLIST_SYMBOLS });
  let refreshMode=panelState.loadRefreshMode();
  let lastData = [];
  let liveStore=null;
  // FX is data, not a display default.  An absent/stale rate must stay absent.
  let fxMap = {};
  const cardCur = panelState.loadCurrencies('qqq-card-cur');   // 每卡独立显示币种(交易所惯例)
  function cardCurOf(sym) { return cardCur.get(sym) || 'USD'; }
  function saveCardCurrencies() { panelState.saveCurrencies('qqq-card-cur', cardCur); }
  const formatterFor = data => window.PANEL_FORMAT.createFormatter({ data, displayCurrency:cardCurOf(data?.symbol), fxMap });
  const UP = '#d63749', DOWN = '#12805c';   // 中式: 红涨绿跌 · 与 style.css --up/--down 统一(P2), #0a7d47 白底对比度>=4.5:1(AA)
  // ---- 多市场自选列表 ----
  const WL_KEY = 'qqq-watchlist';
  let watchlist = panelState.loadWatchlist(WL_KEY, ['QQQ', 'SPY']);
  const watchlistNetwork=PANEL.createNetwork({fetchImpl:fetch,timeoutMs:10000});
  let watchlistSync;
  const adminControl=window.PANEL_ADMIN.createAdminControl({document,button:$('btnAdmin'),status:$('watchlistSyncStatus'),onRetry:()=>watchlistSync.retry()});
  watchlistSync=window.PANEL_WATCHLIST_SYNC.createWatchlistSync({network:watchlistNetwork,getToken:adminControl.getToken,onStatus:adminControl.setStatus});
  const saveWL=()=>{panelState.saveWatchlist(WL_KEY,watchlist);watchlistSync.save(watchlist);};
  window.addEventListener('pagehide',()=>{watchlistSync.pause();adminControl.clear();});
  window.addEventListener('pageshow',()=>watchlistSync.resume());
  window.addEventListener('online',()=>watchlistSync.retry());
  const emptyState=document.createElement('section');emptyState.className='watchlist-empty';emptyState.hidden=true;
  emptyState.innerHTML='<h2>尚未添加自选</h2><p>搜索证券代码或名称，即可添加行情卡片。</p><button type="button">搜索并添加标的</button>';
  emptyState.querySelector('button').addEventListener('click',()=>$('q').focus());panelsEl.appendChild(emptyState);
  const updateEmptyState=()=>{emptyState.hidden=watchlist.length!==0;};
  const NAMES_KEY = 'qqq-names';
  const names = panelState.loadNames(NAMES_KEY);
  const saveName = (sym, name) => { if (typeof name!=='string' || !name.trim()) return; names[sym]=name.trim().slice(0,160); panelState.saveNames(NAMES_KEY,names); };
  const { esc } = window.PANEL_FORMAT;
  const chartController=window.PANEL_CHART_CONTROLLER.createChartController({ document, formatterFor, formatKey:d=>JSON.stringify([cardCurOf(d.symbol),d.currency,d.instrumentType,d.fxStale,d.fxKind,d.fxKind?d.fxMap:fxMap]), client:PANEL, flash, UP, DOWN, dpr:devicePixelRatio });
  const cardView=window.PANEL_CARD_VIEW.createCardView({ document, panelsEl, stripEl, chartController, formatterFor, cardCurOf, nameOf:sym=>names[sym], onRemove:removeFromWatch, onRetry:()=>refresh(true), onCurrency:setCardCurrency, humanizeAge, UP, DOWN, onNewsToggle:()=>{newsController.invalidate();void refreshNews();}, getReadIntervalMs:()=>currentPollingPolicy().marketMs, quoteClock });
  const {ensureCard,render,renderStrip,updateQuoteMeta,setFetchStatus,cardCache}=cardView;
  function removeFromWatch(sym) {
    const q=cardCache.get(sym); if(!q)return;
    const removedIndex=watchlist.indexOf(sym),restoreFocus=q.el.contains(document.activeElement);
      watchlist = watchlist.filter(x => x !== sym); marketGeneration++; newsController.invalidate(); saveWL();
      cardView.remove(sym); marketStore.remove(sym);updateEmptyState();
      if(restoreFocus){const next=cardCache.get(watchlist[Math.min(removedIndex,watchlist.length-1)]);(next?.el.querySelector('button')||$('q')).focus();}
      cardCur.delete(sym); saveCardCurrencies(); if (q.strip) q.strip.remove();
      marketDirectory.syncMembership();
      lastData = lastData.filter(d => d.symbol !== sym);
      lastErrorCount = [...cardCache.values()].filter(card => card.el.classList.contains('fetch-error')).length;
      renderDigest(); updateSession(lastData);liveStore?.setSymbols();void refreshPreparedHistory(true);
      if (!watchlist.length) {
        lastErrorCount=0;lastPendingCount=0;
        abortActiveRequests();
        $('updateAt').textContent = '自选为空';
        $('session').textContent = '未选择标的';
        flash('自选已清空，可重新搜索添加', 'success');
      }
  }
  function setCardCurrency(sym, c) {
    if (!['USD','CNY','NATIVE'].includes(c)) return;
    cardCur.set(sym, c); saveCardCurrencies();   // 对象格式: 与读取端 Object.entries 匹配(原数组格式永远恢复失败)
    const q = cardCache.get(sym); if (!q) return;
    q.ccybtns.forEach(b => {b.classList.toggle('on', b.dataset.ccy === c);b.setAttribute('aria-pressed',String(b.dataset.ccy === c));});
    if (q.d) { render(q); renderStrip(q.d); }
  }

  function updateSession(arr){
    const known=arr.filter(d=>d&&d.marketState);
    const trading=known.filter(d=>['REGULAR','AUCTION'].includes(d.marketState)).length;
    const extended=known.filter(d=>['PRE','POST'].includes(d.marketState)).length;
    const pending=known.some(d=>d.calendarCoverage?.known===false||d.marketState==='UNKNOWN');
    $('session').textContent=known.length?trading+'/'+watchlist.length+' 交易中'+(extended?' · '+extended+' 盘前/盘后':'')+(pending?' · 部分时段待公布或未核验':''): '市场状态待更新';
    $('session').className='chip'+(trading?' ours-open':'');
  }

  let preparedNextAt=0,preparedReading=false;
  function applyHistories(payload){
    if(!payload?.enabled||!Array.isArray(payload.entries))return;
    preparedNextAt=Date.now()+30000;
    for(const entry of payload.entries)if(watchlist.includes(entry.symbol))chartController.applyPrewarm(ensureCard(entry.symbol),entry);
  }
  async function refreshPreparedHistory(force=false){
    if(preparedReading||!force&&Date.now()<preparedNextAt)return;
    preparedReading=true;preparedNextAt=Date.now()+30000;
    try{const r=await panelNetwork.request('history-bundle','/api/history/bundle?symbols='+encodeURIComponent(watchlist.join(',')));if(r.ok)applyHistories(await r.json());}
    catch{/* Existing bars remain usable; the normal source status carries failures. */}
    finally{preparedReading=false;}
  }
  let lastRefresh=0;
  let lastErrorCount=0;
  let lastPendingCount=0;
  let refreshInFlight=false;   // 手动/自动刷新在途标记: 手动按钮防重入 + 看门狗补刷避让
  let marketInFlight = null;
  let marketGeneration = 0;
  function abortActiveRequests() { panelNetwork.abortAll(); }
  let lastBeatAt=Date.now();   // 最近一次心跳节拍时刻(看门狗判定 Worker 死亡/页面冻结恢复)
  const marketStore=window.PANEL_MARKET_STORE.createMarketStore();
  const {intradayCache,daily30Cache}=marketStore;
  const cvParam=()=>marketStore.chartVersions(watchlist);
  // T6: 拉取失败符号不静默丢弃 — 已有卡片的标记 fetch-error 失败态(下次成功自动移除); 无卡片的忽略
  function markFetchErrors(list, currentSymbols = null){
    for(const d of list){
      if(!d || !d.error || d.pending || !d.symbol) continue;
      if (currentSymbols && !currentSymbols.has(d.symbol)) continue;
      const q=cardCache.get(d.symbol) || ensureCard(d.symbol);
      setFetchStatus(q,'error');
    }
  }
  function applyQuotes(arr,requested=arr.map(q=>q.symbol)){
        for (const item of arr.filter(item => item?.symbol && watchlist.includes(item.symbol))) {
          if (item && item.fxMap) fxMap={...fxMap,...item.fxMap};
        }
        const current = new Set(watchlist);
        // Only symbols still in the current watchlist may mutate UI state.
        // This prevents a stale or malformed upstream response from creating a ghost card.
        const removedRequested = new Set(requested.filter(sym => !current.has(sym)));
        const arrived=arr.filter(d => d && d.symbol && current.has(d.symbol));
        for (const symbol of requested) if (current.has(symbol) && !arrived.some(d => d.symbol === symbol)) {
          arrived.push({ symbol, error: '暂无报价', code: 'EMPTY_RESULT' });
        }
        const pending = arrived.filter(d => d.pending);
        lastPendingCount = pending.length;
        pending.forEach(d => {
          const q = ensureCard(d.symbol);
          setFetchStatus(q,'pending');
        });
        const incoming=arrived.filter(d=>!d.error && !d.pending && d.symbol);
        lastRefresh=Date.now();
        const errors = arrived.filter(d => d.error && !d.pending);
        markFetchErrors(errors, current);
        incoming.forEach(d=>{
          marketStore.prepareQuote(d);
          const q=ensureCard(d.symbol); q.d=d;
          setFetchStatus(q,'success');
          render(q); renderStrip(d);
        });
        lastErrorCount=[...cardCache.values()].filter(q=>q.fetchStatus==='error').length;
        // Remove state belonging to symbols deleted while the request was in flight.
        for (const [sym, q] of cardCache) if (removedRequested.has(sym)) { q.el.remove(); q.strip && q.strip.remove(); cardCache.delete(sym); }
        lastData=watchlist.map(sym=>cardCache.get(sym)?.d).filter(Boolean);
        lastPendingCount=watchlist.filter(sym=>cardCache.get(sym)?.fetchStatus==='pending').length;
        distributeNews(); renderDigest(); updateSession(lastData);
        if (pending.length && !lastData.length) $('updateAt').textContent = '等待首次报价';
        return { ok: true, partial: errors.length > 0, pending: pending.length > 0, data: lastData };
  }
  async function refresh(showError){
    if(!watchlist.length){ lastData=[]; lastErrorCount=0; lastPendingCount=0; renderDigest(); $('session').textContent='未选择标的'; $('updateAt').textContent='自选为空'; return { ok: true, empty: true }; }
    if (marketInFlight) return marketInFlight;
    lastMarketBeat=beatN;
    const requested = [...watchlist], generation = ++marketGeneration;
    const url = window.PANEL_LIVE_STORE.symbolsUrl('/api/market?t='+Date.now(),requested,cvParam());
    marketInFlight = (async () => {
      try{
        const clockStarted = quoteClock.monotonic();
        const r = await panelNetwork.request('market', url);
        if(!r.ok) throw Object.assign(new Error(r.retryAt > Date.now() ? '请求限流，约 '+Math.ceil((r.retryAt-Date.now())/1000)+' 秒后重试' : 'HTTP '+r.status), {retryAt:r.retryAt});
        const payload=await r.json();
        quoteClock.sync(r.headers?.get?.('X-Server-Now-Ms'), clockStarted);
        const arr=PANEL.normalizeList(payload).filter(Boolean);
        if (generation !== marketGeneration) return { ok: false, superseded: true };
        return applyQuotes(arr,requested);
      }catch(e){
        if(generation!==marketGeneration)return {ok:false,superseded:true};
        if(!e.retryAt)console.error('[refresh err]', e && e.message);
        lastErrorCount = Math.max(1, lastErrorCount);
        if(showError) flash('获取行情失败: '+e.message);
        lastErrorCount = requested.length; markFetchErrors(requested.map(symbol => ({symbol,error:'network unavailable'})),new Set(watchlist));
        $('updateAt').textContent=e.retryAt>Date.now()?e.message:'连接失败，将自动重试';
        return { ok: false, error: e };
      } finally {
        marketInFlight = null;
        
      }
    })();
    return marketInFlight;
  }
  // 手动刷新按钮: 立即拉全量(行情+新闻+宏观), 在途防重入, 按钮旋转反馈, 结果 flash
  async function manualRefresh(){
    if(refreshInFlight) return;
    refreshInFlight = true;
    const btn = $('btnRefresh');
    if(btn) btn.classList.add('spinning');
    try{
      const [market, news, macro] = await PANEL.withDeadline(
        Promise.all([refresh(false), refreshNews(), refreshMacro()]), 20000,
        abortActiveRequests
      );
      if(market.superseded)return;
      if (!market.ok) { flash('手动刷新失败: ' + (market.error && market.error.message || '行情暂不可用'), 'error'); return; }
      if (market.partial) { flash('行情部分刷新失败，请稍后重试', 'warn'); return; }
      if (market.pending) { flash('正在等待报价，将自动更新', 'warn'); return; }
      if (!news || !macro) { flash('已刷新，部分资讯暂不可用', 'warn'); return; }
      flash('已刷新', 'success');
    }catch(e){ flash('手动刷新失败: ' + (e && e.message || e), 'error'); }
    finally{
      refreshInFlight = false;
      if(btn) btn.classList.remove('spinning');
    }
  }
  // P1-U8: flash 支持 success/warn/error 变体; 默认 error 兼容旧调用; role 语义化播报
  // T8: 右上角 × 可手动关闭(点击即 remove 并 clearTimeout, 防止自动关闭定时器重复触发);
  //     × 由 CSS .msg-close::after 渲染 — 消息 textContent 保持纯文本(读屏/测试不受按钮字符污染)
  function flash(m, type, action){
    activeToastClose?.();
    const t = ['success','info','warn','error'].includes(type) ? type : 'error';
    const el = document.createElement('div');
    el.className = 'msg' + (t === 'error' ? '' : ' msg-' + t);
    el.setAttribute('role', t==='success'||t==='info' ? 'status' : 'alert');
    el.textContent = m;   // 消息纯文本(须先于按钮: textContent setter 会清空既有子节点)
    if(action){const button=document.createElement('button');button.type='button';button.className='msg-action';button.textContent=action.label;button.addEventListener('click',action.run);el.appendChild(button);}
    const x = document.createElement('button');
    x.className = 'msg-close';
    x.type = 'button';
    x.setAttribute('aria-label', '关闭提示');
    x.setAttribute('title', '关闭');
    el.appendChild(x);
    let timer = 0;
    const close = () => { if (timer) { clearTimeout(timer); timer = 0; } el.remove();if(activeToastClose===close)activeToastClose=null; };
    x.addEventListener('click', close);
    document.body.appendChild(el);
    activeToastClose=close;timer = setTimeout(close,action?15000:4000);
    return el;
  }

  let deferredPrompt=null;
  window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredPrompt=e;$('btnPwa').hidden=false;});
  $('btnPwa').addEventListener('click',async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('btnPwa').hidden=true;}});

  if('serviceWorker'in navigator){
    navigator.serviceWorker.register('/sw.js?v=97').then((reg)=>{
      reg.addEventListener('updatefound',()=>{ const nw=reg.installing; if(!nw)return;   // 新版本就绪提示(借鉴 openmarket ReleaseNotes 模式)
        nw.addEventListener('statechange',()=>{ if(nw.state==='installed'&&navigator.serviceWorker.controller)flash('面板已更新，刷新页面启用新版本','info',{label:'刷新页面',run:()=>location.reload()}); });
      });
    }).catch(()=>{});
  }
  // Header connection age follows the selected reading cadence. Quote/source
  // freshness is shared with cards and does not mistake a closed market for failure.
  function updateAtInfo(s, anyStale, responseBudgetSeconds=15) {
    // v2(2026-09-04 用户报告): 顶栏「更新于」只反映**响应新鲜度**(lastRefresh 距今)。
    // 曾用「最旧符号数据 ts」驱动顶栏, 但全球自选里总有市场处于收盘(如 ^IXIC ts 冻结在昨夜美股收盘 16.5h)
    // → 顶栏永远显示 N 小时前, 即便面板刚刷新成功。收盘市场的数据年龄由卡片「已收盘」chip 表达。
    if (anyStale) return { text: '部分延迟', stale: true };
    if (s <= responseBudgetSeconds) return { text: '连接正常', stale: false };
    return { text: humanizeAge(s), stale: true };   // 大龄人性化: 50000s → 「更新于 13.9 小时前」
  }
  function quoteIsStale(d, now = Date.now()) {
    return window.PANEL_STATE.selectFreshness(d,now,{readIntervalMs:currentPollingPolicy().marketMs}).stale;
  }
  // 大龄人性化: 秒数 → 可读时长(≥90s 转分钟, ≥1h 转小时保留1位)
  function humanizeAge(s) {
    if (s < 90) return '更新于 ' + s + 's 前';              // 既有契约: 90s 内保持秒数格式
    if (s < 3600) return '更新于 ' + Math.round(s / 60) + ' 分钟前';
    return '更新于 ' + (s / 3600).toFixed(1) + ' 小时前';   // 50000s → 「更新于 13.9 小时前」
  }
  // 时钟/轮询统一由下方心跳驱动(BG-KEEPALIVE)
  // ---- 全球搜索 ----
  function addToWatch(sym, name) {
    const changed=!watchlist.includes(sym);
    if (!watchlist.includes(sym)) {
      if (watchlist.length >= window.PANEL_STATE.MAX_WATCHLIST_SYMBOLS) { flash('自选最多添加 '+window.PANEL_STATE.MAX_WATCHLIST_SYMBOLS+' 只标的', 'warn'); return false; }
      watchlist.push(sym); marketGeneration++; saveWL();
    }
    saveName(sym, name || '');
    ensureCard(sym); searchController.hideSearch(true);
    marketDirectory.syncMembership();
    updateEmptyState();if(changed){liveStore?.setSymbols();void refreshNews();void refreshPreparedHistory(true);}
    const card = document.getElementById('card-' + sym);window.PANEL_STATE.scrollToCard(card,{block:'start'});
    return true;
  }
  const searchController = window.PANEL_SEARCH_CONTROLLER.createSearchController({ qEl:$('q'), srEl:$('sresults'), document, network:panelNetwork, client:PANEL, esc, onSelect:addToWatch });
  const runSearch = searchController.runSearch;
  const marketDirectory = window.PANEL_MARKET_DIRECTORY.createMarketDirectory({document,root:$('marketDirectory'),status:$('marketDirectoryStatus'),retry:$('marketDirectoryRetry'),content:$('marketDirectoryContent'),network:panelNetwork,onSelect:addToWatch,getWatchlist:()=>watchlist});
  // ---- 卡片新闻: 每60s拉一次, 分发到各卡(独立于行情轮询) ----
  const newsController=window.PANEL_NEWS_CONTROLLER.createNewsController({network:panelNetwork,client:PANEL,getWatchlist:()=>watchlist.filter(s=>cardCache.get(s)?.newsbox?.open),getCards:()=>cardCache});
  const {renderNews,refreshNews}=newsController;
  const distributeNews=()=>newsController.distribute();
  const macroController=window.PANEL_MACRO_CONTROLLER.createMacroController({document,network:panelNetwork,client:PANEL,box:$('macrolist'),filters:$('mfilters'),status:$('macroStatus'),retry:$('macroRetry'),isOpen:()=>!!document.querySelector('.macrobox')?.open,onChange:()=>renderDigest()});
  const refreshMacro=()=>document.querySelector('.macrobox')?.open?macroController.refreshMacro():Promise.resolve(true);
  document.querySelector('.macrobox')?.addEventListener('toggle',()=>{if(document.querySelector('.macrobox').open)void refreshMacro();else macroController.cancel();});
  function renderDigest() {
    const el = document.getElementById('digest'); if (!el) return;
    if (!lastData.length && !macroController.items().length) { el.innerHTML = ''; return; }
    const up = lastData.filter(d => d.change > 0).length, down = lastData.filter(d => d.change < 0).length;
    const sorted = [...lastData].filter(d => d.changePct != null).sort((a, b) => b.changePct - a.changePct);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const focus=macroController.items().filter(n=>n.assessment?.importance==='focus'&&n.assessment.status!=='background').length;
    const parts = [];
    if (lastData.length) parts.push('自选 ' + up + '涨/' + down + '跌');
    if (best && best.changePct > 0) parts.push('领涨 ' + best.symbol + ' +' + best.changePct.toFixed(2) + '%');
    if (worst && worst.changePct < 0 && (!best || worst.symbol !== best.symbol)) parts.push('领跌 ' + worst.symbol + ' ' + worst.changePct.toFixed(2) + '%');
    if(macroController.items().length)parts.push('宏观 '+focus+' 条重点证据 / '+macroController.items().length+' 条去重资讯（不汇总多空票数）');
    el.innerHTML = '<span class="dtag">市场概览</span>' + esc(parts.join(' · ') || '等待数据…');
  }
  // Foreground return always catches up, independently of the saved mode.
  function shouldPoll(h) { return !(h == null ? document.hidden : !!h); }
  // Continuous mode preserves the existing 2s background request behavior.
  // Economy mode follows session/source cadence without changing that choice.
  const beat = { ms: 1000, visEvery: 2, hidEvery: 2, newsEvery: 60, macroEvery: 120 };
  let beatN = 0, beatWorker = null, lastMarketBeat=0,lastNewsBeat=0,lastMacroBeat=0;
  const currentPollingPolicy=()=>window.PANEL_STATE.pollingPolicy(watchlist.map(symbol=>{const card=cardCache.get(symbol);return card?.requestPending?null:card?.d;}),{mode:refreshMode,hidden:document.hidden});
  const refreshModeButton=document.createElement('button');refreshModeButton.type='button';refreshModeButton.className='chip refresh-mode';refreshModeButton.id='refreshMode';
  $('btnRefresh').parentNode?.appendChild(refreshModeButton);
  function updateRefreshModeLabel(){
    const state=liveStore?.state()||'connecting';
    const text={idle:'等待连接',connecting:'连接推送中',streaming:'面板推送已连接',fallback:'已回退读取',paused:'后台已暂停'}[state]||state;
    refreshModeButton.textContent=(refreshMode==='continuous'?'持续监控':'省流')+' · '+text;
    refreshModeButton.setAttribute('aria-label','当前'+text+'，点击切换持续监控与省流模式');
    refreshModeButton.setAttribute('aria-pressed',String(refreshMode==='continuous'));
  }
  function setRefreshMode(value){refreshMode=value==='continuous'?'continuous':'economy';panelState.saveRefreshMode(refreshMode);syncVisibility();updateRefreshModeLabel();}
  refreshModeButton.addEventListener('click',()=>setRefreshMode(refreshMode==='continuous'?'economy':'continuous'));updateRefreshModeLabel();
  function tickClock() {
    chartController.tickStatus?.();
    newsController.tick?.();
    macroController.tick?.();
    if(!document.hidden&&!liveStore?.healthy())void refreshPreparedHistory();
    const d8=new Date(Date.now()+8*3600e3); const p2=n=>String(n).padStart(2,'0');   // 强制 UTC+8
    $('clock').textContent=p2(d8.getUTCHours())+':'+p2(d8.getUTCMinutes())+':'+p2(d8.getUTCSeconds())+' UTC+8';
    updateRefreshModeLabel();
    if(!watchlist.length){$('updateAt').textContent='自选为空';$('updateAt').classList.remove('stale');$('session').textContent='未选择标的';return;}
    const quoteNow = quoteClock.now();
    for(const q of cardCache.values())updateQuoteMeta(q, quoteNow);
    if(lastRefresh){
      const s=Math.round((Date.now()-lastRefresh)/1000);
      const anyStale=lastErrorCount > 0 || lastData.some(d=>quoteIsStale(d));
      const info=updateAtInfo(s,anyStale,Math.max(15,currentPollingPolicy().marketMs/1000+5));
      $('updateAt').textContent=liveStore?.healthy()&&!anyStale?'推送连接正常':panelNetwork.retryAt('market')>Date.now()?'请求限流，稍后重试':lastPendingCount && !lastData.length && !lastErrorCount ? '等待首次报价' : info.text;
      $('updateAt').classList.toggle('stale',info.stale);
    }
  }
  function onBeat() {
    lastBeatAt = Date.now();   // 看门狗判定心跳存活的依据
    beatN++;
    liveStore?.reschedule();
    const policy=currentPollingPolicy();
    // Market traffic is exclusively owned by liveStore (SSE, or one fallback timer).
    if ((beatN-lastNewsBeat)*beat.ms>=policy.newsMs){lastNewsBeat=beatN;refreshNews();}
    if ((beatN-lastMacroBeat)*beat.ms>=policy.macroMs){lastMacroBeat=beatN;refreshMacro();}
  }
  let beatFallbackTimer = null;
  function startIntervalFallback() {   // 心跳回退: 主线程 interval(Worker 死亡/不可用时由看门狗或启动路径调用)
    if (beatFallbackTimer===null) beatFallbackTimer=setInterval(onBeat, beat.ms);
  }
  function startHeartbeat() {
    try {
      if (typeof Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const workerUrl=URL.createObjectURL(new Blob(['setInterval(function(){postMessage(1)},' + beat.ms + ')'], { type: 'text/javascript' }));
        try { beatWorker=new Worker(workerUrl); }
        finally { URL.revokeObjectURL?.(workerUrl); }
        beatWorker.onmessage = () => onBeat();
        const failWorker=()=>{
          try { beatWorker?.terminate(); } catch {}
          beatWorker=null; startIntervalFallback();
        };
        beatWorker.onerror=failWorker;
        beatWorker.onmessageerror=failWorker;
      }
    } catch (e) { beatWorker = null; }
    if (!beatWorker) startIntervalFallback();
  }
  function heartbeatMode() { return beatWorker ? 'worker' : 'interval'; }
  // 看门狗(WD): 主线程兜底自愈 —— Worker 被浏览器冻结/杀死、页面长冻恢复、任何原因的轮询停摆都在此收口
  // ① 心跳死亡: worker 模式 >beat.ms*6 无节拍 → 终止 worker 回退 interval(节拍恢复, lastBeatAt 重新推进)
  // ② 数据年龄: 可见且超过当前查询间隔及宽限仍无成功刷新且无在途 → 补刷
  // 隐藏时跳过(省电): 回前台由 visibilitychange 立即补刷 + 本看门狗下一拍接管
  function watchdogTick(nowMs) {
    const now = nowMs || Date.now();
    if (document.hidden) return 'hidden';
    if (heartbeatMode() === 'worker' && now - lastBeatAt > beat.ms * 6) {
      try { if (beatWorker) beatWorker.terminate(); } catch (e) {}
      beatWorker = null;
      startIntervalFallback();
    }
    if (!liveStore && !refreshInFlight && !marketInFlight && lastRefresh && now - lastRefresh > Math.max(30000,currentPollingPolicy().marketMs+5000)) { refresh(false); return 'refreshed'; }
    return 'ok';
  }
  function syncVisibility(){
    if(document.hidden&&refreshMode==='economy')liveStore?.pause();else liveStore?.resume();
  }
  function resumeQuotes(){quoteClock.resume();tickClock();syncVisibility();}
  document.addEventListener('visibilitychange',()=>{syncVisibility();if(!document.hidden){resumeQuotes();refreshNews();refreshMacro();}});
  window.addEventListener('pageshow',resumeQuotes);window.addEventListener('online',resumeQuotes);
  startHeartbeat();
  setInterval(watchdogTick, 5000);   // 看门狗: 主线程 5s 一拍(冻结恢复后立即可用)
  // 手动刷新按钮(顶栏 ↻): 立即全量拉取, 与自动心跳共用去重/缓存
  $('btnRefresh').addEventListener('click', () => { manualRefresh(); });
  watchlist.forEach(ensureCard);updateEmptyState();
  const displayTicker=window.PANEL_SCHEDULER.createDisplayTicker(tickClock);
  displayTicker.start();
  window.addEventListener('pagehide',()=>displayTicker.stop());
  window.addEventListener('pageshow',()=>displayTicker.start());
  liveStore=window.PANEL_LIVE_STORE.createLiveStore({getSymbols:()=>watchlist,getCv:cvParam,onHistory:applyHistories,onSamples:chartController.applySamples,
    readSnapshot:refresh,getPolicy:currentPollingPolicy,getRetryAt:()=>panelNetwork.retryAt('market'),onClock:value=>quoteClock.sync(value,quoteClock.monotonic()),
    onQuotes:arr=>{marketGeneration++;applyQuotes(arr);},onState:state=>{updateRefreshModeLabel(state);chartController.setSampleConnection(state==='streaming');}});
  window.addEventListener('pagehide',()=>liveStore.stop());
  syncVisibility();
  const sourcePanel=$('sourceHealth'),sourceText=$('sourceHealthContent');
  async function showSourceHealth(){
    if(!sourcePanel.open)return;
    sourceText.textContent='正在读取来源状态…';
    try{const response=await panelNetwork.request('sources','/api/sources',{cache:'no-store'});if(!response.ok)throw new Error();const data=await response.json();
      const labels={cooldown:'冷却中',probing:'恢复探测',requesting:'读取中',ready:'可读取',streaming:'已接收成交',subscribing:'等待订阅或首笔成交',connecting:'连接中',backoff:'等待重连',blocked:'权限或配置受限',idle:'空闲',stopped:'已停止','website-polling':'网站批量报价'};
      const rows=Object.entries(data.hosts||{}).map(([host,v])=>host+'：'+(labels[v.state]||v.state)+'；实际请求 '+v.calls+'；429 '+v.rateLimits+(v.retryAt?'；'+new Date(v.retryAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 后可重试':''));
      for(const [source,v] of Object.entries(data.fundamentals?.sources||{})){
        rows.push('基础资料 '+source+'：'+(v.tracked||0)+' 只证券；补充中 '+(v.inflight||0)+'；失败 '+(v.failed||0)+'（详细诊断仅管理员可见）');
      }
      const streams=data.stream?.primary||data.stream?.backup?[['主流',data.stream.primary],['备流',data.stream.backup]]:[['行情流',data.stream]];
      for(const [name,v] of streams)if(v)rows.unshift(name+'：'+(labels[v.status]||v.status||'未启用')+(v.errorCode?'（'+v.errorCode+'）':''));
      sourceText.textContent=rows.join('\n')||'尚未向上游发起请求';
    }catch{sourceText.textContent='暂时无法读取状态，请稍后重试。';}
  }
  sourcePanel.addEventListener('toggle',()=>{if(sourcePanel.open)void showSourceHealth();});
  $('sourceHealthRefresh').addEventListener('click',showSourceHealth);
  // ---- 测试钩子: 浏览器无副作用(未注册钩子时为空操作), 供 tests/_test_*.mjs 沙箱提取内部函数 ----
  if (typeof window !== 'undefined' && typeof window.__PANEL_TEST_HOOK__ === 'function') {
    window.__PANEL_TEST_HOOK__({
      shouldPoll, updateAtInfo, quoteIsStale, updateQuoteMeta, flash, render, renderNews, runSearch, addToWatch, refresh, refreshNews, refreshMacro,
      maSeries:PANEL.maSeries, cardCache, lastDataRef: () => lastData, lastRefreshRef: () => lastRefresh,
      onBeat, tickClock, heartbeatMode, beat,
      setRefreshMode,refreshModeRef:()=>refreshMode,currentPollingPolicy,
      setCardCurrency, intradayCacheRef: () => intradayCache, daily30CacheRef: () => daily30Cache,   // T1/T5 沙箱观测
      manualRefresh, watchdogTick, lastBeatAtRef: () => lastBeatAt, refreshInFlightRef: () => refreshInFlight,   // 手动刷新+看门狗沙箱观测
      lastRefreshSet: (v) => { lastRefresh = v; },   // 测试时间旅行: 把 lastRefresh 拨到指定时刻(仅测试钩子)
    });
  }
})();
