// TDD 测试(P1-Q5): 前端资源版本号必须有单一来源 panel/VERSION 且处处一致
// 覆盖: public/sw.js(const VERSION + CACHE 模板) / public/index.html(?v= x4 + 来源注释)
//       / public/app.js(sw.js?v=) / build_version.sh 升版演练
import { readFileSync, mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pub = path.join(root, 'public');
let pass = 0, fail = 0;
const ok = (m) => { console.log('PASS: ' + m); pass++; };
const no = (m) => { console.log('FAIL: ' + m); fail++; };
const assert = (cond, m) => (cond ? ok(m) : no(m));

let vFile = null;
try { vFile = readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch {}
assert(vFile !== null && /^\d+$/.test(vFile || ''), 'VERSION 文件存在且为纯数字(实际=' + JSON.stringify(vFile) + ')');
const N = vFile;

if (N !== null) {
  const sw = readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const mSw = sw.match(/const\s+VERSION\s*=\s*'v(\d+)'\s*;/);
  assert(!!mSw, "sw.js 顶部定义 const VERSION='vNN'");
  if (mSw) assert(mSw[1] === N, "sw.js VERSION=v" + mSw[1] + " 与 VERSION 文件 " + N + " 一致");
  assert(!/'qqq-panel-v\d+'/.test(sw), "sw.js 无硬编码 'qqq-panel-vNN' 字面量(CACHE 必须由 VERSION 拼接)");
  assert(/const\s+CACHE\s*=\s*'qqq-panel-'\s*\+\s*VERSION/.test(sw), "CACHE = 'qqq-panel-' + VERSION");

  const html = readFileSync(path.join(pub, 'index.html'), 'utf8');
  const vs = [...html.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
  assert(vs.length >= 4, "index.html 含 >=4 处 ?v= 引用(实际 " + vs.length + ")");
  assert(vs.every((v) => v === N), "index.html 全部 ?v= 等于 " + N);
  assert(/build_version\.sh|panel\/VERSION/.test(html), "index.html 有版本源注释(build_version.sh/panel/VERSION)");

  const app = readFileSync(path.join(pub, 'app.js'), 'utf8');
  const mApp = app.match(/sw\.js\?v=(\d+)/);
  assert(!!mApp && mApp[1] === N, "app.js 的 sw.js?v= 等于 " + N);

  // 升版演练: 复制到临时目录, VERSION+1 后跑 build_version.sh, 三处都应同步
  let tmp;
  try {
    const M = String(Number(N) + 1);
    tmp = mkdtempSync(path.join(tmpdir(), 'ver_t_'));
    mkdirSync(path.join(tmp, 'panel', 'scripts'), { recursive: true });
    mkdirSync(path.join(tmp, 'panel', 'lib'), { recursive: true });
    for (const file of ['VERSION', 'build_version.sh', 'config.js', 'package.json']) cpSync(path.join(root, file), path.join(tmp, 'panel', file));
    cpSync(path.join(root, 'lib'), path.join(tmp, 'panel', 'lib'), {recursive:true});
    for (const file of ['version.mjs','build-context-docs.mjs','build-detail-docs.mjs','build.mjs','build-static.mjs','precompress.mjs','env-example.mjs']) cpSync(path.join(root,'scripts',file),path.join(tmp,'panel','scripts',file));
    cpSync(pub, path.join(tmp, 'panel', 'public'), { recursive: true });
    writeFileSync(path.join(tmp, 'panel', 'VERSION'), M + '\n');
    execSync('bash build_version.sh', { cwd: path.join(tmp, 'panel'), stdio: 'pipe' });
    const sw2 = readFileSync(path.join(tmp, 'panel', 'public', 'sw.js'), 'utf8');
    const html2 = readFileSync(path.join(tmp, 'panel', 'public', 'index.html'), 'utf8');
    const app2 = readFileSync(path.join(tmp, 'panel', 'public', 'app.js'), 'utf8');
    const swOk = new RegExp("const VERSION = 'v" + M + "'").test(sw2);
    const htmlVs = [...html2.matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
    const appM = (app2.match(/sw\.js\?v=(\d+)/) || [])[1];
    assert(swOk && htmlVs.length >= 4 && htmlVs.every((v) => v === M) && appM === M,
      "build_version.sh 把 " + M + " 同步到了 sw.js/index.html/app.js");
  } catch (e) {
    no('build_version.sh 演练失败: ' + ((e && e.message) || e));
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}

console.log('---- _test_version: pass=' + pass + ' fail=' + fail + ' ----');
process.exit(fail ? 1 : 0);
