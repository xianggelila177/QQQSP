// TDD 测试(P2 对比度): --down 绿跌色在白底卡片与页面底色上都必须达到 WCAG AA(>=4.5:1)
// 历史: --down:#0ea55e 对白底约 3.2:1, 不达标; 加深为 #0a7d47 约 5.2:1
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (m) => { console.log('PASS: ' + m); pass++; };
const no = (m) => { console.log('FAIL: ' + m); fail++; };

const css = readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const rootCss = (css.match(/:root\{[\s\S]*?\}/) || [''])[0];
const hexOf = (name) => (rootCss.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{6})')) || [])[1];

const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (hex) => {
  const h = hex.replace('#', '');
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
};
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)); };

const down = hexOf('down'), panel = hexOf('panel') || '#ffffff', bg = hexOf('bg') || '#ffffff';
if (!down || !panel || !bg) { no('style.css :root 缺少 --down/--panel/--bg 定义'); }
else {
  const rPanel = ratio(down, panel), rBg = ratio(down, bg);
  console.log('INFO: --down=' + down + ' vs panel(' + panel + ')=' + rPanel.toFixed(2) + ':1, vs bg(' + bg + ')=' + rBg.toFixed(2) + ':1');
  (rPanel >= 4.5 ? ok : no)('--down 对面板底 ' + panel + ' 对比度 >= 4.5:1 (实际 ' + rPanel.toFixed(2) + ':1)');
  (rBg >= 4.5 ? ok : no)('--down 对页面底 ' + bg + ' 对比度 >= 4.5:1 (实际 ' + rBg.toFixed(2) + ':1)');
}

console.log('---- _test_contrast: pass=' + pass + ' fail=' + fail + ' ----');
process.exit(fail ? 1 : 0);
