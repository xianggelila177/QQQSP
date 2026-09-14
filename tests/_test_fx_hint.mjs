// T5 FX 汇率缺失提示 —— vm 沙箱行为断言 + 源码断言
// 契约: 请求USD/CNY换汇但所需汇率缺失时,
//       .unit 加 title="汇率暂缺或过期，显示原币"(显示值维持 '—'/原币, 数值逻辑不变);
//       原币与目标相同 / 汇率恢复 → 无 title
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
  // ---- 源码断言 ----
  ok(cssSrc.includes('汇率暂缺') === false, 'S3 CSS 未涉及该逻辑(纯 JS title)');

  const env = await loadApp();
  await env.drain();
  const H = () => env.hooks();

  // KRW→USD也需要汇率；缺失时明确保留原币，而非误标美元。
  env.fetch.push('market', { body: [mkQ('QQQ', { currency: 'KRW', currency2cny: null, fxMap: { USD: 7.16 } })] });
  await H().refresh(false);
  await env.drain();
  let q = H().cardCache.get('QQQ');
  ok(q.unit.title === '汇率暂缺或过期，显示原币', 'A1 KRW→USD缺汇率时提示原币回退');
  ok(q.unit.textContent === 'KRW' && q.cur.textContent === '480.00', 'A1b 回退保留480韩元，不冒充美元');

  // 切 CNY 目标 → setCardCurrency 触发重渲染 → title 出现
  H().setCardCurrency('QQQ', 'CNY');
  ok(q.unit.title === '汇率暂缺或过期，显示原币', "A2 CNY 目标 + currency2cny 缺失 + 非CNY报价 → title 提示(实际: " + JSON.stringify(q.unit.title) + ")");

  // 汇率恢复 → title 清除
  env.fetch.push('market', { body: [mkQ('QQQ', { currency: 'KRW', currency2cny: 0.0052, fxMap: { USD: 7.16, KRW: 1400 } })] });
  await H().refresh(false);
  await env.drain();
  ok(q.unit.title === '', 'A3 currency2cny 恢复 → title 清空(实际: ' + JSON.stringify(q.unit.title) + ')');

  // CNY 报价本身 → 无需换算提示
  H().setCardCurrency('SPY', 'CNY');
  env.fetch.push('market', { body: [mkQ('SPY', { currency: 'CNY', currency2cny: null, fxMap: { USD: 7.16 } })] });
  await H().refresh(false);
  await env.drain();
  const spy = H().cardCache.get('SPY');
  ok(spy.unit.title === '', 'A4 CNY 报价 + CNY 目标 → 无 title(无需换算)');

  H().setCardCurrency('QQQ', 'USD');
  env.fetch.push('market', { body: [mkQ('QQQ', { currency: 'USD', currency2cny: null, fxMap: {} })] });
  await H().refresh(false); await env.drain();
  ok(q.unit.title === '' && q.unit.textContent === 'USD' && q.cur.textContent === '480.00', 'A4b USD→USD无汇率仍无需转换提示');
  H().setCardCurrency('QQQ', 'CNY');

  // 显示值维持 '—' 语义不变: fxMap 也缺失(无法换算)时价格列仍为占位, 不抛错
  env.fetch.push('market', { body: [mkQ('QQQ', { currency: 'XYZ', currency2cny: null })] });
  await H().refresh(false);
  await env.drain();
  ok(q.unit.title === '汇率暂缺或过期，显示原币' && typeof q.cur.textContent === 'string', "A5 完全无法换算 → title 提示且价格列占位不崩溃");
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T5 fx_hint] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
