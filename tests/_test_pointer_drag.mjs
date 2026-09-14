// T7 触摸拖拽统一 —— 源码断言 + vm 沙箱行为断言
// 契约:
//   A. 拖拽用 Pointer Events(pointerdown/pointermove/pointerup + setPointerCapture), 不再有 mousedown/window mousemove 拖拽
//   B. 保留 mousemove 十字光标
//   C. 行为: pointerdown→grabbing 光标; pointermove 平移窗口(winStart 变化, 越界钳制); pointerup→恢复 crosshair;
//      松开后/异 pointerId 的 move 不再平移; pointercancel 同样结束拖拽
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };


try {
  // ---- C. 行为断言 ----
  const env = await loadApp();
  await env.drain();
  const H = () => env.hooks();

  const now = Math.floor(Date.now() / 1000);
  const lineBars = Array.from({ length: 100 }, (_, i) => ({ t: now - (100 - i) * 60, c: 480 + i * 0.01, v: 900 }));
  env.fetch.push('market', { body: [{
    symbol: 'QQQ', price: 480.99, change: 1.2, changePct: 0.25, open: 479, dayHigh: 482, dayLow: 477,
    prevClose: 478.8, volume: 3131131, week52High: 620, week52Low: 210, marketState: 'REGULAR',
    currency: 'USD', name: 'X', charts: { intraday: lineBars },
  }] });
  await H().refresh(false);
  await env.drain();
  const q = H().cardCache.get('QQQ');
  ok(!!q && !!q.plot, 'C0 图表已渲染(q.plot 就绪)');
  ok(q.winStart === 20, 'C0b 初始窗口右对齐末端(follow-end, winStart=maxStart=20, 实际: ' + q.winStart + ')');

  const cv = q.cv;
  for(const event of ['pointerdown','pointermove','pointerup','pointercancel','mousemove']) ok(cv._handlers[event]?.length>0,'interaction registered: '+event);
  ok(!cv._handlers.mousedown,'mouse drag uses unified pointer events');
  const fire = (t, ev) => ((cv._handlers[t] || [])).forEach(fn => fn(ev));

  // 可见窗口 80 根 → slot = 928/80 = 11.6px; 100px ≈ 8.6 槽
  fire('pointerdown', { clientX: 900, pointerId: 7, pointerType: 'mouse', button: 0 });
  ok(cv.style.cursor === 'grabbing', 'C1 pointerdown → grabbing 光标');
  fire('pointermove', { clientX: 1000, pointerId: 7 });   // 右拖 +100px ≈ 8.6 槽 → winStart 20-8.6 ≈ 11(未到边界)
  ok(q.winStart === 11, 'C2 pointermove 平移窗口(winStart=11, 实际: ' + q.winStart + ')');
  fire('pointermove', { clientX: 1300, pointerId: 7 });   // 累计 +400px ≈ 34.5 槽 → round(-14.5) → 钳制左边界 0
  ok(q.winStart === 0, 'C2b 平移钳制左边界(winStart=0, 实际: ' + q.winStart + ')');
  fire('pointerup', { pointerId: 7 });
  ok(cv.style.cursor === 'crosshair', 'C3 pointerup → 恢复 crosshair');
  fire('pointermove', { clientX: 1500, pointerId: 7 });
  ok(q.winStart === 0, 'C4 松开后 pointermove 不再平移');

  fire('pointerdown', { clientX: 500, pointerId: 1, pointerType: 'touch' });
  fire('pointermove', { clientX: 100, pointerId: 999 });   // 异 pointerId: 忽略
  ok(q.winStart === 0, 'C5 异 pointerId 的 move 被忽略(触摸多点不串扰)');
  fire('pointercancel', { pointerId: 1 });
  ok(cv.style.cursor === 'crosshair', 'C6 pointercancel 结束拖拽');
  fire('pointermove', { clientX: 0, pointerId: 1 });
  ok(q.winStart === 0, 'C7 cancel 后不再平移');

  // 鼠标非左键不启动拖拽
  fire('pointerdown', { clientX: 500, pointerId: 2, pointerType: 'mouse', button: 2 });
  fire('pointermove', { clientX: 100, pointerId: 2 });
  ok(q.winStart === 0, 'C8 鼠标右键不启动拖拽');
  fire('pointerup', { pointerId: 2 });

  // 触摸左拖: -300px ≈ -25.9 槽 → round(25.9)=26 → 钳制 maxStart=20
  fire('pointerdown', { clientX: 500, pointerId: 3, pointerType: 'touch' });
  fire('pointermove', { clientX: 200, pointerId: 3 });
  ok(q.winStart === 20, 'C9 触摸左拖平移到右端并钳制 maxStart(winStart=20, 实际: ' + q.winStart + ')');
  fire('pointerup', { pointerId: 3 });
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T7 pointer_drag] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
