import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FED_XML = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'fed-rss.xml'), 'utf8');
const ECB_XML = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ecb-rss.xml'), 'utf8');
const BEA_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>BEA</title>
<item name="GDP"><title><![CDATA[GDP rises &amp; output]]></title><link>https://www.bea.gov/news/gdp-2026</link><guid>gdp-2026</guid><pubDate>Wed, 02 Sep 2026 12:00:00 GMT</pubDate><description>summary</description></item>
<item name="Trade"><title>Trade &amp; services</title><link>https://www.bea.gov/news/trade-2026</link><pubDate>Tue, 01 Sep 2026 12:00:00 GMT</pubDate></item>
</channel></rss>`;
const NOW = Date.parse('2026-09-05T00:00:00Z');
const URLS = {
  fed: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  ecb: 'https://www.ecb.europa.eu/rss/press.html',
  bea: 'https://apps.bea.gov/rss/rss.xml',
};

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '|', e.message); }
};
const makeClock = () => { let t = NOW; return { now: () => t, set: x => { t = x; }, add: x => { t += x; } }; };
const makeGet = (bodies = { fed: FED_XML, ecb: ECB_XML, bea: BEA_XML }) => {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    const key = url.includes('federalreserve') ? 'fed' : url.includes('ecb.europa') ? 'ecb' : 'bea';
    const value = bodies[key];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') { const result = await value(url, calls.length); if (result instanceof Error) throw result; if (result && typeof result === 'object' && 'status' in result) return result; return { status: 200, headers: { 'content-type': 'application/rss+xml' }, body: result }; }
    return { status: 200, headers: { 'content-type': 'application/rss+xml' }, body: value };
  };
  fn.calls = calls;
  return fn;
};
const source = result => Object.fromEntries(result.sources.map(s => [s.id, s]));

async function main() {
  const { createOfficialFeeds } = await import('../lib/providers/official-feeds.js');

  console.log('[T1] 固定三源成功解析与输出字段');
  {
    const clock = makeClock(); const get = makeGet();
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} });
    const r = await svc.getNews();
    check('三条固定 URL 各请求一次', () => assert.deepEqual(get.calls.sort(), Object.values(URLS).sort()));
    check('返回 items/sources/updatedAt/stale', () => { assert.ok(Array.isArray(r.items)); assert.equal(r.sources.length, 3); assert.equal(typeof r.updatedAt, 'number'); assert.equal(r.stale, false); });
    check('每项只含规定字段并标记官方公告', () => { const allowed = new Set(['title', 'source', 'pubDate', 'link', 'topic', 'official', 'sourceText']); assert.ok(r.items.length >= 2); for (const x of r.items) { assert.deepEqual(Object.keys(x).sort(), [...allowed].sort()); assert.equal(x.topic, '官方公告'); assert.equal(x.official, true); assert.ok(x.source); } });
  }

  console.log('[T2] CDATA/实体、BEA item 属性、链接白名单');
  {
    const clock = makeClock(); const get = makeGet();
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} });
    const r = await svc.getNews();
    check('CDATA 与实体解码为纯文本', () => assert.ok(r.items.some(x => x.title.includes('Fed & ECB'))));
    check('BEA item name 属性不破坏解析', () => assert.equal(source(r).bea.itemCount, 2));
    check('原机构 HTTPS 链接保留', () => assert.ok(r.items.every(x => /^https:\/\/(www\.federalreserve\.gov|www\.ecb\.europa\.eu|www\.bea\.gov)\//.test(x.link))));
  }

  console.log('[T3] 30 天窗口、未来/过旧过滤且不改 pubDate');
  {
    const clock = makeClock();
    const xml = `<rss version="2.0"><channel><item><title>old</title><link>https://www.federalreserve.gov/old</link><pubDate>Tue, 04 Aug 2026 23:59:59 GMT</pubDate></item><item><title>edge</title><link>https://www.federalreserve.gov/edge</link><pubDate>Thu, 06 Aug 2026 00:00:00 GMT</pubDate></item><item><title>future</title><link>https://www.federalreserve.gov/future</link><pubDate>Sun, 06 Sep 2026 00:00:00 GMT</pubDate></item><item><title>keep</title><link>https://www.federalreserve.gov/keep</link><pubDate>Sat, 05 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
    const get = makeGet({ fed: xml, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
    check('只保留含边界的近 30 天及过去', () => assert.deepEqual(r.items.map(x => x.title), ['keep', 'edge']));
    check('pubDate 保留源文本不重写', () => assert.equal(r.items[1].pubDate, 'Thu, 06 Aug 2026 00:00:00 GMT'));
  }

  console.log('[T4] 每源 8 项、聚合 18 项上限');
  {
    const clock = makeClock(); const many = name => `<rss version="2.0"><channel>${Array.from({ length: 12 }, (_, i) => `<item><title>${name}-${i}</title><link>https://${name === 'fed' ? 'www.federalreserve.gov' : name === 'ecb' ? 'www.ecb.europa.eu' : 'www.bea.gov'}/${i}</link><pubDate>Fri, 04 Sep 2026 ${String(i).padStart(2, '0')}:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
    const get = makeGet({ fed: many('fed'), ecb: many('ecb'), bea: many('bea') }); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
    check('每源不超过 8 项', () => assert.ok(r.sources.every(s => s.itemCount <= 8)));
    check('聚合不超过 18 项', () => assert.ok(r.items.length <= 18));
  }

  console.log('[T5] 恶意 XML、HTML challenge、HTTP 错误、超大 body 拒绝');
  {
    const clock = makeClock();
    for (const [label, body, expected] of [
      ['doctype', '<!DOCTYPE rss [<!ENTITY x "bad">]><rss version="2.0"><channel/></rss>', /DTD|entity/i],
      ['html', '<!doctype html><html><script>challenge</script></html>', /HTML|RSS/i],
      ['prefixed-html', '<html><body>challenge</body></html><rss version="2.0"><channel/></rss>', /HTML|RSS|root/i],
      ['bad-root', '<root><item/></root>', /RSS|root/i],
      ['multiple-root', '<rss version="2.0"><channel/></rss><rss version="2.0"><channel/></rss>', /RSS|root/i],
      ['reverse-item-tags', '<rss version="2.0"><channel>' + '</item>'.repeat(16000) + '<item>'.repeat(16000) + '</channel></rss>', /mismatch|closing|RSS/i],
      ['deep-channel', '<rss version="2.0">' + '<channel>'.repeat(16000) + '<channel/></rss>', /depth|unclosed|mismatch/i],
      ['unclosed-oops', '<rss version="2.0"><oops><channel/></rss>', /unclosed|mismatch/i],
      ['missing-item-close', '<rss version="2.0"><channel><item><title>open</title><link>https://www.federalreserve.gov/open</link><pubDate>Fri, 04 Sep 2026 00:00:00 GMT</pubDate></channel></rss>', /item.*closing|mismatch/i],
      ['missing-rss-close', '<rss version="2.0"><channel/></rss', /RSS|root|unclosed/i],
      ['huge', '<rss version="2.0"><channel>' + 'x'.repeat(2 * 1024 * 1024) + '</channel></rss>', /size|large|limit/i],
    ]) {
      let get = makeGet({ fed: body, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
      if (label === 'html') get = makeGet({ fed: () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }), ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
      const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
      check(`${label} 源错误进入 diagnostics`, () => assert.match(source(r).fed.error, expected));
    }
    const get = makeGet({ fed: () => ({ status: 503, headers: {}, body: 'down' }), ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' }); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
    check('HTTP 非 2xx 拒绝', () => assert.match(source(r).fed.error, /HTTP 503/));
  }

  console.log('[T6] 失败保留旧结果、成功时间与 negative cooldown');
  {
    const clock = makeClock(); let down = false; const get = makeGet({ fed: () => down ? new Error('network down') : FED_XML, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {}, ttlMs: 100, failureCooldownMs: 500 }); const first = await svc.getNews(); const fedSuccess = source(first).fed.successAt; down = true; clock.add(101); const second = await svc.getNews();
    check('失败时旧 items 保留', () => assert.equal(source(second).fed.itemCount, source(first).fed.itemCount));
    check('保留最近成功时间并标 stale/error', () => { assert.equal(source(second).fed.successAt, fedSuccess); assert.equal(second.stale, true); assert.match(source(second).fed.error, /network down/); });
    const before = get.calls.length; await svc.getNews(); check('negative cooldown 内不重复请求失败源', () => assert.equal(get.calls.length, before));
    clock.add(501); await svc.getNews(); check('negative cooldown 后允许重试', () => assert.ok(get.calls.length > before));
  }

  console.log('[T7] single-flight 并发、TTL 到期刷新');
  {
    const clock = makeClock(); let release; let fedCalls = 0; const gate = new Promise(resolve => { release = resolve; }); const get = makeGet({ fed: async () => { fedCalls++; await gate; return FED_XML; }, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {}, ttlMs: 100 }); const a = svc.getNews(); const b = svc.getNews(); await Promise.resolve(); release(); const [ra, rb] = await Promise.all([a, b]);
    check('并发调用共享每源请求', () => { assert.equal(fedCalls, 1); assert.deepEqual(ra.items, rb.items); });
    clock.add(101); await svc.getNews(); check('TTL 到期重新请求', () => assert.equal(fedCalls, 2));
  }

  console.log('[T8] diagnostics 为只读可复核状态');
  {
    const clock = makeClock(); const get = makeGet(); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); await svc.getNews(); const d = svc.diagnostics();
    check('diagnostics 含三源及成功时间', () => { assert.equal(d.sources.length, 3); assert.ok(d.sources.every(s => typeof s.successAt === 'number')); });
    check('diagnostics 不触发网络', () => { const n = get.calls.length; svc.diagnostics(); assert.equal(get.calls.length, n); });
  }

  console.log('[T9] 缓存公告随当前时间再次执行 30 天窗口');
  {
    const clock = makeClock(); const get = makeGet({ fed: `<rss version="2.0"><channel><item><title>expires</title><link>https://www.federalreserve.gov/expires</link><pubDate>Sat, 05 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' });
    const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {}, ttlMs: 365 * 86400000 }); await svc.getNews(); clock.add(31 * 86400000); const r = svc.diagnostics();
    check('诊断 itemCount 与聚合均剔除已过 30 天缓存', () => { assert.equal(source(r).fed.itemCount, 0); assert.equal(r.items.length, 0); });
  }

  console.log('[T10] 官方 snapshot 按 pubDate 降序后再截取 18 条');
  {
    const clock = makeClock(); const many = (host, name) => Array.from({ length: 8 }, (_, i) => `<item><title>${name}-${i}</title><link>https://${host}/${i}</link><pubDate>${new Date(NOW - i * 3600000).toUTCString()}</pubDate></item>`).join('');
    const get = makeGet({ fed: `<rss version="2.0"><channel>${many('www.federalreserve.gov', 'date-fed')}</channel></rss>`, ecb: `<rss version="2.0"><channel>${many('www.ecb.europa.eu', 'date-ecb')}</channel></rss>`, bea: `<rss version="2.0"><channel>${many('www.bea.gov', 'date-bea')}</channel></rss>` }); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
    check('官方聚合最多 18 条且按 pubDate 降序', () => { assert.equal(r.items.length, 18); assert.deepEqual(r.items.slice(0, 3).map(x => x.title), ['date-fed-0', 'date-ecb-0', 'date-bea-0']); });
  }

  console.log('[T11] 根结构错误刷新时保留旧公告');
  {
    const clock = makeClock(); let bad = false; const good = '<rss version="2.0"><channel><item><title>old-good</title><link>https://www.federalreserve.gov/old-good</link><pubDate>Fri, 04 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>';
    const get = makeGet({ fed: () => bad ? '<html>challenge</html><rss version="2.0"><channel/></rss>' : good, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' }); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {}, ttlMs: 0, failureCooldownMs: 0 }); await svc.getNews(); bad = true; const r = await svc.getNews();
    check('单根错误不清空旧 items 且报告 error', () => { assert.equal(r.items[0].title, 'old-good'); assert.match(source(r).fed.error, /HTML|RSS|root/i); });
  }

  console.log('[T12] 属性含 > 与 atom 自闭合节点合法');
  {
    const clock = makeClock(); const atom = '<rss version="2.0"><channel><atom:link href="https://www.federalreserve.gov/rss?x=1>0" /></channel></rss>';
    const get = makeGet({ fed: atom, ecb: '<rss version="2.0"><channel/></rss>', bea: '<rss version="2.0"><channel/></rss>' }); const svc = createOfficialFeeds({ httpsGet: get, now: clock.now, log: () => {} }); const r = await svc.getNews();
    check('quoted > and namespaced self-closing node accepted', () => { assert.equal(source(r).fed.error, null); assert.equal(source(r).fed.itemCount, 0); assert.equal(r.stale, false); });
  }

  for(const bad of ['<?xml version="1.0"?><html version="2.0"><channel/></html>','<rss version="2.0"a="b"><channel/></rss>']){
    const svc=createOfficialFeeds({httpsGet:makeGet({fed:bad,ecb:bad,bea:bad}),now:()=>NOW,log:()=>{}});
    const r=await svc.getNews();check('non RSS root and malformed attributes rejected',()=>assert.ok(source(r).fed.error));
  }
  console.log(`\n结果: ${pass} pass / ${fail} fail`); process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error('FATAL', e?.stack || e); process.exitCode = 2; });
