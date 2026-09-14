// TDD 测试(P2 颜色统一): canvas 的 UP/DOWN 必须与 CSS --up/--down 同源同值
// 历史: app.js '#d63b3b'/'#1a8f4e' != style.css '--up:#e0393e; --down:#0ea55e'
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (m) => { console.log('PASS: ' + m); pass++; };
const no = (m) => { console.log('FAIL: ' + m); fail++; };
const assert = (c, m) => (c ? ok(m) : no(m));

const app = readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

const mA = app.match(/const\s+UP\s*=\s*'(#[0-9a-fA-F]{6})'\s*,\s*DOWN\s*=\s*'(#[0-9a-fA-F]{6})'\s*;/);
assert(!!mA, 'app.js 定义 const UP/DOWN 十六进制常量');
const rootCss = (css.match(/:root\{[\s\S]*?\}/) || [''])[0];
const mUp = rootCss.match(/--up\s*:\s*(#[0-9a-fA-F]{6})/);
const mDown = rootCss.match(/--down\s*:\s*(#[0-9a-fA-F]{6})/);
assert(!!mUp && !!mDown, 'style.css :root 定义 --up/--down');

if (mA && mUp && mDown) {
  assert(mA[1].toLowerCase() === mUp[1].toLowerCase(),
    'UP 一致: app=' + mA[1] + ' css=' + mUp[1]);
  assert(mA[2].toLowerCase() === mDown[1].toLowerCase(),
    'DOWN 一致: app=' + mA[2] + ' css=' + mDown[1]);
}

// 旧配色字面量不得残留在前端任何文件
import { readdirSync, statSync } from 'node:fs';
const stale = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html)$/.test(f)) {
      const t = readFileSync(p, 'utf8');
      if (/#d63b3b|#1a8f4e/i.test(t)) stale.push(path.relative(root, p));
    }
  }
};
walk(path.join(root, 'public'));
assert(stale.length === 0, '无旧配色残留(#d63b3b/#1a8f4e)' + (stale.length ? ' -> ' + stale.join(',') : ''));

console.log('---- _test_color: pass=' + pass + ' fail=' + fail + ' ----');
process.exit(fail ? 1 : 0);
