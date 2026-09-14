// TDD 测试(P2): 触发按大小轮转后, 后续日志必须写入新文件(新 inode/fd), 且边界消息不得丢失
// 历史: emit() 先取流再 rotateIfNeeded(), 轮转把内部 stream end+置空后,
//       当条消息仍写给已 end 的旧流 -> 消息丢失 / fd 指向已改名的旧文件。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createTestSandbox} from './support/isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (m) => { console.log('PASS: ' + m); pass++; };
const no = (m) => { console.log('FAIL: ' + m); fail++; };

const sandbox=createTestSandbox(root);
const tmp = sandbox.path;
process.on('exit',()=>sandbox.cleanup());
const childEnv={...sandbox.env,LOG_FILE:path.join(tmp,'panel.log'),LOG_MAX_BYTES:'200',LOG_MAX_FILES:'2',LOG_LEVEL:'info'};
if(process.env.NODE_V8_COVERAGE)childEnv.NODE_V8_COVERAGE=process.env.NODE_V8_COVERAGE;
let out = '';
try {
  out = execFileSync(process.execPath, [path.join(here, '_test_log_rotate_child.mjs')], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    timeout: 15000,
  });
} catch (e) {
  no('子进程运行失败: ' + ((e && e.message) || e));
}

const cur = path.join(tmp, 'panel.log');
const rot1 = path.join(tmp, 'panel.log.1');
if (!existsSync(rot1)) no('未发生轮转(缺 panel.log.1)');
else ok('轮转发生: panel.log.1 已生成');

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const c1 = readIf(rot1), c2 = readIf(cur);
(c1.includes('ROTATE_FILLER') ? ok : no)('旧文件(panel.log.1)包含轮转前消息');
(c2.includes('ROTATE_MARKER_42') ? ok : no)('边界消息写入新文件 panel.log(修复点: 不再丢失/不写旧 fd)' +
  (c2.includes('ROTATE_MARKER_42') ? '' : ' -> 实际新文件内容行数=' + c2.trim().split('\n').filter(Boolean).length));
(c2.includes('AFTER_ROTATE') ? ok : no)('轮转后的常规写入落入新文件');
(c2.length < c1.length ? ok : no)('新文件从零开始(未被旧体积污染)');

console.log('---- _test_log_rotate: pass=' + pass + ' fail=' + fail + ' ----');
process.exit(fail ? 1 : 0);
