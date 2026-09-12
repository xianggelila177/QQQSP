// P0-3 前端不消费 stale —— RED 阶段测试
// 断言: d.stale=true 的卡片渲染后有琥珀色"数据延迟"徽标(chip stale-warn);
//       任一卡 stale 时 updateAt 显示"部分延迟"并带 stale class;
//       "连接正常"仅在无 stale 时出现。
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };

const now = Math.floor(Date.now() / 1000);
const mkQuote = (sym, extra = {}) => ({
  symbol: sym, price: 48000, change: 120, changePct: 0.25,
  open: 47900, dayHigh: 48200, dayLow: 47700, prevClose: 47880,
  volume: 3131131, week52High: 62000, week52Low: 21000,
  marketState: 'REGULAR', currency: 'USD', name: 'SK Hynix',
  charts: { intraday: [{ t: now - 30, o: 47950, h: 48050, l: 47900, c: 48000, v: 900 }] },
  ...extra,
});

try {
  // 场景1: 后端返回 stale:true
  const env = await loadApp({ watchlist: ['000660.KS'] });
  await env.drain();
  env.fetch.push('market', { body: [mkQuote('000660.KS', { stale: true })] });
  await env.hooks().refresh(false);
  await env.drain();

  const q = env.hooks().cardCache.get('000660.KS');
  ok(!!q, '卡片已创建');
  ok(q && q.staleWarn && q.staleWarn.hidden === false, 'stale 卡的延迟徽标可见(stale-warn 未隐藏)');
  const panels = env.byId('panels');
  ok((panels._insertedHTML || []).some(h => h.includes('class="chip stale-warn"')), '卡片模板含 class="chip stale-warn" 徽标');
  ok((panels._insertedHTML || []).some(h => h.includes('stale-warn" hidden>数据延迟')), '徽标文案为"数据延迟"(模板)');

  env.hooks().tickClock();   // 时钟 tick 驱动 updateAt
  const ua = env.byId('updateAt');
  ok(ua.textContent.includes('延迟'), 'updateAt 文案含"延迟"(实际: ' + ua.textContent + ')');
  ok(!ua.textContent.includes('连接正常'), '有 stale 时不再显示"连接正常"(实际: ' + ua.textContent + ')');
  ok(ua.classList.contains('stale'), 'updateAt 带 stale class');

  if (typeof env.hooks().updateAtInfo === 'function') {
    ok(env.hooks().updateAtInfo(0, true).text.includes('延迟'), 'updateAtInfo(s=0,stale=true) → 延迟文案');
    ok(env.hooks().updateAtInfo(0, false).text === '连接正常', 'updateAtInfo(s=0,stale=false) → 连接正常');
    ok(String(env.hooks().updateAtInfo(30, false).text).includes('更新于'), 'updateAtInfo(s=30,stale=false) → 更新于 Ns 前');
  } else {
    ok(false, '暴露 updateAtInfo() 纯函数');
  }

  // 场景2: 数据恢复正常(无 stale 字段)
  env.fetch.push('market', { body: [mkQuote('000660.KS')] });
  await env.hooks().refresh(false);
  await env.drain();
  env.hooks().tickClock();
  ok(!!q.staleWarn && q.staleWarn.hidden === true, '恢复后徽标隐藏');
  ok(env.byId('updateAt').textContent === '连接正常', '无 stale 且新鲜 → 显示"连接正常"(实际: ' + env.byId('updateAt').textContent + ')');
  ok(!env.byId('updateAt').classList.contains('stale'), '无 stale 新鲜 → 无 stale class');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P0-3 stale_display] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
