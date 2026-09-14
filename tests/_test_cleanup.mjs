// tests/_test_cleanup.mjs — 镜像废弃清理防回归测试 (node tests/_test_cleanup.mjs)
// 2026-09-04 清理: server.js 的全量手工镜像 _server_testable.mjs 与根目录旧 scratch
// 测试 _test_cnsnap.mjs/_test_search.mjs 已移入 archive/(镜像因 archive/ 内已有同名旧件,
// 归档名带时间戳前缀 20260904_143606__server_testable.mjs)。
// 说明: 原计划 tests/ 下应有同名 _test_cnsnap/_test_search(不依赖镜像), 磁盘实际无同名
// 文件 —— cnsnap/search 覆盖已由 _test_us_fallback/_test_chart_sources/_test_search_race
// 等经 __upstream.impl 接缝直连 server.js 承担。故此处断言更强的防回归不变量:
// 全 tests/ 目录零镜像引用。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail));
  if (!ok) fails++;
};

// [A] 根目录不再有镜像与 scratch 三件套
for (const f of ['_server_testable.mjs', '_test_cnsnap.mjs', '_test_search.mjs']) {
  check('根目录无 ' + f, !existsSync(join(root, f)));
}

// [B] Historical archive material is optional in a source-only checkout.
// Ordinary tests must not download or require old snapshots.
if (existsSync(join(root, 'archive'))) {
  check('archive/ exists when supplied', true);
} else {
  console.log('NOT RUN | historical archive checks (optional release artifact absent)');
}

// [C] tests/ 零镜像引用(回归套件只扫 tests/, 不得再依赖镜像; 排除本文件自身)
const testsDir = join(root, 'tests');
const offenders = readdirSync(testsDir)
  .filter((f) => f !== '_test_cleanup.mjs' && /\.(mjs|sh)$/.test(f))
  .filter((f) => readFileSync(join(testsDir, f), 'utf8').includes('_server_testable'));
check('tests/ 无 _server_testable 引用', offenders.length === 0, offenders.join(','));

// [D] 镜像废弃后 server.js 是唯一事实源, 语法必须完好
let syntaxOk = true, syntaxErr = '';
try {
  execSync('node --check ' + JSON.stringify(join(root, 'server.js')), { stdio: 'pipe' });
} catch (e) {
  syntaxOk = false;
  syntaxErr = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
}
check('node --check server.js 通过', syntaxOk, syntaxErr);

console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
