// P1-U8 flash 消息变体 —— RED 阶段测试
// 断言: flash(msg, type) 支持 success/warn/error; 对应 class msg-success/msg-warn;
//       success → role="status", error/warn → role="alert"; 默认(无 type)保持 error 红色。
import fs from 'node:fs';
import path from 'node:path';
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };
const classes = (el) => String(el.className).split(/\s+/).filter(Boolean);

try {
  const env = await loadApp();
  await env.drain();

  // success
  env.hooks().flash('保存成功', 'success');
  let el = env.doc.body.children[env.doc.body.children.length - 1];
  ok(classes(el).includes('msg') && classes(el).includes('msg-success'), "success → 含 msg msg-success (实际: " + classes(el).join('.') + ")");
  ok(el.getAttribute('role') === 'status', "success → role=status");
  ok(el.textContent === '保存成功', '消息文案保留');

  // 默认 error(兼容旧调用)
  env.hooks().flash('加载失败');
  el = env.doc.body.children[env.doc.body.children.length - 1];
  ok(classes(el).includes('msg') && !classes(el).some(c => c.startsWith('msg-')), "默认无 type → 纯 msg(error 红) (实际: " + classes(el).join('.') + ")");
  ok(el.getAttribute('role') === 'alert', "默认 error → role=alert");

  // warn
  env.hooks().flash('注意风险', 'warn');
  el = env.doc.body.children[env.doc.body.children.length - 1];
  ok(classes(el).includes('msg-warn'), "warn → 含 msg-warn (实际: " + classes(el).join('.') + ")");
  ok(el.getAttribute('role') === 'alert', "warn → role=alert");

  // 非法 type 回落 error 样式
  env.hooks().flash('??', 'bogus');
  el = env.doc.body.children[env.doc.body.children.length - 1];
  ok(!classes(el).some(c => c.startsWith('msg-')) && el.getAttribute('role') === 'alert', '非法 type 回落 error');

  // CSS 变体规则存在
  const css = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'style.css'), 'utf8');
  ok(css.includes('.msg-success{background:#0a7d47}'), 'CSS 含 .msg-success{background:#0a7d47}');
  ok(css.includes('.msg-warn{background:#b26a00}'), 'CSS 含 .msg-warn{background:#b26a00}');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P1-U8 flash_variants] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
