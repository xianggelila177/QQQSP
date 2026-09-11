// Frontend audit regressions owned by the browser worker.
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || !detail ? '' : ' | ' + detail)); };
const q = (symbol, extra = {}) => ({
  symbol, price: 123.45, change: 1.25, changePct: 1.02, open: 122, dayHigh: 125, dayLow: 120,
  prevClose: 122.2, volume: 1000, week52High: 150, week52Low: 80, marketState: 'REGULAR',
  currency: 'USD', exchangeName: 'TEST', charts: { intraday: [{ t: 10, o: 122, h: 125, l: 120, c: 123.45, v: 10 }], daily30: [] }, ...extra,
});

try {
  const env = await loadApp({ watchlist: ['QQQ', 'SPY', 'AAPL'] }); await env.drain(); const H = () => env.hooks();

  // Q01: singleton API payloads are accepted during rollout compatibility.
  env.fetch.push('market', { body: q('QQQ') });
  const singleton = await H().refresh(false); await env.drain();
  ok(singleton.ok && H().cardCache.has('QQQ'), 'Q01 singleton market response creates one card');

  // Q02/Q03: index points stay points and missing FX stays missing.
  env.fetch.push('market', { body: [q('SPY', { instrumentType: 'INDEX', currency: 'USD', price: 20000, charts: { intraday: [{ t: 11, c: 20000, v: 1 }], daily30: [] } }), q('AAPL')] });
  await H().refresh(false); await env.drain();
  const idx = H().cardCache.get('SPY'), stock = H().cardCache.get('AAPL');
  ok(idx && idx.unit.textContent === '点' && idx.cur.textContent === '20,000.00', 'Q02 index displays points without currency conversion');
  H().setCardCurrency('AAPL', 'CNY');
  ok(stock && stock.unit.textContent === 'USD' && stock.cur.textContent === '123.45', 'Q03 absent FX keeps original amount and unit');

  // Q05/Q06: a same-timestamp content change invalidates the redraw signature;
  // an empty period clears the prior plot and slider state.
  const chartCard = H().cardCache.get('QQQ'); const firstSig = chartCard._sig;
  env.fetch.push('market', { body: [q('QQQ', { intradayVer: 7, charts: { intraday: [{ t: 10, o: 122, h: 126, l: 120, c: 123.45, v: 99 }], daily30: [] } })] });
  await H().refresh(false); await env.drain();
  ok(chartCard._sig !== firstSig, 'Q05 same timestamp with OHLCV mutation redraws');
  env.fetch.push('market', { body: [q('QQQ', { charts: { intraday: [], daily30: [] } })] });
  await H().refresh(false); await env.drain();
  ok(chartCard.plot === null && chartCard.slider.hidden, 'Q06 empty chart clears old plot and controls');

  // Q14: refreshes share one in-flight market request.
  const deferred = { body: [q('QQQ')], defer: true }; env.fetch.push('market', deferred);
  const n = env.countFetch('/api/market'); const p1 = H().refresh(false); const p2 = H().refresh(false);
  ok(env.countFetch('/api/market') === n + 1, 'Q14 concurrent refreshes issue one request');
  deferred.deferred.resolve(); await p1; await p2; await env.drain();

  // Q24/Q33: dismissal invalidates a response and unsafe URLs become text.
  const slow = env.fetch.push('search', { body: [{ symbol: 'OLD', name: 'old', market: '美股', exch: 'X' }], defer: true });
  env.byId('q').value = 'old'; const search = H().runSearch();
  env.byId('q').value = ''; env.byId('q')._handlers.input[0](); slow.resolve(); await search; await env.drain();
  ok(env.byId('sresults').hidden, 'Q24 clearing search hides and invalidates old results');
  const nq = H().cardCache.get('QQQ'); H().renderNews(nq, [{ t: 1, title: 'bad', link: 'javascript:alert(1)', src: 'x' }]);
  ok(nq.newslist.children.length===1&&!nq.newslist.children[0].href&&nq.newslist.children[0].innerHTML.includes('bad')&&!nq.newslist.children[0].innerHTML.includes('javascript:'), 'Q33 rejects unsafe news URL protocols and retains article text');

  // Q26: failed manual refresh cannot report success.
  env.fetch.push('market', { status: 500, body: [] });
  const before = env.doc.body.children.length; await H().manualRefresh(); await env.drain();
  const messages = env.doc.body.children.slice(before).map(x => x.textContent || '').join('|');
  ok(messages.includes('手动刷新失败') && !messages.includes('已刷新'), 'Q26 failed manual refresh reports failure only');

  // Partial quote failure is not a full-success refresh.
  env.fetch.push('market', { body: [q('QQQ'), { symbol: 'SPY', error: 'upstream 429' }] });
  const partialBefore = env.doc.body.children.length; await H().manualRefresh(); await env.drain();
  const partialMsg = env.doc.body.children.slice(partialBefore).map(x => x.textContent || '').join('|');
  ok(partialMsg.includes('部分刷新失败') && !partialMsg.includes('已刷新'), 'Q26 partial quote failure avoids full-success toast');

  // A first response containing only per-symbol errors still creates visible cards.
  const errEnv = await loadApp({ watchlist: ['QQQ', 'SPY'] }); await errEnv.drain();
  errEnv.fetch.push('market', { body: [{ symbol: 'QQQ', error: 'unavailable' }, { symbol: 'SPY', error: 'unavailable' }] });
  await errEnv.hooks().refresh(false); await errEnv.drain();
  ok(errEnv.hooks().cardCache.get('QQQ')?.el.classList.contains('fetch-error') && errEnv.hooks().cardCache.get('SPY')?.el.classList.contains('fetch-error'), 'Q26 first-load errors create visible failed cards');

  // A stalled news client is bounded by the same manual-refresh deadline.
  const stall = await loadApp(); await stall.drain();
  stall.fetch.push('market', { body: [q('QQQ')] }); stall.fetch.push('news', { body: {}, defer: true });
  const stalled = stall.hooks().manualRefresh();
  for (const timer of stall.timers.all.values()) if (timer.kind === 'timeout' && timer.ms === 20000 && !timer.cleared) timer.fn();
  await stalled; await stall.drain();
  const stallMsg = stall.doc.body.children.map(x => x.textContent || '').join('|');
  ok(stallMsg.includes('手动刷新失败') && !stallMsg.includes('已刷新'), 'Q14 manual refresh deadline aborts stalled news');

  // Q25/Q27/Q28/Q30/Q31/Q37/Q38: state, controls, indicators, accessibility,
  // field clearing and real module decomposition remain behaviorally visible.
  for (let i = 0; i < 10; i++) H().addToWatch('T' + i, 'test');
  ok(H().addToWatch('OVER', 'test') === false && !H().cardCache.has('OVER'), 'Q25 twelve-card cap blocks ghost cards');
  H().setCardCurrency('QQQ', 'CNY');
  const qqq = H().cardCache.get('QQQ');
  ok(qqq.ccybtns.some(b => b.dataset.ccy === 'CNY' && b.classList.contains('on')) && !qqq.ccybtns.find(b => b.dataset.ccy === 'USD').classList.contains('on'), 'Q27 selected currency drives control state');
  const bars = [{ c: 1 }, { c: 2 }, { c: 3 }, { c: 4 }, { c: 5 }, { c: 6 }];
  ok(H().maSeries(bars, 5)[5] === 4, 'Q28 MA uses complete history independent of visible window');
  ok(String(env.byId('panels')._insertedHTML.join('')).includes('role="img"') && String(env.byId('panels')._insertedHTML.join('')).includes('chart-summary'), 'Q30 chart has accessible equivalent text hook');
  await env.drain();
  env.fetch.push('market', { body: [q('QQQ', { open: null, dayHigh: null, dayLow: null, prevClose: null, week52High: null, week52Low: null })] });
  await H().refresh(false); await env.drain();
  ok(qqq.open.textContent === '—' && qqq.high.textContent === '—' && qqq.w52h.textContent === '—', 'Q31 missing quote fields clear prior values');
} catch (e) { fails.push('exception: ' + e.message); console.log('  ✗ exception:', e.stack || e.message); }

console.log('[AUDIT FRONTEND] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
