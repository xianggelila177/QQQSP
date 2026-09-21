import test from 'node:test';
import assert from 'node:assert/strict';
import {createNewsService} from '../../lib/news.js';
import {createMacroService} from '../../lib/macro.js';
import {createMacroMonitor} from '../../lib/macro-monitor.js';
const NOW=Date.parse('2026-09-21T12:00:00Z'),DAY=864e5;
const item=(title,t=NOW-60000,extra={})=>({title,t,src:'Reuters',link:'https://www.reuters.com/article/'+encodeURIComponent(title),tickers:['AAOI'],...extra});
const log={debug(){}};
const noFlash=async()=>({status:200,body:JSON.stringify({result:{data:{feed:{list:[]}}}})});
const rss=(title='AAOI expands optical capacity')=>'<rss><channel><item><title>'+title+'</title><link>https://news.google.com/rss/articles/current</link><pubDate>'+new Date(NOW-1000).toUTCString()+'</pubDate><source url="https://www.reuters.com">Reuters</source></item></channel></rss>';
test('v95 AAOI May/August news is discarded before fallback; Google publisher is retained',async()=>{
 let google=0;const svc=createNewsService({now:()=>NOW,log,yahooNews:async()=>[item('AAOI August',Date.parse('2026-08-12')),item('AAOI May',Date.parse('2026-05-18'))],httpsGet:async url=>{google++;assert.match(decodeURIComponent(url),/when:7d/);return {status:200,body:rss()};}});
 const out=await svc.requestNews('AAOI');assert.equal(google,1);assert.deepEqual(out.items.map(x=>x.title),['AAOI expands optical capacity']);assert.equal(out.items[0].src,'Reuters');assert.equal(out.items[0].provenance.article_url,null);assert.equal(out.items[0].provenance.link_scope,'aggregator');
});
test('v95 fresh-cache reads, peek and failure retention all enforce publication cutoff',async()=>{
 let now=NOW,fail=false;const svc=createNewsService({now:()=>now,log,ttl:999999999,newsLoader:async()=>{if(fail)throw Error('outage');return [item('boundary',NOW-7*DAY),item('old',NOW-7*DAY-1),item('future',NOW+1),item('unknown',null),item('no publisher',NOW,{src:''}),item('unsafe',NOW,{link:'javascript:evil()'}),item('feed page',NOW,{linkScope:'feed'})];}});
 const first=await svc.requestNews('AAOI');assert.deepEqual(first.items.map(x=>x.title),['boundary']);assert.equal(first.quality.rejected_items,6);now++;assert.equal(svc.peek('AAOI').items.length,0);assert.equal((await svc.requestNews('AAOI')).items.length,0);
 fail=true;now+=999999999;assert.equal((await svc.requestNews('AAOI')).items.length,0);
});
test('v95 demand refresh rotates eligible news sources after TTL without duplicate in-flight requests',async()=>{
 let now=NOW,yahoo=0,google=0;const svc=createNewsService({now:()=>now,ttl:100,log,yahooNews:async()=>{yahoo++;return [item('current Yahoo')];},httpsGet:async()=>{google++;return {status:200,body:rss()};}});
 await Promise.all([svc.requestNews('AAOI'),svc.requestNews('AAOI')]);assert.equal(yahoo,1);assert.equal(google,0);now+=101;await svc.requestNews('AAOI');assert.equal(google,1);now+=101;await svc.requestNews('AAOI');assert.equal(yahoo,2);
});
test('v95 all macro sources share strict seven-day cutoff, reject future/feed-homepage records',async()=>{
 const svc=createMacroService({now:()=>NOW,log,googleNewsTopic:async()=>[item('future report',NOW+1),item('six day report',NOW-6*DAY)],yahooNews:async()=>[],httpsGet:noFlash,officialNews:{getNews:async()=>({items:[{title:'29 day announcement',source:'Federal Reserve',link:'https://www.federalreserve.gov/newsevents/old.htm',pubDate:new Date(NOW-29*DAY).toUTCString()}],updatedAt:NOW})}});
 const out=await svc.getMacro();assert.deepEqual(out.items.map(x=>x.title),['six day report']);assert.ok(out.quality.rejected_items>0);
});
test('v95 monitor snapshots expire cached news even if collection is stopped or failing',async t=>{
 let now=NOW;const monitor=createMacroMonitor({now:()=>now,macro:{getMacro:async()=>({items:[item('last report',NOW-7*DAY+1)],updatedAt:NOW})},context:{snapshot:()=>({factors:[]}),getContext:async()=>({factors:[]}),exportState:()=>({})},calendar:{snapshot:()=>({}),getCalendar:async()=>({status:'disabled'})},tickMs:999999});t.after(()=>monitor.stop());await monitor.start();await monitor.settled();assert.equal(monitor.snapshot().news.items.length,1);now+=2;assert.equal(monitor.snapshot().news.items.length,0);
});
import {filterRecentNews} from '../../lib/news-policy.js';
import {newsMatchesSymbol} from '../../lib/news.js';
import {mergeMacroItems} from '../../lib/macro-analysis.js';
test('v95 short ticker disambiguation excludes spy art, videogames, hardware benchmarks and generic meta',()=>{
 for(const title of ['SpY transforms art','EA reveals new spy game','TimeSpy GPU benchmark','spy stock image library'])assert.equal(newsMatchesSymbol(item(title,NOW,{tickers:[]}), 'SPY'),false,title);
 for(const [symbol,title] of [['SPY','SPY ETF shares rise after S&P earnings'],['F','Ford Motor stock earnings rise'],['META','Meta Platforms shares rally']])assert.equal(newsMatchesSymbol(item(title,NOW,{tickers:[]}),symbol),true,title);
 assert.equal(newsMatchesSymbol(item('F is for future',NOW,{tickers:[]}), 'F'),false);
});
test('v95 community posts, unsafe URLs and publisher-less records cannot be labeled news',()=>{
 const out=filterRecentNews([item('Moomoo discussion',NOW,{link:'https://www.moomoo.com/community/feed/123',src:'Moomoo'}),item('Xueqiu discussion',NOW,{link:'https://xueqiu.com/123/1',src:'雪球'}),item('private host',NOW,{link:'http://127.0.0.1/article'}),item('secret query',NOW,{link:'https://example.test/article?api_key=secret'}),item('real report')],NOW);
 assert.deepEqual(out.items.map(x=>x.title),['real report']);assert.equal(out.quality.rejected_by_reason.community_post,2);assert.equal(out.quality.rejected_by_reason.invalid_url,2);
});
test('v95 shared news cancellation removes only the departing reader and no API active symbol',async()=>{
 let finish,producerSignal;const a=new AbortController(),b=new AbortController();const svc=createNewsService({now:()=>NOW,log,newsLoader:(_,opts)=>{producerSignal=opts.signal;return new Promise(resolve=>finish=resolve);}});
 const first=svc.requestNews('AAOI',{activate:false,signal:a.signal}),second=svc.requestNews('AAOI',{activate:false,signal:b.signal});await new Promise(r=>setImmediate(r));a.abort();await assert.rejects(first);assert.equal(producerSignal.aborted,false);finish([item('real report')]);assert.equal((await second).items.length,1);assert.equal(svc.activeSyms.size,0);
});
test('v95 the final canceled news reader stops the producer, fallback and late cache writes',async()=>{
 let google=0,yahooSignal;const c=new AbortController();const svc=createNewsService({now:()=>NOW,log,yahooNews:(_, {signal})=>{yahooSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},httpsGet:async()=>{google++;return {status:200,body:rss()};}});
 const p=svc.requestNews('AAOI',{activate:false,signal:c.signal});await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(p);await new Promise(r=>setImmediate(r));assert.equal(yahooSignal.aborted,true);assert.equal(google,0);assert.equal(svc.newsCache.size,0);
});
test('v95 survey grouping never replaces the first article publication time with a later fragment',()=>{
 const first=item('英国央行表示，8月Savanta民调显示，民众对未来一年的通胀预期为3.2%。',NOW-60000),second=item('英国央行表示，8月份Savanta民调显示，受访者对五年后的通胀预期为3.2%。',NOW-1000,{link:'https://www.reuters.com/article/five-year'});
 const result=mergeMacroItems([first,second]);assert.equal(result.length,1);assert.equal(result[0].t,first.t);assert.equal(result[0].reportingPeriod.latestPublishedAt,second.t);
});
test('v95 an aborted old reader cannot remove a replacement request from inflight diagnostics',async()=>{
 const pending=[],svc=createNewsService({now:()=>NOW,log,newsLoader:()=>new Promise(resolve=>pending.push(resolve))});const controller=new AbortController();
 const first=svc.requestNews('AAOI',{signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();const canceled=assert.rejects(first);const replacement=svc.requestNews('AAOI');await new Promise(r=>setImmediate(r));await canceled;
 assert.equal(pending.length,2);assert.equal(svc.newsInflightNews.size,1);pending[1]([item('replacement')]);await replacement;assert.equal(svc.newsInflightNews.size,0);pending[0]([item('old producer')]);await new Promise(r=>setImmediate(r));assert.equal(svc.peek('AAOI').items[0].title,'replacement');
});

import {createOfficialFeeds} from '../../lib/providers/official-feeds.js';
test('v95 official feeds choose the newest articles before applying the per-source limit',async()=>{
 const rows=Array.from({length:12},(_,i)=>'<item><title>Report '+i+'</title><link>https://www.federalreserve.gov/report/'+i+'</link><pubDate>'+new Date(NOW-(12-i)*60000).toUTCString()+'</pubDate></item>');
 const svc=createOfficialFeeds({now:()=>NOW,feeds:[{id:'fed',name:'Federal Reserve',url:'https://www.federalreserve.gov/rss',hosts:['www.federalreserve.gov']}],httpsGet:async()=>({status:200,body:'<rss version="2.0"><channel>'+rows.join('')+'</channel></rss>'})});
 const out=await svc.getNews();assert.equal(out.items.length,8);assert.equal(out.items[0].title,'Report 11');assert.equal(out.items.at(-1).title,'Report 4');
});
test('v95 grouped survey fragments expire on their own publication dates, not the newest article date',()=>{
 const recent=item('英国8月Savanta民调：民众未来一年通胀预期为3.2%。',NOW-7*DAY+60001),older=item('英国8月Savanta民调：民众对五年后的通胀预期为3.2%。',NOW-7*DAY+1,{link:'https://www.reuters.com/article/older-five-year'});
 const group=mergeMacroItems([recent,older]);assert.equal(group.length,1);assert.match(group[0].sourceText,/五年/);
 const checked=filterRecentNews(group,NOW+2);assert.equal(checked.items.length,1);assert.ok(!checked.items[0].sourceText.includes('五年'));assert.equal(checked.items[0].groupedCount,1);assert.equal(checked.items[0].t,recent.t);
 const untraceable={...group[0],groupFragments:['untraceable old text'],sourceText:'untraceable old text'};assert.equal(filterRecentNews([untraceable],NOW).items.length,0);
});
test('v95 Google RSS rejects unknown SEO sites and a spoofed Reuters name by source URL domain',async()=>{
 const body='<rss><channel>'+[['https://eciks.org','SPY ETF: what it is and why it matters'],['https://reuters.com.evil.example','SPY stock headline from spoofed Reuters'],['https://www.reuters.com','SPY ETF shares rise']].map(([url,title],i)=>'<item><title>'+title+'</title><link>https://news.google.com/rss/articles/'+i+'</link><pubDate>'+new Date(NOW-1000).toUTCString()+'</pubDate><source url="'+url+'">Reuters</source></item>').join('')+'</channel></rss>';
 const service=createNewsService({now:()=>NOW,log,yahooNews:async()=>[],httpsGet:async()=>({status:200,body})});const out=await service.requestNews('SPY');assert.deepEqual(out.items.map(x=>x.title),['SPY ETF shares rise']);assert.equal(out.quality.rejected_by_reason.unrecognized_publisher,2);
});
