(() => {
  const createSearchController = ({ qEl, srEl, document, network: panelNetwork, client: PANEL, esc, onSelect }) => {
  let sTimer = null;
  let composing = false;
  let searchReqId = 0;   // P1-U2: 搜索请求代际号, 丢弃过期响应
  let searchController = null;
  let searchIndex = -1;
  const hideSearch = (clear = false) => {
    searchReqId++;
    if (searchController) { try { searchController.abort(); } catch {} searchController = null; }
    clearTimeout(sTimer); searchIndex = -1; srEl.hidden = true; srEl.innerHTML = ''; qEl.setAttribute('aria-expanded', 'false');
    qEl.setAttribute('aria-activedescendant', '');
    if (clear) qEl.value = '';
  };
  async function runSearch() {
    const myId = ++searchReqId;   // P1-U2
    const v = qEl.value.trim(); if (!v) { hideSearch(); return 0; }
    if (searchController) { try { searchController.abort(); } catch {} }
    searchController = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const r = await panelNetwork.request('search', '/api/search?q=' + encodeURIComponent(v), { replace: true, signal: searchController?.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = PANEL.normalizeList(await r.json());
      if (myId !== searchReqId) return;   // P1-U2: 已有更新的搜索, 本次过期响应直接丢弃
      srEl.innerHTML = (list && list.length)
        ? list.map((x, i) => '<div class="sitem" role="option" tabindex="-1" id="sitem-' + i + '" data-sym="' + esc(x.symbol) + '" data-name="' + esc(x.name) + '"><span class="mkttag" data-mkt="' + esc(x.market) + '">' + esc(x.market) + '</span><b>' + esc(x.symbol) + '</b><span class="sname">' + esc(x.name) + '</span><span class="stype">' + ({INDEX:'指数',ETF:'ETF',EQUITY:'股票'}[x.type] || '证券') + '</span><span class="sexch">' + esc(x.exch) + '</span></div>').join('')
        : '<div class="sempty">无结果，可尝试完整代码或展开全球市场目录，如 富时100 / VOD.L / M&amp;M.NS</div>';
      srEl.hidden = false;
      qEl.setAttribute('aria-expanded', 'true'); searchIndex = -1;
      return list.length;
    } catch (e) { if (myId !== searchReqId) return 0; srEl.innerHTML = '<div class="sempty">搜索失败，请稍后重试</div>'; srEl.hidden = false; qEl.setAttribute('aria-expanded', 'true'); return 0; }
  }
  qEl.addEventListener('input', () => {
    if (composing) return;                       // IME 组合中: 不触发中间查询
    hideSearch();
    const v = qEl.value.trim();
    if (!v) return;
    sTimer = setTimeout(runSearch, 300);
  });
  qEl.addEventListener('compositionstart', () => { composing = true; hideSearch(); });
  qEl.addEventListener('compositionend', () => { composing = false; clearTimeout(sTimer); runSearch(); });   // 中文候选确认后立即联想, 并清掉挂起的防抖(P1-U2)
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...srEl.querySelectorAll('.sitem')]; if (!items.length || srEl.hidden) return;
      e.preventDefault(); searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((x, i) => x.setAttribute('aria-selected', String(i === searchIndex)));
      const selected = items[searchIndex]; if (selected) { selected.scrollIntoView({ block: 'nearest' }); qEl.setAttribute('aria-activedescendant', selected.id); }
      return;
    }
    if (e.key !== 'Enter' || e.isComposing || composing) return;    // 忽略IME确认用的回车
    e.preventDefault();
    const items = srEl.querySelectorAll('.sitem');
    if (!srEl.hidden && items.length && searchIndex >= 0) { items[searchIndex].click(); return; }
    if (!srEl.hidden && items.length === 1) { items[0].click(); return; }   // 唯一结果直接加入自选
    runSearch();
  });
  srEl.addEventListener('click', (e) => {
    const it = e.target.closest('.sitem'); if (!it || !it.dataset.sym) return;
    const sym = it.dataset.sym.toUpperCase();
    onSelect(sym, it.querySelector('.sname') ? it.querySelector('.sname').textContent : '');
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.searchwrap')) hideSearch(); });
  // 键盘: "/"聚焦搜索框, Esc收起联想并清空(终端式交互, 借鉴 openmarket KeyboardShortcuts)
  document.addEventListener('keydown', (e) => {
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea';
    if (e.key === '/' && !typing) { e.preventDefault(); try { qEl.focus(); qEl.select(); } catch {} }
    else if (e.key === 'Escape') { if (!srEl.hidden || (typing && qEl.value)) hideSearch(typing); }
  });

    return Object.freeze({ runSearch, hideSearch });
  };
  window.PANEL_SEARCH_CONTROLLER = Object.freeze({ createSearchController });
})();
