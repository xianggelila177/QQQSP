// tests/_test_news_ttl.mjs — P0-1 新闻轮转器新鲜门回归测试
// 问题: 轮转周期(2s×8符号=16s) > 旧15s门 → 几乎每次轮到某符号都真跑 newsFor(~8-10次/20s)
// 期望: 门改为真 NEWS_TTL(≥540000ms=9min); 未超TTL绝不重抓; 超TTL必须重抓
process.env.PORT = '0';   // 随机端口, 避免与开发实例冲突

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };

async function main() {
  const S = await import('../server.js');

  // ---- 打桩: 上游空响应兜底 + newsFor 计数 ----
  S.__upstream.impl = async () => ({ status: 200, headers: {}, body: '' });
  const calls = [];
  S.__impl.newsFor = async (sym) => { calls.push({ sym }); return [{ t: Date.now(), src: 'T', title: 'title ' + sym, link: 'https://example.com/' + sym }]; };

  console.log('[T1] NEWS_TTL 导出且 ≥ 9min');
  check('NEWS_TTL ≥ 540000', typeof S.NEWS_TTL === 'number' && S.NEWS_TTL >= 540000, 'NEWS_TTL=' + S.NEWS_TTL);

  console.log('[T2] 8符号×20s轮转: 缓存60s前(>旧15s门, <新9min TTL)不应触发重抓');
  {
    const now = Date.now();
    const SYMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
    for (const s of SYMS) {
      S.__test.activeSyms.set(s, now);
      S.__test.newsCache.set(s, { items: [], ts: now - 60000 });   // 60s前: 旧15s门视为过期(重抓=BUG复现), 新9min门视为新鲜
    }
    // 10次tick = 2s轮转节奏 × 10 ≈ 20s 窗口(时间差由预置缓存ts表达, 不实际等待)
    for (let i = 0; i < 10; i++) await S.newsRotatorTick();
    check('newsFor ≤ 2 次(而非~8-10)', calls.length <= 2, 'calls=' + calls.length + ' ' + JSON.stringify(calls.map(c => c.sym)));
  }

  console.log('[T3] 缓存超9min必须刷新, 且只刷一次');
  {
    calls.length = 0;
    S.__test.activeSyms.clear();
    S.__test.activeSyms.set('OLDSYM', Date.now());
    S.__test.newsCache.set('OLDSYM', { items: [], ts: Date.now() - (typeof S.NEWS_TTL === 'number' ? S.NEWS_TTL : 540000) - 1000 });
    await S.newsRotatorTick();
    check('超TTL触发恰好1次刷新', calls.length === 1, JSON.stringify(calls));
    await S.newsRotatorTick();
    check('刷新后不再重复抓', calls.length === 1, 'calls=' + calls.length);
  }
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
