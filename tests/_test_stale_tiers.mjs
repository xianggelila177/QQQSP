// T2 stale 徽标分级 —— vm 沙箱行为测试
// 契约:
//   A. staleInfo.reason='rate-limited' → 「上游限流」(+ etaMs>0 时「·约Ns后恢复」倒计时), title 写详细原因
//   B. staleInfo.reason='cooldown' → 「数据延迟·自动重试中」, title 写详细原因
//   C. 无 staleInfo 但 d.stale(旧后端) → 保持「数据延迟」
//   D. 无任何 stale 标记 → 徽标隐藏; 恢复后隐藏; etaMs=0 → 无倒计时段
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };

const mkQ = (sym, extra = {}) => ({
  symbol: sym, price: 480, change: 1.2, changePct: 0.25,
  open: 479, dayHigh: 482, dayLow: 477, prevClose: 478.8,
  volume: 3131131, week52High: 620, week52Low: 210,
  marketState: 'REGULAR', currency: 'USD', name: 'X',
  charts: { intraday: [{ t: Math.floor(Date.now() / 1000) - 30, c: 480, v: 900 }] },
  ...extra,
});

try {
  const env = await loadApp();
  await env.drain();
  const H = () => env.hooks();
  const refreshWith = async (extra) => {
    env.fetch.push('market', { body: [mkQ('QQQ', extra)] });
    await H().refresh(false);
    await env.drain();
  };

  // A. rate-limited + etaMs>0
  await refreshWith({ stale: true, staleInfo: { reason: 'rate-limited', etaMs: 30000 } });
  let w = H().cardCache.get('QQQ').staleWarn;
  ok(w.hidden === false, 'A1 限流徽标可见');
  ok(w.textContent === '上游限流·约30s后重试', "A2 文案改为「上游限流·约30s后重试」(不承诺恢复, 实际: " + w.textContent + ")");
  ok(String(w.title).includes('限流') && String(w.title).includes('30'), 'A3 title 写详细原因(含限流与恢复秒数)', w.title);

  // D3. etaMs=0 → 无倒计时段
  await refreshWith({ stale: true, staleInfo: { reason: 'rate-limited', etaMs: 0 } });
  ok(w.textContent === '上游限流', "A4 etaMs=0 → 文案「上游限流」无倒计时(实际: " + w.textContent + ")");

  // B. cooldown
  await refreshWith({ stale: true, staleInfo: { reason: 'cooldown' } });
  ok(w.textContent === '数据延迟·自动重试中', "B1 文案「数据延迟·自动重试中」(实际: " + w.textContent + ")");
  ok(String(w.title).includes('重试'), 'B2 title 写详细原因(含自动重试)', w.title);

  // C. 旧后端兼容: 只有 d.stale
  await refreshWith({ stale: true });
  ok(w.hidden === false && w.textContent === '数据延迟', "C1 无 staleInfo 但 d.stale → 保持「数据延迟」(实际: " + w.textContent + ")");
  ok(String(w.title).includes('延迟'), 'C2 title 仍有详细原因', w.title);

  // D. 恢复 → 隐藏
  await refreshWith({});
  ok(w.hidden === true, 'D1 无 stale 标记 → 徽标隐藏');

  // E. 与 updateAt 联动: staleInfo 也计入 anyStale(顶栏维持 T2 语义)
  await refreshWith({ staleInfo: { reason: 'cooldown' } });
  for (const t of env.timers.intervals(1000)) t.fn();
  const ua = env.byId('updateAt');
  ok(ua.textContent.includes('延迟'), 'E1 staleInfo 存在时顶栏维持延迟文案(实际: ' + ua.textContent + ')');
  ok(!ua.textContent.includes('实时'), 'E2 顶栏不显示「实时」');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T2 stale_tiers] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
