// Import the guard before dynamically loading the application graph. No default
// compatibility server or real provider can start during module evaluation.
import '../support/no-network.mjs';
import { test as fixtureTest, expect, quote } from './fixtures.mjs';
process.env.PANEL_TEST_AUTOSTART = '0';
const { createApplication } = await import('../../server.js');

export async function createRealServer({snapshots=false,startupPartial=false,fixedNow,snapshotMarketState='CLOSED'}={}) {
  const state = { startedAt: fixedNow??Date.now(), clockOffset: 0, extra: 0, tailDelta: 0, requests: [], marketRequests: 0, unexpectedUpstream: [], failedNews: new Set(['SPY']), startupPartial };
  const now = () => (fixedNow??Date.now()) + state.clockOffset;
  state.now=now;
  const upstream = async raw => {
    const url = new URL(raw);
    if (url.hostname === 'news.google.com' && url.pathname === '/rss/search') {
      const articles = [1, 2].map(i => `<item><title>Treasury yield oil crude Fed rate gold ${i}</title><link>https://example.invalid/macro/${i}</link><pubDate>${new Date(now()).toUTCString()}</pubDate></item>`).join('');
      return { status: 200, headers: {}, body: '<rss><channel>' + articles + '</channel></rss>' };
    }
    if (url.hostname === 'zhibo.sina.com.cn' && url.pathname === '/api/zhibo/feed') return { status: 200, headers: {}, body: JSON.stringify({ result: {data: {feed: {list: []}}} }) };
    state.unexpectedUpstream.push(url.hostname + url.pathname);
    throw new Error('Unstubbed real-application E2E provider: ' + url.hostname + url.pathname);
  };
  const app = createApplication({
    env: { NODE_ENV: 'test', PORT: '0', SYMBOLS: snapshots?'QQQ':'!', CACHE_MS: '1', QUOTE_MAX_AGE: '1', NEWS_TTL: '1', HTTP_SNAPSHOT_QUOTA: '30', HTTP_CLIENT_QUOTA: '10000', REALTIME_SNAPSHOTS: snapshots?'1':'0', PUBLIC_SOURCE_REDUNDANCY: '0',FUNDAMENTALS_ENABLED:'0',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'' },
    now, upstream, providerOverrides: {
      newsLoader:async symbol=>{
        if(state.failedNews.has(symbol))throw new Error('fixture partial source unavailable');
        return [{title:symbol+' real application news',link:'https://example.invalid/news/'+symbol,src:'Fixture',t:now(),sent:'中性'}];
      },
      fetchChart: async (symbol,query) => {
        const daily=new URLSearchParams(query).get('interval')==='1d';
        if(state.startupPartial&&!daily)throw Object.assign(Error('fixture intraday unavailable'),{retryAt:now()+60000});
        const result=quote(symbol,state), bars=daily?result.charts.daily30:result.charts.intraday;
        return {meta:{symbol,dataGranularity:daily?'1d':'1m',currency:result.currency,instrumentType:result.instrumentType},timestamp:bars.map(b=>b.t),indicators:{quote:[Object.fromEntries([['open','o'],['high','h'],['low','l'],['close','c'],['volume','v']].map(([name,key])=>[name,bars.map(b=>b[key])]))]}};
      },
      fetchQuote: async symbol => {const result=quote(symbol,state);return state.startupPartial?{...result,src:'tx-us',charts:{...result.charts,intraday:[]}}:result;}, fetchSnapshotBatch: async symbols=>({pollAfterMs:70000,quotes:symbols.map(symbol=>{const {charts,...fast}=quote(symbol,state);return {...fast,src:'naver-us',marketState:snapshotMarketState,pollAfterMs:70000};})}) },
  });
  app.httpServer.prependListener('request', request => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/market') { state.marketRequests++; state.requests.push(url.searchParams.get('cv')); }
  });
  const server = app.start();
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { app, state, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    server.closeAllConnections(); await app.stop();
    expect(server.listening, 'Application fixture closes its server').toBe(false);
    expect(state.unexpectedUpstream, 'Every application upstream must have an explicit fake').toEqual([]);
  } };
}
export const test = fixtureTest.extend({ panelServer: async ({}, use) => {
  const fixture = await createRealServer(); try { await use(fixture); } finally { await fixture.close(); }
} });
export { expect };
