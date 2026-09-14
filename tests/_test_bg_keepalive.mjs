// BG-KEEPALIVE 后台标签页心跳续播 —— RED 阶段测试
// 问题: 标签页转入后台后, 面板停止更新(P0-2 门闸 + Chrome 密集节流主线程定时器至 1/min),
//       用户切回前台时面对长时间前的陈数据 + 冷启动刷新。
// 目标契约:
//   1. 启动时创建 Web Worker 心跳(Worker 定时器不受后台节流影响), heartbeatMode()==='worker'
//   2. 隐藏时心跳节拍继续驱动: 时钟每拍走字, 行情/新闻每 5 拍(5s)各拉一次, 宏观每 120 拍
//   3. 前台节拍: 行情/新闻每 2 拍(2s)一次
//   4. visibilitychange 回前台仍立即补刷(行情+新闻+宏观)
//   5. 无 Worker 环境回退 setInterval(1000) + shouldPoll 门闸(隐藏暂停, 省电降级)
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '✓ ' : '✗ ') + name); };

try {
  // ===== 场景A: 隐藏启动 + Worker 心跳 =====
  const env = await loadApp({ hidden: true, fakeWorker: true, refreshMode:'continuous' });
  await env.drain();

  const mkt0 = env.countFetch('/api/market');
  const news0 = env.countFetch('/api/news');
  const macro0 = env.countFetch('/api/macro');
  ok(mkt0 === 1 && news0 === 1 && macro0 === 1, `启动即各拉一次(market=${mkt0} news=${news0} macro=${macro0})`);

  ok(env.workers.length === 1, '创建了 1 个心跳 Worker(实际: ' + env.workers.length + ')');
  ok(typeof env.hooks()?.onBeat === 'function', '暴露 onBeat() 心跳函数');
  ok(env.hooks()?.heartbeatMode?.() === 'worker', 'heartbeatMode() === "worker"(实际: ' + env.hooks()?.heartbeatMode?.() + ')');
  const beat = env.hooks()?.beat || {};
  ok(beat.ms === 1000 && beat.visEvery === 2 && beat.hidEvery === 2 && beat.macroEvery === 120,
    '节拍常量 {ms:1000, visEvery:2, hidEvery:2, macroEvery:120}(实际: ' + JSON.stringify(beat) + ')');

  const emit = () => env.workers.forEach(w => w.emit(1));
  emit(); await env.drain();
  ok(env.countFetch('/api/market') === mkt0, '第1秒未到报价节拍');
  emit(); await env.drain();
  ok(env.countFetch('/api/market') === mkt0+1, '后台第2秒行情刷新');
  ok(env.countFetch('/api/news') === news0, '新闻不跟随2s行情请求');
  for (let i=3;i<=120;i++) {emit();await env.drain();}
  ok(env.countFetch('/api/market') === mkt0+60, '后台120秒共60轮行情');
  ok(env.countFetch('/api/news') === news0+2, '后台120秒共2轮新闻');
  ok(env.countFetch('/api/macro') === macro0+1, '后台120秒共1轮宏观');

  // ===== 场景B: 切回前台 → 立即补刷 + 恢复 2s 节拍 =====
  env.doc.hidden = false;
  const mktV = env.countFetch('/api/market'), newsV = env.countFetch('/api/news'), macroV = env.countFetch('/api/macro');
  env.fireDoc('visibilitychange');
  await env.drain();
  ok(env.countFetch('/api/market') === mktV + 1, 'visibilitychange 回前台: 行情立即补刷');
  ok(env.countFetch('/api/news') === newsV + 1, 'visibilitychange 回前台: 新闻立即补刷');
  ok(env.countFetch('/api/macro') === macroV + 1, 'visibilitychange 回前台: 宏观立即补刷');

  emit(); await env.drain(); emit(); await env.drain();   // 前台 2 拍 = 2s 节拍
  ok(env.countFetch('/api/market') === mktV + 2, '前台 2 拍: 行情 +1(2s 节拍恢复)');

  // ===== 场景C: 无 Worker 回退 → setInterval(1000) + 隐藏门闸 =====
  const env2 = await loadApp({ hidden: true, refreshMode:'continuous' });
  await env2.drain();
  ok(env2.workers.length === 0, '回退场景: 无 Worker 实例');
  ok(env2.hooks()?.heartbeatMode?.() === 'interval', '回退 heartbeatMode() === "interval"(实际: ' + env2.hooks()?.heartbeatMode?.() + ')');
  ok(env2.timers.intervals(1000).length === 1, '回退注册 1 个 1000ms 节拍 interval(实际: ' + env2.timers.intervals(1000).length + ')');
  const m2 = env2.countFetch('/api/market');
  for (let i = 0; i < 10; i++) { for (const t of env2.timers.intervals(1000)) t.fn(); await env2.drain(); }
  await env2.drain();
  ok(env2.countFetch('/api/market') === m2+5, '回退+隐藏: 10秒5轮行情');
  env2.doc.hidden = false;
  for (let i = 0; i < 2; i++) { for (const t of env2.timers.intervals(1000)) t.fn(); await env2.drain(); }
  await env2.drain();
  ok(env2.countFetch('/api/market') === m2 + 6, '回退+前台: 2 拍恢复行情 +1');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('✗ exception:', e.message);
}

console.log('[BG-KEEPALIVE bg_keepalive] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
