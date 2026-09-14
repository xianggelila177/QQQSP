import assert from 'node:assert/strict';
import { createMacroService } from '../lib/macro.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const rssItem = (title, t, extra = {}) => ({ title, t, link: 'https://normal.example/' + encodeURIComponent(title), topic: '美联储', src: 'Google News', ...extra });
const officialItem = (title, daysAgo, extra = {}) => ({ title, source: 'Federal Reserve', pubDate: new Date(NOW - daysAgo * 86400000).toUTCString(), link: 'https://www.federalreserve.gov/' + encodeURIComponent(title), topic: '官方公告', official: true, ...extra });
const noFlash = () => ({ status: 200, body: JSON.stringify({ result: { data: { feed: { list: [] } } } }) });
const makeOfficial = (items, extra = {}) => ({ getNews: async () => ({ items, sources: [{ id: 'fed', source: 'Federal Reserve', successAt: NOW - 1000, error: null }], updatedAt: NOW - 1000, stale: false, ...extra }) });

const normalTopics = async tp => Array.from({ length: 5 }, (_, i) => rssItem(`${tp.id}-${i}`, NOW - i * 1000, { topic: tp.name }));

async function main() {
  console.log('[M1] officialNews flag off preserves old behavior');
  {
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: normalTopics, yahooNews: async () => [], httpsGet: noFlash, officialNews: undefined, log: { debug() {} } });
    const r = await svc.getMacro({ waitForRefresh: true });
    assert.equal(r.items.some(x => x.official), false); assert.equal(r.topics.includes('官方公告'), false);
    assert.equal(r.items.length,20);
  }

  console.log('[M2] official items adapt to t/src, retain pubDate, and reserve quota');
  for(const count of [0,1,2]){
    const official=makeOfficial(Array.from({length:count},(_,i)=>officialItem('small-'+i,3)));
    const svc=createMacroService({now:()=>NOW,googleNewsTopic:normalTopics,yahooNews:async()=>[],httpsGet:noFlash,officialNews:official,log:{debug(){}}});
    const r=await svc.getMacro({waitForRefresh:true});assert.equal(r.items.length,20);assert.equal(r.items.filter(x=>x.official).length,count);
  }
  {
    const official = makeOfficial([officialItem('official-old', 29), officialItem('official-2', 20), officialItem('official-3', 10)]);
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: normalTopics, yahooNews: async () => [], httpsGet: noFlash, officialNews: official, log: { debug() {} } });
    const r = await svc.getMacro({ waitForRefresh: true }); const got = r.items.filter(x => x.official);
    assert.equal(r.items.length, 20); assert.equal(got.length, 3); assert.equal(r.items.filter(x => !x.official).length, 17); assert.ok(got.some(x => x.title === 'official-old'));
    const old = got.find(x => x.title === 'official-old'); assert.equal(old.src, 'Federal Reserve'); assert.equal(old.topic, '官方公告'); assert.equal(old.pubDate, new Date(NOW - 29 * 86400000).toUTCString()); assert.equal(old.t, Date.parse(old.pubDate));
  }

  console.log('[M3] normal 48h and official 30d windows are distinct');
  {
    const official = makeOfficial([officialItem('official-29d', 29), officialItem('future', -1)]);
    const topic = async tp => [rssItem('normal-49h', NOW - 49 * 3600000, { topic: tp.name }), rssItem('normal-now', NOW, { topic: tp.name })];
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: topic, yahooNews: async () => [], httpsGet: noFlash, officialNews: official, log: { debug() {} } }); const r = await svc.getMacro({ waitForRefresh: true });
    assert.ok(r.items.some(x => x.title === 'official-29d')); assert.equal(r.items.some(x => x.title === 'future'), false); assert.equal(r.items.some(x => x.title === 'normal-49h'), false); assert.ok(r.items.some(x => x.title === 'normal-now'));
  }

  console.log('[M4] official diagnostics and main source errors survive fallback');
  {
    const official = makeOfficial([officialItem('official-during-outage', 3)], { stale: true, error: 'official upstream unavailable', sources: [{ id: 'fed', source: 'Federal Reserve', successAt: NOW - 100000, error: 'fed timeout' }] });
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: async () => { throw new Error('google down'); }, yahooNews: async () => { throw new Error('yahoo down'); }, httpsGet: async () => ({ status: 503, body: 'down' }), officialNews: official, log: { debug() {} } }); const r = await svc.getMacro({ waitForRefresh: true });
    assert.ok(r.items.some(x => x.title === 'official-during-outage')); assert.equal(r.stale, true); assert.ok(r.error); assert.ok(Object.values(r.sources).some(x => /google down|yahoo down|HTTP 503/.test(x.error || ''))); assert.ok(Object.values(r.sources).some(x => Array.isArray(x.sources) && x.sources.some(y => y.error === 'fed timeout')));
  }

  console.log('[M5] all main sources failing still exposes up to 18 official items');
  {
    const official = makeOfficial(Array.from({ length: 18 }, (_, i) => officialItem('official-outage-' + i, i + 1)), { stale: true, error: 'official partial' });
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: async () => { throw new Error('google down'); }, yahooNews: async () => { throw new Error('yahoo down'); }, httpsGet: async () => ({ status: 503, body: 'down' }), officialNews: official, log: { debug() {} } }); const r = await svc.getMacro({ waitForRefresh: true });
    assert.equal(r.items.length, 18); assert.equal(r.items.every(x => x.official), true); assert.equal(r.stale, true); assert.ok(r.error);
  }

  console.log('[M6] cold start outage keeps updatedAt null');
  {
    const official = makeOfficial([], { updatedAt: null, stale: true, error: 'official cold start unavailable' });
    const svc = createMacroService({ now: () => NOW, googleNewsTopic: async () => { throw new Error('google down'); }, yahooNews: async () => { throw new Error('yahoo down'); }, httpsGet: async () => ({ status: 503, body: 'down' }), officialNews: official, log: { debug() {} } }); const r = await svc.getMacro({ waitForRefresh: true });
    assert.equal(r.items.length, 0); assert.equal(r.updatedAt, null); assert.equal(r.stale, true);
  }

  console.log('RESULT: PASS official macro integration');
}
main().catch(e => { console.error('FATAL', e?.stack || e); process.exitCode = 1; });
