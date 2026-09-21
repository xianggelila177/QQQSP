import {safeUrl} from './context-values.js';
// Publication age is independent of cache/fetch age. Never substitute a read
// time for a missing publisher timestamp, including on error and restart paths.
export const NEWS_MAX_AGE_MS=7*24*60*60*1000;
const reasons=['unknown_publication_time','future_publication','older_than_window','missing_title','missing_publisher','invalid_url','feed_homepage','community_post','untraceable_group','unrecognized_publisher','duplicate'];
const community=(link,publisher)=>/雪球|股吧|Stocktwits|Reddit|Moomoo|富途牛牛社区/i.test(publisher)||/^(?:[^/]+\.)?(?:xueqiu\.com|reddit\.com|stocktwits\.com|x\.com|twitter\.com)$/.test(new URL(link).hostname)||/guba\.eastmoney\.com|moomoo\.com\/community|futunn\.com\/community/i.test(link);
const httpUrl=safeUrl;
function publishedTime(item){
 if(Object.hasOwn(item,'t'))return typeof item.t==='number'&&Number.isFinite(item.t)&&item.t>0?item.t:null;
 const raw=item.pubDate??item.publishedAt;
 const t=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()?Date.parse(raw):NaN;
 return Number.isFinite(t)&&t>0?t:null;
}
export function filterRecentNews(value,now){
 if(!Number.isFinite(now))throw new TypeError('News policy requires a finite current time');
 const items=[],rejected=Object.fromEntries(reasons.map(key=>[key,0])),seen=new Set();
 for(const raw of Array.isArray(value)?value:[]){
  let item=raw&&typeof raw==='object'?raw:{};
  if(Array.isArray(item.groupFragments)){
   if(!item.groupFragments.length||item.groupFragments.some(f=>!f||typeof f!=='object')){rejected.untraceable_group++;continue;}
   const fragmentInput=item.groupFragments.map(f=>({title:f.title,t:f.t,src:f.src,link:f.link,sourceText:f.sourceText,official:!!f.official,linkScope:f.linkScope,topic:f.topic}));
   const checked=filterRecentNews(fragmentInput,now);for(const key of reasons)rejected[key]+=checked.quality.rejected_by_reason[key];
   if(!checked.items.length)continue;
   const fragments=checked.items,anchor=fragments.find(f=>f.link===item.link&&f.t===item.t)||fragments[0],sourceText=fragments.map(f=>f.sourceText||f.title).join('。').slice(0,1800);
   item={...item,...anchor,sourceText,groupFragments:fragments,groupedCount:fragments.length,reportingPeriod:{firstPublishedAt:Math.min(...fragments.map(f=>f.t)),latestPublishedAt:Math.max(...fragments.map(f=>f.t))},reports:fragments.map(f=>({src:f.src,link:f.link,publishedAt:f.t})),...(sourceText!==item.sourceText?{assessment:null}:{})};
  }
  const t=publishedTime(item),title=String(item.title||'').trim(),publisher=String(item.src||item.source||'').trim(),link=httpUrl(item.link||item.url);
  const reject=t===null?'unknown_publication_time':t>now?'future_publication':t<now-NEWS_MAX_AGE_MS?'older_than_window':!title?'missing_title':!publisher||/^(unknown|未知来源|Google News)$/i.test(publisher)?'missing_publisher':!link?'invalid_url':item.linkScope==='feed'||item.provenance?.link_scope==='feed'||new URL(link).pathname==='/'?'feed_homepage':community(link,publisher)?'community_post':null;
  if(reject){rejected[reject]++;continue;}
  const key=link+'|'+title;if(seen.has(key)){rejected.duplicate++;continue;}seen.add(key);
  const aggregator=new URL(link).hostname==='news.google.com';
  const reports=Array.isArray(item.reports)?item.reports.filter(r=>Number.isFinite(r.publishedAt)&&r.publishedAt<=now&&r.publishedAt>=now-NEWS_MAX_AGE_MS&&httpUrl(r.link)):undefined;
  items.push({...item,title,t,src:publisher,link,...(reports?{reports}:{}),provenance:{publisher,publisher_url:httpUrl(item.publisherUrl||item.provenance?.publisher_url),article_url:aggregator?null:link,link_scope:aggregator?'aggregator':'article',timestamp_basis:'publisher_reported',verification:'feed_metadata_not_independent_fact_check'}});
 }
 items.sort((a,b)=>b.t-a.t);
 return {items,quality:{policy:'published_within_7_days',window_ms:NEWS_MAX_AGE_MS,cutoff_ms:now-NEWS_MAX_AGE_MS,checked_at_ms:now,accepted_items:items.length,rejected_items:Object.values(rejected).reduce((a,b)=>a+b,0),rejected_by_reason:rejected,verification:'publisher_feed_metadata_only'}};
}
export function combineNewsQuality(current,...previous){
 const rejected={...current.rejected_by_reason};
 for(const quality of previous)for(const key of reasons)rejected[key]+=Number(quality?.rejected_by_reason?.[key])||0;
 return {...current,rejected_items:Object.values(rejected).reduce((a,b)=>a+b,0),rejected_by_reason:rejected};
}
