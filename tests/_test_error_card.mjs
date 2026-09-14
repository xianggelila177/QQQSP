// T6 错误卡片状态 —— vm 沙箱行为测试
// 契约:
//   A. 含 error 的响应不再静默丢弃: 已有卡片的符号 → 卡片加 class fetch-error + state chip 文本「拉取失败」
//   B. 下一次成功 → 自动移除 fetch-error, chip 文案恢复市场状态
//   C. 不属于当前自选的错误符号忽略(不建卡)
//   D. style.css 含 .fetch-error 样式(细红边)
import { loadApp } from './_harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };

const cssSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');

const mkQ = (sym, extra = {}) => ({
  symbol: sym, price: 480, change: 1.2, changePct: 0.25,
  open: 479, dayHigh: 482, dayLow: 477, prevClose: 478.8,
  volume: 3131131, week52High: 620, week52Low: 210,
  marketState: 'REGULAR', currency: 'USD', name: 'X',
  charts: { intraday: [{ t: Math.floor(Date.now() / 1000) - 30, c: 480, v: 900 }] },
  ...extra,
});

try {
  ok(/\.price-card\.fetch-error/.test(cssSrc), 'D1 style.css 含 .price-card.fetch-error 样式');

  const env = await loadApp({ watchlist: ['QQQ'] });
  await env.drain();
  const H = () => env.hooks();

  // 先建立正常卡片
  env.fetch.push('market', { body: [mkQ('QQQ')] });
  await H().refresh(false);
  await env.drain();
  const q = H().cardCache.get('QQQ');
  ok(!!q && !q.el.classList.contains('fetch-error'), 'A0 正常响应无 fetch-error class');

  // 错误响应 → 卡片标记失败态
  env.fetch.push('market', { body: [{ symbol: 'QQQ', error: 'upstream 429' }] });
  await H().refresh(false);
  await env.drain();
  ok(q.el.classList.contains('fetch-error'), 'A1 错误响应 → 已有卡片加 fetch-error class');
  ok(q.state.textContent === '拉取失败 · 交易中', "A2 state chip 文本「拉取失败」(实际: " + q.state.textContent + ")");
  ok(!q.state.classList.contains('open'), 'A3 失败态 chip 无 open(交易中)样式类');
  ok(H().lastDataRef().length === 1 && !H().lastDataRef()[0].error && H().lastDataRef()[0].price === q.d.price, 'A4 保留上一条有效报价，不把错误对象写入摘要');

  // 下一次成功 → 自动移除
  env.fetch.push('market', { body: [mkQ('QQQ')] });
  await H().refresh(false);
  await env.drain();
  ok(!q.el.classList.contains('fetch-error'), 'B1 恢复成功 → fetch-error class 自动移除');
  ok(q.state.textContent === '交易中', 'B2 chip 文案恢复市场状态(实际: ' + q.state.textContent + ')');

  // 非当前自选符号 → 忽略不建卡（QQQ 仍有有效响应）
  env.fetch.push('market', { body: [mkQ('QQQ'), { symbol: 'NOPE', error: 'unknown symbol' }] });
  await H().refresh(false);
  await env.drain();
  ok(!H().cardCache.get('NOPE'), 'C1 无卡片错误符号不建卡');
  ok(H().cardCache.get('QQQ') && !H().cardCache.get('QQQ').el.classList.contains('fetch-error'), 'C2 其他卡片不受波及');

  // 交替: 成功→错误→成功 循环稳定
  for (const bad of [false, true, false]) {
    env.fetch.push('market', { body: bad ? [{ symbol: 'QQQ', error: 'x' }] : [mkQ('QQQ')] });
    await H().refresh(false);
    await env.drain();
  }
  ok(!q.el.classList.contains('fetch-error'), 'C3 成功→错误→成功 循环后状态干净');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T6 error_card] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
