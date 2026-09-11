(() => {
  const TYPE_NAMES = Object.freeze({ INDEX: '指数', EQUITY: '股票', ETF: 'ETF' });
  const validInstrument = item => item && typeof item.symbol === 'string' && /^[A-Z0-9.&^=\-]{1,16}$/.test(item.symbol)
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 160 && Object.hasOwn(TYPE_NAMES, item.type);
  function validateCatalog(data) {
    if (data?.version !== 1 || !Array.isArray(data.markets) || !data.markets.length || data.markets.length > 64) throw new Error('Invalid market directory');
    const keys = new Set();
    for (const market of data.markets) {
      if (!market || !/^[a-z0-9-]{1,24}$/.test(market.key) || keys.has(market.key)
        || !['name', 'region', 'exchange', 'currency', 'timezone'].every(key => typeof market[key] === 'string' && market[key].length > 0 && market[key].length <= 160)
        || !Array.isArray(market.benchmarks) || !Array.isArray(market.examples)
        || market.benchmarks.length + market.examples.length > 24
        || ![...market.benchmarks, ...market.examples].every(validInstrument)) throw new Error('Invalid market entry');
      keys.add(market.key);
    }
    return data;
  }
  const createMarketDirectory = ({ document, root, status, retry, content, network, onSelect, getWatchlist }) => {
    let loaded = false, inFlight = null;
    const buttons = [];
    const element = (tag, className, text) => {
      const node = document.createElement(tag); if (className) node.className = className;
      if (text != null) node.textContent = text; return node;
    };
    function syncMembership() {
      const selected = new Set(getWatchlist());
      for (const { button, item } of buttons) {
        const present = selected.has(item.symbol), kind = TYPE_NAMES[item.type];
        button.classList.toggle('is-added', present);
        button.textContent = (present ? '已添加 · ' : '') + item.name + ' · ' + item.symbol + ' · ' + kind;
        button.setAttribute('aria-label', (present ? '查看已添加的 ' : '添加 ') + item.name + ' (' + item.symbol + ') ' + kind + (present ? '' : '到自选'));
      }
    }
    function instrumentButton(item) {
      const button = element('button', 'directory-instrument'); button.type = 'button'; button.dataset.symbol = item.symbol;
      button.addEventListener('click', () => {
        const existed = getWatchlist().includes(item.symbol);
        const accepted = onSelect(item.symbol, item.name);
        syncMembership();
        status.textContent = accepted ? item.name + (existed ? ' 已在自选，已定位到行情卡片' : ' 已加入自选，正在读取行情') : '未添加 ' + item.name + '，自选最多保留 12 只标的';
      });
      buttons.push({ button, item }); return button;
    }
    function render(data) {
      buttons.length = 0;
      const nodes = [], bySymbol = new Map();
      for (const market of data.markets) for (const item of [...market.benchmarks, ...market.examples]) bySymbol.set(item.symbol, item);
      const featured = Array.isArray(data.featured) ? [...new Set(data.featured)].map(symbol => bySymbol.get(symbol)).filter(Boolean) : [];
      if (featured.length) {
        const section = element('div', 'directory-featured'); section.setAttribute('aria-label', '重点指数');
        for (const item of featured) section.appendChild(instrumentButton(item));
        nodes.push(section);
      }
      const controls = element('div', 'directory-controls');
      const label = element('label', '', '浏览市场'); label.htmlFor = 'marketDirectoryFilter';
      const filter = element('select', 'directory-filter'); filter.id = 'marketDirectoryFilter';
      const all = element('option', '', '全部市场'); all.value = ''; filter.appendChild(all);
      for (const market of data.markets) { const option = element('option', '', market.region + ' · ' + market.name); option.value = market.key; filter.appendChild(option); }
      controls.appendChild(label); controls.appendChild(filter); nodes.push(controls);
      const grid = element('div', 'market-directory-grid'), sections = [];
      for (const market of data.markets) {
        const section = element('section', 'directory-market'); section.dataset.market = market.key;
        section.appendChild(element('h3', '', market.name + ' · ' + market.region));
        section.appendChild(element('p', 'directory-meta', market.exchange + ' · ' + market.currency + ' · ' + market.timezone));
        for (const item of [...market.benchmarks, ...market.examples]) section.appendChild(instrumentButton(item));
        if (typeof market.sourceNote === 'string' && market.sourceNote) section.appendChild(element('p', 'directory-note', market.sourceNote));
        sections.push(section); grid.appendChild(section);
      }
      filter.addEventListener('change', () => { for (const section of sections) section.hidden = !!filter.value && section.dataset.market !== filter.value; });
      nodes.push(grid); content.replaceChildren(...nodes); syncMembership();
      status.textContent = data.markets.length + ' 个市场 · 仅添加到自选后读取行情，公开来源可能延迟或缺少部分字段';
    }
    function load() {
      if (loaded) return Promise.resolve(true);
      if (inFlight) return inFlight;
      status.textContent = '正在加载全球市场目录…'; retry.hidden = true; content.setAttribute('aria-busy', 'true');
      inFlight = (async () => {
        try {
          const response = await network.request('directory', '/api/markets');
          if (!response.ok) throw new Error('Directory unavailable');
          render(validateCatalog(await response.json())); loaded = true; return true;
        } catch {
          status.textContent = '市场目录加载失败，可重试；现有自选行情不受影响'; retry.hidden = false; return false;
        } finally { content.setAttribute('aria-busy', 'false'); inFlight = null; }
      })();
      return inFlight;
    }
    root.addEventListener('toggle', () => { if (root.open) load(); });
    retry.addEventListener('click', load);
    return Object.freeze({ load, syncMembership });
  };
  window.PANEL_MARKET_DIRECTORY = Object.freeze({ createMarketDirectory });
})();
