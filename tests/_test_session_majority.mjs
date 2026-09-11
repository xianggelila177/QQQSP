// P2-7: updateSession 应取多数卡的市场状态(多数决, 平票取先出现),
// 而不是 forEach 取最后一张卡(最后一张 CLOSED 会盖住多数 REGULAR)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail));
  if (!ok) fails++;
};

function extractFn(src, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('fn not found: ' + name);
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }   // 含函数头: 从 async function NAME( 签名起切片
  }
  throw new Error('brace mismatch: ' + name);
}

let fnBody = '';
try { fnBody = extractFn(appSrc, 'updateSession'); } catch (e) { check('提取 updateSession', false, String(e)); }

if (fnBody) {
  const els = {};
  const $ = (id) => (els[id] ||= { id, textContent: '', className: '' });
  const window = {};
  vm.runInNewContext(readFileSync(join(here, '..', 'public', 'modules', 'panel-state.js'), 'utf8'), {window});
  const updateSession = new Function('$', 'window', fnBody + '\nreturn updateSession;')($, window);

  // 区分性用例: 旧实现取最后一张(CLOSED)会误报已收盘; 多数决必须显示交易中
  updateSession([{ marketState: 'REGULAR' }, { marketState: 'REGULAR' }, { marketState: 'CLOSED' }]);
  check('[REGULAR,REGULAR,CLOSED] 显示"交易中"(多数决, 非取最后)', els.session.textContent === '市场 交易中', '实际 ' + JSON.stringify(els.session.textContent));
  check('多数为 REGULAR 时高亮 ours-open', /ours-open/.test(els.session.className), '实际 ' + JSON.stringify(els.session.className));

  updateSession([{ marketState: 'REGULAR' }, { marketState: 'CLOSED' }, { marketState: 'REGULAR' }]);
  check('[REGULAR,CLOSED,REGULAR] 显示"交易中"(多数决)', els.session.textContent === '市场 交易中', '实际 ' + JSON.stringify(els.session.textContent));
  check('多数为 REGULAR 时高亮 ours-open', /ours-open/.test(els.session.className), '实际 ' + JSON.stringify(els.session.className));

  updateSession([]);
  check('空数组回落 已收盘', els.session.textContent === '市场 已收盘', JSON.stringify(els.session.textContent));

  updateSession([{ marketState: 'PRE' }]);
  check('单卡照常显示 盘前', els.session.textContent === '市场 盘前', JSON.stringify(els.session.textContent));

  updateSession([null, { marketState: 'BREAK' }, { marketState: 'BREAK' }]);
  check('空项不计票 [null,BREAK,BREAK]→午间休市', els.session.textContent === '市场 午间休市', JSON.stringify(els.session.textContent));

  updateSession([{ marketState: 'CLOSED' }, { marketState: 'PRE' }]);
  check('平票取先出现(CLOSED)', els.session.textContent === '市场 已收盘', JSON.stringify(els.session.textContent));
}

console.log(fails ? ('RESULT: FAIL (' + fails + ')') : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
