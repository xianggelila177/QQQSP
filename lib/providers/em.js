import { log as defaultLog } from '../../log.mjs';

export function createEastmoneyProvider({ now = () => Date.now(), httpsGet, log = defaultLog } = {}) {
  // lib/providers/em.js — 东方财富备源(A股实时快照 push2 + A股个股新闻搜索)

  function stripJsonp(body) { const i = body.indexOf('('), j = body.lastIndexOf(')'); return (i >= 0 && j > i) ? body.slice(i + 1, j) : body; }
  async function eastmoneyNews(symbol) {
    const identity = String(symbol || '').toUpperCase();
    const param = JSON.stringify({ uid: '', keyword: identity, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr', param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: 8, preTag: '', postTag: '' } } });
    const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=' + encodeURIComponent(param);
    const r = await httpsGet(url, {}, { family: 4 });   // 东财域名有IPv6记录但VPS无v6出口, 强制IPv4
    if(!Number.isInteger(r.status)||r.status<200 || r.status>=300)throw new Error('Eastmoney News HTTP '+r.status);
    const j=JSON.parse(stripJsonp(r.body));
    if(!Array.isArray(j?.result?.cmsArticleWebOld))throw new Error('Eastmoney News invalid response');
    const arts = (j.result && j.result.cmsArticleWebOld) || [];
    return arts.map(a => {
      const tickers = [a.symbol, a.stockCode, a.code, a.secuCode]
        .map(x => String(x || '').toUpperCase())
        .filter(x => /^\d{6}\.(SS|SZ)$/.test(x));
      return {
      t: new Date(String(a.date).replace(' ', 'T') + '+08:00').getTime(),
      src: a.mediaName || '东方财富',
      title: String(a.title || '').replace(/<[^>]+>/g, ''),
      link: a.url || '',
      // Eastmoney frequently omits security identity. Preserve it when the
      // payload provides one; callers must render identity-less items as
      // general market news rather than claiming a symbol match.
        tickers,
      };
    }).filter(n => n.t > 0 && n.title);
  }
  async function emQuoteSnapshot(s) {
    const m = /^(\d{6})\.(SS|SZ)$/.exec(s);
    if (!m) return null;
    try {
      const secid = (m[2] === 'SS' ? '1.' : '0.') + m[1];
      const url = 'https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid + '&fields=f43,f44,f45,f46,f60,f86&invt=2';
      const r = await httpsGet(url, {}, { family: 4 });
      const d = (JSON.parse(r.body) || {}).data;
      if (!d || d.f43 == null || d.f43 === '-') { log.debug('[em snap empty]', { symbol: s, status: r.status }); return null; }
      return { price: d.f43 / 100,
        open: d.f46 != null && d.f46 !== '-' ? d.f46 / 100 : null,
        high: d.f44 != null && d.f44 !== '-' ? d.f44 / 100 : null,
        low: d.f45 != null && d.f45 !== '-' ? d.f45 / 100 : null,
        prevClose: d.f60 != null && d.f60 !== '-' ? d.f60 / 100 : null,
        ts: (d.f86 || 0) * 1000 };
    } catch (e) { log.debug('[em snap fail]', { symbol: s, err: String(e && e.message || e) }); return null; }
  }
  return { eastmoneyNews, emQuoteSnapshot };
}
