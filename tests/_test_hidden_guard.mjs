// P0-2 后台门闸(回退路径) —— BG-KEEPALIVE 后修订
// 新意图: 主路径为 Worker 心跳(隐藏续播, 见 _test_bg_keepalive.mjs);
//         本测试锁定无 Worker 回退路径的降级契约:
//         隐藏时节拍被 shouldPoll 门闸拦截(省电), 回前台 visibilitychange 立即补刷 + 节拍恢复。
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '✓ ' : '✗ ') + name); };

try {
  // 场景A: 隐藏状态启动(无 Worker → 回退 setInterval 节拍)
  const env = await loadApp({ hidden: true, refreshMode:'continuous' });
  await env.drain();

  ok(typeof env.hooks()?.shouldPoll === 'function', '暴露 shouldPoll() 门闸函数');
  ok(env.hooks()?.heartbeatMode?.() === 'interval', '无 Worker → heartbeatMode() === "interval"');

  const news0 = env.countFetch('/api/news');
  const macro0 = env.countFetch('/api/macro');
  const mkt0 = env.countFetch('/api/market');
  for (let i=0;i<10;i++) { for (const t of env.timers.intervals(1000)) t.fn(); await env.drain(); }
  ok(env.countFetch('/api/news') === news0, '10秒内新闻未到60秒间隔');
  ok(env.countFetch('/api/macro') === macro0, '10秒内宏观未到120秒间隔');
  ok(env.countFetch('/api/market') === mkt0+5, '隐藏fallback10秒轮询5次');

  ok(env.hooks()?.shouldPoll?.(true) === false, 'shouldPoll(hidden=true) === false');
  ok(env.hooks()?.shouldPoll?.(false) === true, 'shouldPoll(hidden=false) === true');

  // 场景B: 回前台 → 节拍恢复
  env.doc.hidden = false;
  for (let i = 0; i < 2; i++) for (const t of env.timers.intervals(1000)) t.fn();
  await env.drain();
  ok(env.countFetch('/api/news') === news0, '前台也保持新闻60秒节拍');

  const newsB = env.countFetch('/api/news');
  const macroB = env.countFetch('/api/macro');
  const mktB = env.countFetch('/api/market');
  env.fireDoc('visibilitychange');
  ok(env.countFetch('/api/news') > newsB, 'visibilitychange 回前台立即刷新 news');
  ok(env.countFetch('/api/macro') > macroB, 'visibilitychange 回前台立即刷新 macro');
  ok(env.countFetch('/api/market') > mktB, 'visibilitychange 保留原有行情立即刷新');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('✗ exception:', e.message);
}

console.log('[P0-2 hidden_guard] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
