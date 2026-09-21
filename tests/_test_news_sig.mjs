// P1-U7 新闻列表签名跳过重建 —— RED 阶段测试
// 断言: renderNews 对相同标题签名的数据不重写 innerHTML(跳过重建);
//       数据变化时正常重建; 签名按标题计算(仅链接/时间戳变化不触发)。
import { loadApp } from './_harness.mjs';

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };

const n = (title, t, extra = {}) => ({ title, t:Date.now()-10000+t, link: 'https://example.test/news#' + t, src: 'S', sent: '中性', ...extra });
const now = Math.floor(Date.now() / 1000);
const mkQuote = (sym) => ({
  symbol: sym, price: 100, change: 1, changePct: 1,
  open: 99, dayHigh: 101, dayLow: 98, prevClose: 99, volume: 1000,
  week52High: 120, week52Low: 70, marketState: 'REGULAR', currency: 'USD', name: sym,
  charts: { intraday: [{ t: now - 30, o: 99, h: 100, l: 98, c: 100, v: 10 }] },
});

try {
  const env = await loadApp();
  await env.drain();
  env.fetch.push('market', { body: [mkQuote('QQQ'), mkQuote('SPY')] });   // 建两张默认卡
  await env.hooks().refresh(false);
  await env.drain();
  await env.drain();
  const q = env.hooks().cardCache.get('QQQ');
  ok(!!q && !!q.newslist, '默认自选卡与 newslist 就绪');

  const listA = [n('头条一', 2000), n('头条二', 1000)];
  const writes=card=>card.newslist.children.reduce((sum,node)=>sum+node._htmlWrites,0);
  const contents=card=>card.newslist.children.map(node=>node.innerHTML).join('');
  env.hooks().renderNews(q, listA);
  const before = writes(q), firstNodes=[...q.newslist.children];
  ok(q.newslist.children.length===2 && before===2, '首次渲染每条新闻一次');

  // 相同数据再渲染(模拟 2s 轮询) → 跳过
  env.hooks().renderNews(q, listA);
  ok(writes(q)===before && q.newslist.children[0]===firstNodes[0], '相同数据第二次渲染未重写任何新闻');

  // 乱序相同数据(排序后同签名) → 跳过
  env.hooks().renderNews(q, [listA[1], listA[0]]);
  ok(writes(q)===before, '乱序相同数据排序后同签名 → 跳过');

  // 新标题到达 → 重建
  env.hooks().renderNews(q, [n('突发新条目', 3000), ...listA]);
  ok(writes(q)===before+1 && firstNodes.every(node=>q.newslist.children.includes(node)), '新数据只新增一行且保留原行');

  // 链接是可见交互的一部分：同标题链接更正也必须重建
  const priorTop=q.newslist.children.find(node=>node.href?.endsWith('#3000'));
  env.hooks().renderNews(q, [n('突发新条目', 3000, { link: 'https://example.test/news#changed' }), n('头条一', 2000), n('头条二', 1000)]);
  ok(q.newslist.children.some(node=>node.href?.endsWith('#changed'))&&!q.newslist.children.includes(priorTop), '仅链接变化更新对应行的目标');

  // 标题保留，但目标链接必须更新。
  ok(contents(q).includes('突发新条目') && q.newslist.children.some(node=>node.href?.endsWith('#changed')), 'DOM 显示更正后的链接');

  // 不同卡片互不影响(每卡独立签名)
  const qSpy = env.hooks().cardCache.get('SPY');
  env.hooks().renderNews(qSpy, listA);
  const bSpy=writes(qSpy),spyNodes=[...qSpy.newslist.children];
  env.hooks().renderNews(qSpy, listA);
  ok(writes(qSpy)===bSpy&&spyNodes.every(node=>qSpy.newslist.children.includes(node)), 'SPY 卡独立签名: 首次写、二次跳过');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P1-U7 news_sig] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
