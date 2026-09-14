// T-manual+watchdog: 手动刷新按钮 + 心跳死亡自愈看门狗 + 大龄人性化
// 用户报告: 面板显示「更新于 50000 s 前」且不再自动更新(Worker 死亡/页面冻结恢复后无人补刷),
// 只能干等。契约:
//   A. 顶栏手动刷新按钮: 点击 → market 拉取 + 成功 flash「已刷新」; 在途时 spinning 防重入
//   B. watchdogTick: worker 模式下 >6s 无节拍 → 杀 worker 回退 interval 模式(心跳自愈)
//   C. watchdogTick: 可见且 >30s 无成功刷新且无在途 → 强制补刷(数据年龄自愈)
//   D. 隐藏时看门狗不动作(省电, 回前台由 visibilitychange+看门狗接管)
//   E. 大龄人性化: 50000s → 「更新于 13.9 小时前」(替代不可读的秒数)
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };
const drain = (e) => new Promise(r => setImmediate(r));

const mkQuote = (sym, extra = {}) => ({
  symbol: sym, price: 480, change: 1.2, changePct: 0.25,
  open: 479, dayHigh: 482, dayLow: 477, prevClose: 478.8,
  volume: 3131131, week52High: 620, week52Low: 210,
  marketState: 'REGULAR', currency: 'USD', name: 'X', ts: Date.now(),
  charts: { intraday: [{ t: Math.floor(Date.now() / 1000) - 30, c: 480, v: 900 }] }, ...extra,
});

async function main() {
  const env = await loadApp({ hidden: false, fakeWorker: true, watchlist: ['QQQ'] });
  await drain(env);
  const H = () => env.hooks();
  const clickRefresh = () => (env.byId('btnRefresh')._handlers.click || []).forEach(fn => fn({}));
  const bodyTexts = () => env.doc.body.children.map(c => c.textContent || '');

  // ===== A. 手动刷新按钮 =====
  console.log('[A] 手动刷新');
  env.fetch.push('market', { body: [mkQuote('QQQ')] });
  const n0 = env.countFetch('/api/market');
  clickRefresh();
  await drain(env); await drain(env);
  ok(env.countFetch('/api/market') === n0 + 1, '点击按钮触发 market 拉取', 'n=' + env.countFetch('/api/market') + '/' + n0);
  ok(bodyTexts().some(t => t === '已刷新'), '成功后 flash「已刷新」', JSON.stringify(bodyTexts()));
  ok(!env.byId('btnRefresh').classList.contains('spinning'), '成功后不在途(spinning 移除)', String(env.byId('btnRefresh').className));

  console.log('[A2] 在途防重入');
  const deferredItem = { body: [mkQuote('QQQ')], defer: true };
  env.fetch.push('market', deferredItem);   // 挂起响应
  clickRefresh();
  ok(env.byId('btnRefresh').classList.contains('spinning'), '在途时 spinning 激活', String(env.byId('btnRefresh').className));
  clickRefresh();                                                       // 二次点击应被防重入忽略
  const n1 = env.countFetch('/api/market');
  clickRefresh();
  ok(env.countFetch('/api/market') === n1, '防重入: 在途期间不再发新请求', 'n=' + env.countFetch('/api/market') + '/' + n1);
  deferredItem.deferred.resolve();                                      // 放行
  await drain(env); await drain(env);
  ok(!env.byId('btnRefresh').classList.contains('spinning'), '完成后 spinning 移除', String(env.byId('btnRefresh').className));

  // ===== B. 心跳死亡自愈 =====
  console.log('[B] 看门狗自愈');
  ok(H().heartbeatMode() === 'worker', '初始 worker 模式', H().heartbeatMode());
  const ivBefore = env.timers.intervals(1000).length;
  H().watchdogTick(Date.now() + 7000);                                  // 7s 无节拍(>6s 阈值)
  ok(H().heartbeatMode() === 'interval', 'worker 无节拍 → 被终止并回退 interval', H().heartbeatMode());
  ok(env.timers.intervals(1000).length === ivBefore + 1, '回退注册 1s 心跳 interval', 'iv=' + env.timers.intervals(1000).length + '/' + ivBefore);

  // ===== C. 数据年龄自愈 =====
  console.log('[C] 数据年龄自愈');
  H().lastDataRef().push({ symbol: 'QQQ', ts: Date.now() - 40000, price: 480 });   // 最旧符号 40s
  H().lastRefreshSet(Date.now() - 40000);              // lastRefresh 同步拨旧(测试时间旅行, 生产由 refresh 成功时更新)
  const n2 = env.countFetch('/api/market');
  const verdict = H().watchdogTick(Date.now());
  await drain(env);
  ok(env.countFetch('/api/market') === n2 + 1 && verdict === 'refreshed', '>30s 无成功刷新 → 强制补刷', 'n=' + env.countFetch('/api/market') + '/' + n2 + ' v=' + verdict);
  const n3 = env.countFetch('/api/market');
  H().watchdogTick(Date.now());
  await drain(env);
  ok(env.countFetch('/api/market') === n3, '补刷后年龄重置 → 不再重复补刷', 'n=' + env.countFetch('/api/market') + '/' + n3);

  // ===== D. 隐藏不动作 =====
  console.log('[D] 隐藏不动作');
  H().lastDataRef().length = 0;
  H().lastDataRef().push({ symbol: 'QQQ', ts: Date.now() - 40000 });
  env.doc.hidden = true;
  const n4 = env.countFetch('/api/market');
  const v = H().watchdogTick(Date.now());
  ok(v === 'hidden' && env.countFetch('/api/market') === n4, '隐藏时看门狗跳过(不拉取)', 'v=' + v);
  env.doc.hidden = false;

  // ===== E. 大龄人性化 =====
  console.log('[E] 大龄人性化');
  const info = H().updateAtInfo;
  ok(info(50000, false).text === '更新于 13.9 小时前', '50000s → 「更新于 13.9 小时前」', JSON.stringify(info(50000, false)));
  ok(info(50000, false).stale === true, '50000s 置 stale', String(info(50000, false).stale));
  ok(info(30, false).text.includes('更新于 30'), '90s 内保持秒数文案(旧契约)', JSON.stringify(info(30, false)));
}

main().then(() => { console.log('\n[MANUAL REFRESH + WATCHDOG] ' + pass + ' pass / ' + fails.length + ' fail'); process.exit(fails.length ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
