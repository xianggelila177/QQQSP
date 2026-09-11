// P2-8: 自选列表截断方向必须统一 —— 两处都保留先添加的(截头 slice(0, 12))。
// 装载路径 slice(0,12) vs addToWatch 的 slice(-12) 双写会导致"重启后自选换血"。
import { loadApp } from './_harness.mjs';

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail));
  if (!ok) fails++;
};

const env = await loadApp({ watchlist: Array.from({ length: 12 }, (_, i) => 'S' + (i + 1)) });
await env.drain();
const added = env.hooks().addToWatch('S13', 'thirteenth');
check('添加第 13 个被拒绝', added === false, String(added));
check('达到上限时不创建幽灵卡片', !env.hooks().cardCache.has('S13'), 'cardCache contains S13');

console.log(fails ? ('RESULT: FAIL (' + fails + ')') : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
