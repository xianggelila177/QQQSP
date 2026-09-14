import assert from 'node:assert/strict';
// tests/_test_rss_merge.mjs — P1-Q2 Google News RSS 解析公共函数回归测试
// 问题: googleNewsRSS 与 googleNewsTopic 各自内联一份几乎相同的 <item> 解析循环
// 期望: 提取 parseGoogleRss(body,{limit,withSource,kwFilter→accept,topic}) 公共函数, 两处调用;
//       两函数对同一份真实RSS片段的输出与合并前逐字段一致(黄金值对照)
process.env.PORT = '0';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '|', detail); } };

const XML = '<?xml version="1.0" encoding="UTF-8"?><rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel><title>"QQQ" - Google News</title>' +
  '<item><title><![CDATA[Apple surges to record high on strong earnings]]></title><link>https://news.google.com/rss/articles/abc1</link><pubDate>Mon, 24 Aug 2026 12:30:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>' +
  '<item><title>Fed cuts guidance; tech slides</title><link>https://news.google.com/rss/articles/def2</link><pubDate>Sun, 23 Aug 2026 08:00:00 GMT</pubDate><source>Bloomberg</source></item>' +
  '<item><title>无链接条目不进个股新闻</title><pubDate>Sat, 22 Aug 2026 10:00:00 GMT</pubDate></item>' +
  '<item><title><![CDATA[Apple dividend hike announced]]></title><link>https://news.google.com/rss/articles/ghi3</link><pubDate>Fri, 21 Aug 2026 16:45:00 GMT</pubDate><source>Reuters</source></item>' +
  '</channel></rss>';

const D = (s) => new Date(s).getTime();
const T1 = D('Mon, 24 Aug 2026 12:30:00 GMT'), T2 = D('Sun, 23 Aug 2026 08:00:00 GMT'), T3 = D('Sat, 22 Aug 2026 10:00:00 GMT'), T4 = D('Fri, 21 Aug 2026 16:45:00 GMT');

async function main() {
  const S = await import('../server.js');
  const { sentiOf } = await import('../sent.mjs');

  console.log('[T1] parseGoogleRss 公共函数: 默认收集原始条目');
  {
    const raw = S.parseGoogleRss(XML);
    check('导出且为函数', typeof S.parseGoogleRss === 'function', String(typeof S.parseGoogleRss));
    check('4条原始条目按文档序', raw.length === 4 && raw.map(x => x.t).join() === [T1, T2, T3, T4].join(), JSON.stringify(raw));
    check('CDATA已剥离', raw[0].title === 'Apple surges to record high on strong earnings' && raw[3].title === 'Apple dividend hike announced', JSON.stringify(raw.map(x => x.title)));
    check("withSource=false 时 src 默认 'Google News'", raw.every(x => x.src === 'Google News'), JSON.stringify(raw.map(x => x.src)));
  }
  console.log('[T2] parseGoogleRss: limit / withSource');
  {
    const lim = S.parseGoogleRss(XML, { limit: 2 });
    check('limit生效', lim.length === 2, 'n=' + lim.length);
    const ws = S.parseGoogleRss(XML, { withSource: true });
    check('withSource 抽取 <source>(含属性标签)', ws[0].src === 'CNBC' && ws[1].src === 'Bloomberg' && ws[3].src === 'Reuters', JSON.stringify(ws.map(x => x.src)));
    const empty = S.parseGoogleRss('', {});
    check('空body返回[]', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty));
  }

  console.log('[T3] googleNewsRSS 输出与合并前黄金值一致');
  {
    let thrown = false;
    S.__upstream.impl = () => { if (thrown) throw new Error('net down'); return { status: 200, headers: {}, body: XML }; };
    const got = await S.__deps ? null : null;   // noop占位
    const items = await S.googleNewsRSS('QQQ', 'Apple');
    const exp = [
      { t: T1, src: 'Google News', title: 'Apple surges to record high on strong earnings', link: 'https://news.google.com/rss/articles/abc1' },
      { t: T2, src: 'Google News', title: 'Fed cuts guidance; tech slides', link: 'https://news.google.com/rss/articles/def2' },
      { t: T4, src: 'Google News', title: 'Apple dividend hike announced', link: 'https://news.google.com/rss/articles/ghi3' },
    ];
    check('逐字段一致(limit5, 过滤无链接项)', JSON.stringify(items) === JSON.stringify(exp), JSON.stringify(items));
    thrown = true;
    await assert.rejects(S.googleNewsRSS('QQQ', 'Apple'), /net down/);
    check('上游失败保留错误语义', true);
  }

  console.log('[T4] googleNewsTopic 输出与合并前黄金值一致(kw过滤+来源+topic+sent)');
  {
    let thrown = false;
    S.__upstream.impl = () => { if (thrown) throw new Error('net down'); return { status: 200, headers: {}, body: XML }; };
    const tp = { id: 'oil', name: '原油', q: 'Crude oil', kw: /apple|fed/i };
    const items = await S.googleNewsTopic(tp);
    const exp = [
      { t: T1, src: 'CNBC', title: 'Apple surges to record high on strong earnings', link: 'https://news.google.com/rss/articles/abc1', topic: '原油', sent: sentiOf('Apple surges to record high on strong earnings') },
      { t: T2, src: 'Bloomberg', title: 'Fed cuts guidance; tech slides', link: 'https://news.google.com/rss/articles/def2', topic: '原油', sent: sentiOf('Fed cuts guidance; tech slides') },
      { t: T4, src: 'Reuters', title: 'Apple dividend hike announced', link: 'https://news.google.com/rss/articles/ghi3', topic: '原油', sent: sentiOf('Apple dividend hike announced') },
    ];
    check('逐字段一致(kw过滤掉无关条目)', JSON.stringify(items) === JSON.stringify(exp), JSON.stringify(items));
    thrown = true;
    await assert.rejects(S.googleNewsTopic(tp), /net down/);
    check('主题上游失败保留错误语义', true);
  }
}

main().then(() => { console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail'); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error('FATAL', e && (e.stack || e.message || e)); process.exit(2); });
