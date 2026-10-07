import { ENG_NAME } from './search.js';
import {catalogInstrumentFor} from './market-registry.js';
import { sentiOf } from '../sent.mjs';
import { log as defaultLog } from '../log.mjs';
import { cacheSet as boundedCacheSet } from './cache.js';
import {filterRecentNews,combineNewsQuality,NEWS_PUBLISHERS} from './news-policy.js';
import {createSharedTasks} from './shared-task.js';
export const NEWS_TTL=300000;
export function requireNewsResponse(response,source) {
  if (!response || !Number.isInteger(response.status) || response.status<200 || response.status>=300) throw Object.assign(new Error(source+' HTTP '+(response?.status ?? 'unavailable')),{status:response?.status});
  return response;
}
const FINANCIAL=/\b(stock|shares?|ETF|fund|earnings?|revenue|dividend|investors?|NYSE|NASDAQ|ARCA|equity|S&P|trading|quarter|profit)\b|股票|股价|股份|财报|营收|盈利|投资|基金|上市|证券|标普|纳指/i;
const NEWS_NAMES={SPY:'SPDR S&P 500 ETF',QQQ:'Invesco QQQ Trust',F:'Ford Motor',META:'Meta Platforms',AAOI:'Applied Optoelectronics'};
const escapeRe=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function identityFor(symbol){const row=catalogInstrumentFor(symbol);return [...new Set([NEWS_NAMES[symbol],ENG_NAME[symbol],row?.name,...row?.aliases||[]].filter(x=>typeof x==='string'&&x!==symbol&&x.length>=3))];}
export function newsMatchesSymbol(item,symbol){
 const s=String(symbol||'').toUpperCase(),title=String(item?.title||'');
 if(item.tickers?.length)return item.tickers.some(x=>String(x).toUpperCase()===s);
 const names=identityFor(s),named=names.some(name=>title.toLowerCase().includes(name.toLowerCase()));
 const ticker=new RegExp('(^|[^A-Za-z0-9])'+escapeRe(s)+'([^A-Za-z0-9]|$)','i').test(title);
 if(/^[A-Z]{1,3}$/.test(s)||s==='META')return (named||ticker)&&FINANCIAL.test(title.replace(/\bstock\s+(?:photos?|images?|footage)\b/gi,''));
 return named||ticker;
}
// Deduplicate syndication through Google without merging unrelated publishers.
// Prefer a direct article to its redirect, and retain that article's own time.
export function mergeRelatedNews(items,limit=5){
 const rows=[],byUrl=new Map(),byTitle=new Map();let duplicates=0;
 const urlKey=link=>{const url=new URL(link);url.hash='';for(const key of [...url.searchParams.keys()])if(/^(utm_|guccounter$|guce_referrer|ref$)/i.test(key))url.searchParams.delete(key);return url.href;};
 for(const item of items){
  const classification=item.provenance?.publisher_classification,publisher=classification?.status==='registered_domain'?item.src.toLowerCase():classification?.domain||item.src.toLowerCase(),title=item.title.replace(new RegExp('\\s+[-–—|]\\s*'+escapeRe(item.src)+'\\s*$','i'),'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  const url=urlKey(item.link),headline=publisher+'|'+title,existing=byUrl.get(url)??byTitle.get(headline);
  if(existing!==undefined){duplicates++;const previous=rows[existing];if(previous.provenance?.link_scope==='aggregator'&&item.provenance?.link_scope==='article')rows[existing]=item;byUrl.set(url,existing);byTitle.set(headline,existing);continue;}
  const index=rows.length;rows.push(item);byUrl.set(url,index);byTitle.set(headline,index);
 }
 return {items:rows.sort((a,b)=>b.t-a.t).slice(0,limit),duplicates};
}
export function createNewsService({log=defaultLog,newsCache=new Map(),yahooNews,httpsGet,eastmoneyNews,cacheSet=boundedCacheSet,now=Date.now,newsLoader=null,ttl=NEWS_TTL,failureCooldown=60000,activeTtl=600000,maxEntries=32,maxActive=12,newsPublishers=NEWS_PUBLISHERS}={}) {
 const activeSyms=new Map(),newsInflightNews=new Map();
 const filterNews=(items,at=now())=>filterRecentNews(items,at,{publishers:newsPublishers});
 let closed=false,generation=0;const shared=createSharedTasks();
 const stopped=()=>Object.assign(new Error('News service stopped'),{code:'STOPPED'});
 function prune(){for(const [s,at] of activeSyms)if(now()-at>=activeTtl)activeSyms.delete(s);}
 function activateNews(symbol){if(closed)return false;const s=String(symbol||'').toUpperCase();prune();if(!s)return false;activeSyms.delete(s);activeSyms.set(s,now());while(activeSyms.size>maxActive)activeSyms.delete(activeSyms.keys().next().value);return true;}
 function googleEnvelope(raw,predicate,limit){
  const checked=filterNews(raw);
  checked.items=checked.items.filter(predicate).slice(0,limit);checked.quality.accepted_items=checked.items.length;return checked;
 }
 async function googleNewsRSS(symbol,query,{signal,includeQuality=false}={}){
  const locale=/[A-Za-z]{3}/.test(query)?'&hl=en-US&gl=US&ceid=US:en':'&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
  const r=requireNewsResponse(await httpsGet('https://news.google.com/rss/search?q='+encodeURIComponent(query+' (stock OR shares OR earnings OR 股票) when:7d')+locale,{}, {signal}),'Google News');
  if(!/<rss\b|<feed\b/i.test(r.body))throw new Error('Google News invalid RSS');
  const result=googleEnvelope(parseGoogleRss(r.body,{limit:100,withSource:true}),n=>newsMatchesSymbol(n,symbol),20);return includeQuality?result:result.items;
 }
 async function googleNewsTopic(tp,{includeQuality=false}={}){
  const r=requireNewsResponse(await httpsGet('https://news.google.com/rss/search?q='+encodeURIComponent(tp.q+' when:7d')+'&hl=en-US&gl=US&ceid=US:en'),'Google News');
  if(!/<rss\b|<feed\b/i.test(r.body))throw new Error('Google News invalid RSS');
  const result=googleEnvelope(parseGoogleRss(r.body,{limit:100,withSource:true}),n=>tp.kw.test(n.title),8);result.items=result.items.map(n=>({...n,topic:tp.name,sent:sentiOf(n.title)}));return includeQuality?result:result.items;
 }
 async function newsFor(symbol,{signal}={}){
  signal?.throwIfAborted();
  const s=String(symbol||'').toUpperCase(),eng=identityFor(s).find(x=>/[A-Za-z]{3}/.test(x))||identityFor(s)[0]||s;
  const cn=/^\d{6}\.(SS|SZ)$/.test(s)&&s!=='000001.SS';
  const sources=[{id:cn?'eastmoney':'yahoo',load:async()=>{
   if(cn)return eastmoneyNews(s,{signal});
   if(s==='000001.SS')return (await yahooNews('^SSEC',{signal})).map(n=>({...n,tickers:n.tickers?.includes('^SSEC')?[s]:n.tickers}));
   return yahooNews(s,{signal});
  }},{id:'google',load:()=>googleNewsRSS(s,eng,{signal,includeQuality:true})}];
  // Exactly two source loads per refresh. The shared reader signal and each
  // provider's existing gate/deadline still own cancellation and rate limits.
  const results=await Promise.all(sources.map(async source=>{
   signal?.throwIfAborted();
   try{const loaded=await source.load();signal?.throwIfAborted();const envelope=Array.isArray(loaded)?{items:loaded}:loaded;if(!Array.isArray(envelope?.items))throw Error('Invalid news response');
    const checked=filterNews(envelope.items),items=checked.items.filter(n=>newsMatchesSymbol(n,s));
    return {items,quality:combineNewsQuality(checked.quality,envelope.quality),attempt:{source:source.id,status:items.length?'ready':'empty',checkedAt:now(),returnedItems:items.length}};
   }catch(error){signal?.throwIfAborted();return {items:[],error,attempt:{source:source.id,status:'error',checkedAt:now(),error:'SOURCE_UNAVAILABLE'}};}
  }));
  signal?.throwIfAborted();const errors=results.filter(result=>result.error);
  if(errors.length===sources.length)throw new AggregateError(errors.map(result=>result.error),'News sources unavailable');
  const merged=mergeRelatedNews(results.flatMap(result=>result.items).sort((a,b)=>b.t-a.t)),items=merged.items.map(n=>({...n,sent:null,headlineTone:{value:({'利好':'positive','利空':'negative','中性':'neutral'}[sentiOf(n.title)]||'neutral'),scope:'headline_only',method:'keyword_rules',targetDirection:'unknown'},association:{symbol:s,basis:n.tickers?.some(ticker=>String(ticker).toUpperCase()===s)?'provider_ticker':'headline_identity'}}));
  const quality=combineNewsQuality(filterNews(items).quality,...results.map(result=>result.quality));quality.rejected_by_reason.duplicate+=merged.duplicates;quality.rejected_items+=merged.duplicates;
  quality.source_attempts=results.map(result=>result.attempt);quality.selection='latest_5_from_two_sources';quality.completeness='bounded_search_results_not_exhaustive';
  return {items,quality,sourceRotation:{strategy:'parallel_bounded_aggregate',attempts:quality.source_attempts},...(errors.length?{stale:true,error:'Some news sources unavailable'}:{})};
 }
 const loadNews=newsLoader||newsFor;
 function view(c){const checked=filterNews(c?.items);return {items:checked.items,quality:combineNewsQuality(checked.quality,c?.quality),updatedAt:c?.updatedAt??(c?.failedAt!=null?null:c?.ts??null),stale:!!c?.stale,...(c?.sourceRotation?{sourceRotation:c.sourceRotation}:{}),...(c?.error?{error:c.error}:{}),...(c?.failedAt!=null?{retryAt:c.failedAt+failureCooldown}:{})};}
 async function requestNews(symbol,{activate=true,signal}={}){
  signal?.throwIfAborted();
  if(closed)throw stopped();const owner=generation,s=String(symbol||'').toUpperCase();if(!s)return {...view(null),error:'invalid symbol'};
  const cached=newsCache.get(s);if(activate&&!activateNews(s))return {...view(cached),stale:true,error:'active symbol limit'};
  if(cached&&((now()-cached.ts<ttl&&cached.failedAt==null)||(cached.failedAt!=null&&now()-cached.failedAt<failureCooldown)))return view(cached);
  const p=shared.run(s,async sharedSignal=>{try{
   let abort;const cancellation=new Promise((_,reject)=>{abort=()=>reject(sharedSignal.reason);sharedSignal.addEventListener('abort',abort,{once:true});});
   let loaded;try{loaded=await Promise.race([Promise.resolve().then(()=>{if(closed||owner!==generation)throw stopped();sharedSignal.throwIfAborted();return loadNews(s,{signal:sharedSignal});}),cancellation]);}finally{sharedSignal.removeEventListener('abort',abort);}
   sharedSignal.throwIfAborted();
   if(closed||owner!==generation)throw stopped();const envelope=Array.isArray(loaded)?{items:loaded}:loaded;
   if(!Array.isArray(envelope?.items))throw Error('Invalid news response');
   const checked=filterNews(envelope.items),updatedAt=now(),value={...envelope,items:checked.items,quality:combineNewsQuality(checked.quality,envelope.quality),ts:updatedAt,updatedAt,stale:!!envelope.stale,...(envelope.error?{failedAt:updatedAt}:{})};
   cacheSet(newsCache,s,value,maxEntries);return view(value);
  }catch(e){if(closed||owner!==generation)throw stopped();sharedSignal.throwIfAborted();const error=String(e?.message||e||'news unavailable'),checked=filterNews(cached?.items);
   const value={...cached,items:checked.items,quality:combineNewsQuality(checked.quality,cached?.quality),ts:cached?.ts??0,updatedAt:cached?.updatedAt??(cached?.failedAt!=null?null:cached?.ts??null),stale:true,error,failedAt:now()};
   cacheSet(newsCache,s,value,maxEntries);log.debug('[news refresh fail]',{sym:s,err:error});return view(value);
  }}, {signal});newsInflightNews.set(s,p);return p.finally(()=>{if(newsInflightNews.get(s)===p)newsInflightNews.delete(s);});
 }
 function startNews(){closed=false;}
 function stopNews(){closed=true;generation++;shared.close(stopped());newsInflightNews.clear();activeSyms.clear();}
 function peek(symbol){const cached=newsCache.get(String(symbol||'').toUpperCase());return {...view(cached),...(cached&&now()-cached.ts>=ttl?{stale:true}:{})};}
 return {peek,newsCache,activeSyms,newsInflightNews,activateNews,requestNews,newsFor,startNews,stopNews,googleNewsRSS,googleNewsTopic};
}
function xmlText(value){return String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").trim();}
export function parseGoogleRss(body,opts={}){
 const out=[],re=/<item\b[^>]*>([\s\S]*?)<\/item>/g;let m;
 while((m=re.exec(String(body||'')))!==null&&out.length<(opts.limit??8)){
  const seg=m[1],pick=tag=>{const mm=seg.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>'));return mm?xmlText(mm[1]):'';};
  const source=seg.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/),publisherUrl=source?.[1].match(/\burl=["']([^"']+)["']/)?.[1];
  const entry={t:Date.parse(pick('pubDate')),src:opts.withSource?xmlText(source?.[2]):'Google News',title:pick('title'),link:pick('link'),...(publisherUrl?{publisherUrl:xmlText(publisherUrl)}:{})};
  const mapped=opts.accept?opts.accept(entry):entry;if(mapped)out.push(mapped);
 }
 return out;
}
