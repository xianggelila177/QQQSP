// P1-Q1 前端用后端 market 字段 —— RED 阶段测试
// 断言: render 优先使用后端 d.market; 缺失时显示未核验(d.symbol, isIdx) 本地推断。
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };

const now = Math.floor(Date.now() / 1000);
const mkQuote = (sym, extra = {}) => ({
  symbol: sym, price: 48000, change: 120, changePct: 0.25,
  open: 47900, dayHigh: 48200, dayLow: 47700, prevClose: 47880,
  volume: 3131131, week52High: 62000, week52Low: 21000,
  marketState: 'REGULAR', currency: 'USD', name: 'X',
  charts: { intraday: [{ t: now - 30, o: 47950, h: 48050, l: 47900, c: 48000, v: 900 }] },
  ...extra,
});

try {
  const env = await loadApp({ watchlist: ['000660.KQ', 'AAPL', '^KS11'] });
  // Let the production bootstrap request settle before injecting the fixture;
  // refresh() now deliberately single-flights concurrent market requests.
  await env.drain();
  env.fetch.push('market', { body: [
    mkQuote('000660.KQ', { market: '韩股(KOSDAQ)', name: 'SK Hynix 9세대' }),   // 后端精确值 ≠ mktOf 的 '韩股KQ'
    mkQuote('AAPL'),                                                            // 无 market → 回落本地推断
    mkQuote('^KS11', { instrumentType: 'INDEX' }),                              // 指数回落 idxRegionOf
  ] });
  await env.hooks().refresh(false);
  await env.drain();

  const cc = env.hooks().cardCache;
  const kq = cc.get('000660.KQ');
  ok(kq && kq.mkttag.textContent === '韩股(KOSDAQ)', "后端 market 字段优先: 显示'韩股(KOSDAQ)' (实际: " + (kq && kq.mkttag.textContent) + ")");
  ok(kq && kq.mkttag.textContent !== '韩股KQ', "不再是 mktOf 推断的'韩股KQ'");
  ok(kq && kq.mkttag.dataset.mkt === '韩股(KOSDAQ)', 'data-mkt 同步为后端值');

  const aapl = cc.get('AAPL');
  ok(aapl && aapl.mkttag.textContent === '市场未核验', '无 market 字段 → 显示未核验而非猜测市场');

  const idx = cc.get('^KS11');
  ok(idx && idx.mkttag.textContent === '市场未核验', '指数无 market → 显示未核验而非猜测指数市场');

  // 空串/空值同样走回落
  env.fetch.push('market', { body: [mkQuote('AAPL', { market: '' })] });
  await env.hooks().refresh(false);
  await env.drain();
  ok(cc.get('AAPL').mkttag.textContent === '市场未核验', 'market="" 视同缺失 → 显示未核验');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P1-Q1 market_field_front] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
