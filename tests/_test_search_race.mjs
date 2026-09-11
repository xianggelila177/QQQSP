// P1-U2 搜索竞态 —— RED 阶段测试
// 断言: (a) 两次 runSearch 交错完成时, 过期(先发后至)响应被丢弃, 最终显示最后一次查询的结果;
//       (b) compositionend 后 clearTimeout(sTimer), 不再让挂起的防抖定时器重复触发。
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };

try {
  // ---- 场景A: 慢请求 A 与 快请求 B 交错, B 先返回 ----
  const env = await loadApp();
  const dA = env.fetch.push('search', { defer: true, body: [{ symbol: 'SLOW', name: 'slow-A', market: '美股', exch: 'X' }] });
  const dB = env.fetch.push('search', { defer: true, body: [{ symbol: 'FAST', name: 'fast-B', market: '美股', exch: 'Y' }] });

  const qEl = env.byId('q'), srEl = env.byId('sresults');
  qEl.value = 'a';
  const pA = env.hooks().runSearch();          // 发出慢请求
  qEl.value = 'ab';
  const pB = env.hooks().runSearch();          // 发出快请求(用户继续输入)

  dB.resolve();                                 // 快请求先到
  await env.drain();
  const afterFast = srEl.innerHTML;
  ok(afterFast.includes('FAST') && !afterFast.includes('SLOW'), '快结果先渲染 (实际: ' + (afterFast.includes('FAST') ? 'FAST' : '?') + ')');

  dA.resolve();                                 // 慢请求后到 —— 必须被丢弃
  await pA.catch(() => {}); await pB.catch(() => {});
  await env.drain();
  ok(srEl.innerHTML.includes('FAST') && !srEl.innerHTML.includes('SLOW'),
    '慢的过期响应到达后被丢弃, 最终仍是 FAST (实际: ' + (srEl.innerHTML.includes('SLOW') ? '被 SLOW 覆盖!' : 'FAST') + ')');

  // ---- 场景B: 输入防抖挂起时 compositionend 立即搜索并清掉 sTimer ----
  const env2 = await loadApp();
  const q2 = env2.byId('q');
  env2.fetch.push('search', { body: [{ symbol: 'IME', name: 'ime', market: 'A股', exch: 'SS' }] });
  q2.value = '测试';
  q2._handlers['input'][0]();                   // input → 安排 300ms 防抖 runSearch
  const pending = [...env2.timers.all.values()].find(t => t.kind === 'timeout' && !t.cleared && t.ms === 300);
  ok(!!pending && pending.ms === 300, 'input 后挂起 300ms 防抖定时器');

  q2._handlers['compositionend'][0]();          // IME 候选确认
  ok(!!pending && pending.cleared === true, 'compositionend 清除挂起的 sTimer');
  await env2.drain();
  ok(env2.countFetch('/api/search') >= 1, 'compositionend 立即发起搜索');

  // 防抖定时器即使被误触发也不产生第二次过期渲染(已被 clear)
  const before = env2.countFetch('/api/search');
  if (pending && !pending.cleared) { pending.fn(); }
  ok(env2.countFetch('/api/search') === before || pending.cleared, 'sTimer 已失效, 不会二次搜索');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P1-U2 search_race] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
