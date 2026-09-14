// T8 flash 可关闭 —— vm 沙箱行为测试 + CSS 断言
// 契约:
//   A. flash 消息带右上角 × 关闭按钮(class msg-close, × 由 CSS ::after 渲染 → textContent 保持纯消息)
//   B. 点击 × → 消息立即 remove, 并 clearTimeout 自动关闭定时器(防重复触发)
//   C. 未手动关闭时 4s 自动 remove 兜底仍在
//   D. 旧变体契约不受影响(success/warn/error 样式与 role)
import { loadApp } from './_harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0; const fails = [];
const ok = (cond, name, detail = '') => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond || !detail ? '' : ' | ' + detail)); };

const cssSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'style.css'), 'utf8');

try {
  // ---- CSS 断言 ----
  ok(/\.msg \.msg-close\{position:absolute/.test(cssSrc), 'D1 CSS: .msg .msg-close 绝对定位右上角');
  ok(/\.msg \.msg-close::after\{content:"×"\}/.test(cssSrc), 'D2 CSS: × 由 ::after 渲染(不污染消息文本)');

  const env = await loadApp();
  await env.drain();
  const H = () => env.hooks();
  const inBody = (el) => env.doc.body.children.includes(el);

  // ---- A. 结构: 文本纯净 + 关闭按钮 ----
  const el = H().flash('保存成功', 'success');
  ok(inBody(el), 'A0 消息出现在 body');
  ok(el.textContent === '保存成功', 'A1 textContent 保持纯消息(× 不占字符, 实际: ' + JSON.stringify(el.textContent) + ')');
  const x = el.children[el.children.length - 1];
  ok(x && String(x.className).includes('msg-close'), 'A2 末尾子节点为 .msg-close 关闭按钮');
  ok(x.getAttribute('aria-label') === '关闭提示', 'A3 关闭按钮带 aria-label');
  ok(String(el.className).includes('msg-success'), 'A4 旧变体样式保留(success)');

  // ---- B. 点击 × → 立即 remove + clearTimeout ----
  (x._handlers.click || [])[0]();
  ok(!inBody(el) && el.parentNode == null, 'B1 点击 × 消息立即移除');
  let doubleFired = false;
  try { env.timers.runTimeouts(4000); } catch (e) { doubleFired = true; }
  ok(!doubleFired && !inBody(el), 'B2 手动关闭后自动定时器已 clear, 重复触发无害');

  // ---- C. 未手动关闭 → 4s 自动移除兜底 ----
  const el2 = H().flash('获取行情失败: HTTP 502');
  ok(inBody(el2) && el2.textContent === '获取行情失败: HTTP 502', 'C1 默认 error 变体文本/类不变');
  env.timers.runTimeouts(4000);
  ok(!inBody(el2), 'C2 4s 自动移除兜底仍生效');
  ok(String(el2.className).split(/\s+/).every(c => !c.startsWith('msg-')), 'C3 默认仍为纯 msg(error)类');

  // ---- D. 2.9 单条替换：前一条移除，关闭新消息不会复活旧消息 ----
  const a = H().flash('第一条', 'warn');
  const b = H().flash('第二条', 'success');
  ok(!inBody(a) && inBody(b), 'D1 后一条替换前一条，无重叠');
  const xb = b.children[b.children.length - 1];
  (xb._handlers.click || [])[0]();
  ok(!inBody(b) && !inBody(a), 'D2 关闭后一条，前一条不复活');
  env.timers.runTimeouts(4000);
  ok(!inBody(a), 'D3 已清理计时器不会复活消息');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.stack || e.message);
}

console.log('[T8 flash_close] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
