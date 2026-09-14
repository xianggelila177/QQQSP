// P2-3: sentiOf 不得在调用期重编译正则 —— RULES 必须模块级预编译并复用共享实例。
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail));
  if (!ok) fails++;
};

const RealRegExp = RegExp;
let ctorCalls = 0;
function CountingRegExp(...args) { ctorCalls++; return new RealRegExp(...args); }
CountingRegExp.prototype = RealRegExp.prototype;
globalThis.RegExp = CountingRegExp;                 // 打桩: 统计 RegExp 构造次数

let mod = null, impErr = null;
try { mod = await import('../sent.mjs'); } catch (e) { impErr = e; }

check('sent.mjs 可导入且导出 sentiOf', !!(mod && mod.sentiOf), String(impErr || '缺 sentiOf 导出'));

if (mod && mod.sentiOf) {
  const base = ctorCalls;                            // 基线取模块加载之后 → 只统计调用期构造
  for (let i = 0; i < 100; i++) {
    mod.sentiOf('Apple surges on strong earnings; another plunges on fraud probe 股价大涨');
    mod.sentiOf('业绩预增 利好');
    mod.sentiOf('no signal text 天气不错');
  }
  const delta = ctorCalls - base;
  globalThis.RegExp = RealRegExp;                    // 计数结束再还原
  check('调用 300 次 sentiOf 期间 RegExp 构造 ≤ 1 (实际 ' + delta + ')', delta <= 1, '调用期重编译仍在发生');

  // 语义回归: 重构不得改变打分结果
  const sem = [
    ['Nvidia surges to record high on strong earnings', '利好'],
    ['Company plunges on fraud probe, warns of layoffs', '利空'],
    ['今天天气不错', '中性'],
    ['股价大涨 创历史新高', '利好'],
    ['Stocks gain ground after rate cut', '利好'],
  ];
  for (const [txt, want] of sem) {
    const got = mod.sentiOf(txt);
    check('语义 "' + txt + '" → ' + want, got === want, '实际 ' + got);
  }
} else {
  globalThis.RegExp = RealRegExp;
}

console.log(fails ? ('RESULT: FAIL (' + fails + ')') : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
