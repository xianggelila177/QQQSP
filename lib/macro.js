import {log as defaultLog} from '../log.mjs';
import {assessMacro,mergeMacroItems} from './macro-analysis.js';
import { requireNewsResponse } from './news.js';
import { cacheSet as boundedCacheSet } from './cache.js';
export const MACRO_MAX_AGE=48*3600e3;
export const OFFICIAL_NEWS_MAX_AGE=30*24*3600e3;
export const MACRO_TOPICS=[
  {id:'inflation',name:'通胀',q:'US CPI core inflation consensus',kw:/CPI|PCE|inflation|consumer price|通胀/i},
  {id:'treasury',name:'美债',q:'Treasury yields',tickers:['^TNX','TLT','IEF','SHY'],kw:/treasury|yield|bond/i},
  {id:'oil',name:'原油',q:'WTI Brent oil supply demand OPEC',tickers:['CL=F','USO','BZ=F','XOM','CVX'],kw:/oil|crude|opec|Brent|WTI|petroleum/i},
  {id:'fed',name:'美联储',q:'Federal Reserve rate',kw:/fed|fomc|rate|hike|cut\b|powell/i},
  {id:'gold',name:'黄金',q:'Gold price',tickers:['GC=F','GLD'],kw:/gold|bullion/i},
];
export function createMacroService({yahooNews,httpsGet,googleNewsTopic,officialNews,allowYahooFallback=true,cacheSet=boundedCacheSet,now=Date.now,log=defaultLog}={}) {
  const macroCache=new Map();let macroInflight=null,macroSnap=null,lastAttemptAt=null;
  function resetMacro(){macroCache.clear();macroSnap=null;lastAttemptAt=null;}
  async function source(key,loader,ttlMs=300000) {
    const old=macroCache.get(key);
    if(old&&now()-old.attemptAt<(old.error?60000:ttlMs))return old;
    let value;
    try{
      const loaded=await loader();
      const envelope=Array.isArray(loaded)?{items:loaded}:loaded&&Array.isArray(loaded.items)?loaded:null;
      if(!envelope)throw new Error('Invalid macro source response');
      const envelopeUpdatedAt=Object.prototype.hasOwnProperty.call(envelope,'updatedAt')?envelope.updatedAt:now();
      value={items:envelope.items,updatedAt:envelopeUpdatedAt,attemptAt:now(),stale:!!envelope.stale,
        ...(envelope.sources?{sources:envelope.sources}:{}),...(envelope.error?{error:String(envelope.error)}:{})};
    }
    catch(e){log.debug('[macro source fail]',{source:key,err:String(e?.message || e)});value={items:old?.items || [],updatedAt:old?.updatedAt ?? null,attemptAt:now(),stale:true,
      ...(old?.sources?{sources:old.sources}:{}),error:String(e?.message || e)};}
    cacheSet(macroCache,key,value,50);return value;
  }
  async function topic(tp){
    const rss=await source(tp.id+':rss',()=>googleNewsTopic(tp));
    const parts=[rss];
    if(allowYahooFallback&&(rss.items.length<2||rss.error))parts.push(await source(tp.id+':yahoo',async()=>{
      const raw=await yahooNews(tp.q);
      return raw.filter(n=>now()-n.t<=MACRO_MAX_AGE&&((tp.tickers&&n.tickers?.some(x=>tp.tickers.includes(x)))||tp.kw.test(n.title)))
        .map(n=>({...n,topic:tp.name,sent:'中性'}));
    }));
    return parts;
  }
  function adaptOfficial(item){
    const title=String(item?.title || '').trim();
    const pubDate=String(item?.pubDate || '').trim();
    const t=Date.parse(pubDate);
    const link=String(item?.link || '').trim();
    if(!title||!link||!Number.isFinite(t))return null;
    return {title,src:String(item?.source || item?.src || '官方公告'),link,t,pubDate,topic:'官方公告',official:true,sourceText:String(item.sourceText||'').slice(0,1800),sent:'中性'};
  }
  async function officialTopic(){
    if(!officialNews||typeof officialNews.getNews!=='function')return [];
    return [await source('official:news',async()=>{
      const snap=await officialNews.getNews();
      if(!snap||!Array.isArray(snap.items))throw new Error('Invalid official news response');
      return {...snap,items:snap.items.map(adaptOfficial).filter(Boolean)};
    })];
  }
  async function flash(){return source('sina:flash',async()=>{
    const r=requireNewsResponse(await httpsGet('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=30&zhibo_id=152&tag_id=0'),'Sina macro');
    const list=JSON.parse(r.body)?.result?.data?.feed?.list;
    if(!Array.isArray(list))throw new Error('Sina macro invalid response');
    return list.map(x=>{const sourceText=String(x.rich_text || '').replace(/<[^>]+>/g,' ').slice(0,1800),title=sourceText.slice(0,160);return {t:new Date(String(x.create_time).replace(' ','T')+'+08:00').getTime(),src:'新浪7x24',title,sourceText,link:/^https?:/.test(x.docurl || '')?x.docurl:'https://finance.sina.com.cn/7x24/',linkScope:x.docurl?'article':'feed',topic:'快讯',sent:'中性'};}).filter(n=>n.t>0&&n.title);
  },60000);}
  function refresh(){
    if(macroInflight)return macroInflight;
    lastAttemptAt=now();
    macroInflight=(async()=>{
      const loads=[...MACRO_TOPICS.map(topic),flash()];if(officialNews)loads.push(officialTopic());
      const parts=(await Promise.all(loads)).flat();
      const current=now();
      const items=parts.flatMap(p=>p.items).filter(n=>{
        if(!Number.isFinite(n.t)||n.t<=0)return false;
        const age=n.official?OFFICIAL_NEWS_MAX_AGE:MACRO_MAX_AGE;
        return current-n.t<=age&&(n.official?n.t<=current:n.t<=current+300000);
      }).sort((a,b)=>b.t-a.t);
      const unique=mergeMacroItems(items).map(n=>({...n,assessment:assessMacro(n,current)}));
      const importance={focus:2,watch:1,background:0};unique.sort((a,b)=>(importance[b.assessment.importance]-importance[a.assessment.importance])||b.t-a.t);
      const official=unique.filter(n=>n.official).slice(0,18);const regular=unique.filter(n=>!n.official);
      const officialReserve=official.slice(0,Math.min(3,official.length));
      const selected=[...officialReserve,...regular.slice(0,20-officialReserve.length)];
      const remaining=20-selected.length;
      if(remaining>0)selected.push(...official.slice(officialReserve.length,officialReserve.length+remaining));
      const bounded=selected.slice(0,20).sort((a,b)=>b.t-a.t);
      const failures=parts.filter(p=>p.error||p.stale),updatedAt=Math.max(0,...parts.map(p=>p.updatedAt || 0)) || null;
      const data={items:bounded,topics:[...MACRO_TOPICS.map(t=>t.name),...(officialNews?['官方公告']:[])],updated:updatedAt,updatedAt,stale:failures.length>0,refreshing:false,analysisVersion:1,analysisBasis:'来源标题/订阅摘要的本地条件规则；不是交易所评级或收益预测',
        sources:Object.fromEntries([...macroCache].map(([key,v])=>[key,{updatedAt:v.updatedAt,stale:v.stale,...(v.sources?{sources:v.sources}:{}),...(v.error?{error:v.error}: {})}])),
        ...(failures.length?{error:failures.length+' macro sources unavailable',retryAt:now()+60000}: {})};
      macroSnap={data,ts:now()};return data;
    })().finally(()=>{macroInflight=null;});return macroInflight;
  }
  async function getMacro({waitForRefresh=false}={}) {
    if(macroSnap&&now()-macroSnap.ts<60000)return macroSnap.data;
    if(!macroSnap||waitForRefresh)return refresh();
    if(lastAttemptAt==null||now()-lastAttemptAt>=60000)void refresh();
    return {...macroSnap.data,refreshing:!!macroInflight};
  }
  return {getMacro,resetMacro,macroCache};
}
