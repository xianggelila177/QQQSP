import { ENG_NAME } from './search.js';
import { sentiOf } from '../sent.mjs';
import { log as defaultLog } from '../log.mjs';
import { cacheSet as boundedCacheSet } from './cache.js';

export const NEWS_TTL=540000;
export function requireNewsResponse(response,source) {
  if (!response || !Number.isInteger(response.status) || response.status<200 || response.status>=300) throw Object.assign(new Error(source+' HTTP '+(response?.status ?? 'unavailable')),{status:response?.status});
  return response;
}
export function createNewsService({log=defaultLog,newsCache=new Map(),yahooNews,httpsGet,eastmoneyNews,cacheSet=boundedCacheSet,now=Date.now,newsLoader=null,ttl=NEWS_TTL,failureCooldown=60000,activeTtl=600000,maxEntries=32,maxActive=12}={}) {
  const activeSyms=new Map(),newsInflightNews=new Map();
  let closed=false,generation=0;
  const cancelled=new Map();
  const stopped=()=>Object.assign(new Error('News service stopped'),{code:'STOPPED'});
  function prune() {for(const [s,at] of activeSyms)if(now()-at>=activeTtl)activeSyms.delete(s);}
  function activateNews(symbol) {
    if(closed)return false;
    const s=String(symbol || '').toUpperCase();prune();
    if(!s)return false;
    activeSyms.delete(s);activeSyms.set(s,now());
    while(activeSyms.size>maxActive)activeSyms.delete(activeSyms.keys().next().value);
    return true;
  }
  async function googleNewsRSS(symbol,query) {
    const url='https://news.google.com/rss/search?q='+encodeURIComponent(query)+'&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
    const r=requireNewsResponse(await httpsGet(url),'Google News');
    if(!/<rss\b|<feed\b/i.test(r.body))throw new Error('Google News invalid RSS');
    return parseGoogleRss(r.body,{limit:5,accept:({t,title,link})=>title&&link&&t>0?{t,src:'Google News',title,link}:null});
  }
  async function googleNewsTopic(tp) {
    const r=requireNewsResponse(await httpsGet('https://news.google.com/rss/search?q='+encodeURIComponent(tp.q+' when:3d')+'&hl=en-US&gl=US&ceid=US:en'),'Google News');
    if(!/<rss\b|<feed\b/i.test(r.body))throw new Error('Google News invalid RSS');
    return parseGoogleRss(r.body,{limit:8,withSource:true,accept:({t,src,title,link})=>title&&t>0&&tp.kw.test(title)?{t,src,title,link,topic:tp.name,sent:sentiOf(title)}:null});
  }
  async function newsFor(symbol) {
    const withSent=arr=>arr.map(n=>({...n,sent:sentiOf(n.title)}));
    const s=String(symbol || '').toUpperCase();
    if(/^\d{6}\.(SS|SZ)$/.test(s)) {
      if(s==='000001.SS')return withSent((await yahooNews('^SSEC')).filter(n=>n.tickers?.includes('^SSEC')).slice(0,5));
      return withSent((await eastmoneyNews(s)).filter(n=>n.tickers?.length?n.tickers.includes(s):true).map(n=>n.tickers?.length?n:{...n,general:true}).slice(0,5));
    }
    const eng=ENG_NAME[s];let yahooError;
    try {
      if(eng){const hit=(await yahooNews(eng)).filter(n=>n.tickers?.includes(s));if(hit.length)return withSent(hit.slice(0,5));}
      const items=await yahooNews(s);
      const hit=items.filter(n=>n.tickers?.length?n.tickers.includes(s):true).map(n=>n.tickers?.length?n:{...n,general:true}).slice(0,5);
      if(hit.length)return withSent(hit);
    }catch(e){yahooError=e;}
    try{return withSent((await googleNewsRSS(s,eng || s.replace(/\.[A-Z]{2}$/,''))).slice(0,4));}
    catch(e){throw yahooError ? new AggregateError([yahooError,e],'News sources unavailable') : e;}
  }
  const loadNews=newsLoader || newsFor;
  const view=c=>({items:c?.items || [],updatedAt:c?.updatedAt ?? (c?.failedAt!=null?null:c?.ts ?? null),stale:!!c?.stale,...(c?.error?{error:c.error}:{}),...(c?.failedAt!=null?{retryAt:c.failedAt+failureCooldown}: {})});
  async function requestNews(symbol,{activate=true}={}) {
    if(closed)throw stopped();
    const owner=generation;
    const s=String(symbol || '').toUpperCase();
    if(!s)return {items:[],updatedAt:null,stale:false,error:'invalid symbol'};
    const cached=newsCache.get(s);
    if(activate&&!activateNews(s))return {...view(cached),stale:true,error:'active symbol limit'};
    if(cached&&((now()-cached.ts<ttl&&cached.failedAt==null)||(cached.failedAt!=null&&now()-cached.failedAt<failureCooldown)))return view(cached);
    if(newsInflightNews.has(s))return newsInflightNews.get(s);
    const p=(async()=>{
      try{
        const cancellation=new Promise((_,reject)=>cancelled.set(s,reject));
        const items=await Promise.race([Promise.resolve().then(()=>{if(closed||owner!==generation)throw stopped();return loadNews(s);}),cancellation]);
        if(closed||owner!==generation)throw stopped();
        if(!Array.isArray(items))throw new Error('Invalid news response');
        const updatedAt=now();const value={items,ts:updatedAt,updatedAt,stale:false};
        cacheSet(newsCache,s,value,maxEntries);return view(value);
      }catch(e){
        if(closed||owner!==generation)throw stopped();
        const error=String(e?.message || e || 'news unavailable');
        const value={items:cached?.items || [],ts:cached?.ts ?? 0,updatedAt:cached?.updatedAt ?? (cached?.failedAt!=null?null:cached?.ts ?? null),stale:true,error,failedAt:now()};
        cacheSet(newsCache,s,value,maxEntries);log.debug('[news refresh fail]',{sym:s,err:error});return view(value);
      }finally{if(owner===generation){newsInflightNews.delete(s);cancelled.delete(s);}}
    })();newsInflightNews.set(s,p);return p;
  }
  // Opening the news panel is the only demand signal. Restart only reopens lifecycle.
  function startNews(){closed=false;}
  function stopNews(){closed=true;generation++;for(const reject of cancelled.values())reject(stopped());cancelled.clear();newsInflightNews.clear();activeSyms.clear();}
  return {newsCache,activeSyms,newsInflightNews,activateNews,requestNews,newsFor,startNews,stopNews,googleNewsRSS,googleNewsTopic};
}
export function parseGoogleRss(body, opts = {}) {
  const limit = opts.limit ?? 8;
  const withSource = !!opts.withSource;
  const accept = opts.accept || null;
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(String(body || ''))) !== null && out.length < limit) {
    const seg = m[1];
    const pick = (tag) => { const mm = seg.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return mm ? mm[1].trim() : ''; };
    const title = pick('title').replace(/<!\[CDATA\[|\]\]>/g, '');
    const link = pick('link');
    const t = new Date(pick('pubDate')).getTime();
    let src = 'Google News';
    if (withSource) { const sm = seg.match(/<source[^>]*>([\s\S]*?)<\/source>/); if (sm) src = sm[1].replace(/<!\[CDATA\[|\]\]>/g, ''); }
    const entry = { t, src, title, link };
    const mapped = accept ? accept(entry) : entry;
    if (mapped) out.push(mapped);
  }
  return out;
}
