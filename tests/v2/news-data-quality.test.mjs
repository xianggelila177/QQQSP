import test from 'node:test';
import assert from 'node:assert/strict';
import {createNewsService} from '../../lib/news.js';
import {filterRecentNews} from '../../lib/news-policy.js';
import {projectContextNews} from '../../lib/context-news.js';
const NOW=Date.parse('2026-10-07T12:00:00Z'),log={debug(){}};
const item=(title,age=60000,extra={})=>({title,t:NOW-age,src:'Reuters',link:'https://www.reuters.com/article/'+encodeURIComponent(title),tickers:['NVDA'],...extra});
const rss=items=>'<rss><channel>'+items.map(n=>'<item><title>'+n.title+'</title><link>'+n.link+'</link><pubDate>'+new Date(n.t).toUTCString()+'</pubDate><source url="https://www.reuters.com">Reuters</source></item>').join('')+'</channel></rss>';
test('a recent second-source report is collected while the first source is blocked, with only two loads',async()=>{
 let release,yahooCalls=0,googleCalls=0;
 const svc=createNewsService({now:()=>NOW,log,yahooNews:async symbol=>{assert.equal(symbol,'NVDA');yahooCalls++;return new Promise(resolve=>release=resolve);},httpsGet:async()=>{googleCalls++;return {status:200,body:rss([item('NVDA latest earnings',1000,{link:'https://news.google.com/rss/articles/new'})])};}});
 const pending=svc.requestNews('NVDA');await new Promise(resolve=>setImmediate(resolve));assert.equal(yahooCalls,1);assert.equal(googleCalls,1);release([item('NVDA older earnings',3600000)]);
 const result=await pending;assert.deepEqual(result.items.map(n=>n.title),['NVDA latest earnings','NVDA older earnings']);assert.equal(result.quality.source_attempts.length,2);assert.equal(result.quality.completeness,'bounded_search_results_not_exhaustive');
 await svc.requestNews('NVDA');assert.equal(yahooCalls,1);assert.equal(googleCalls,1);
});
test('combined results keep the latest five unique articles and prefer direct URLs to duplicate redirects',async()=>{
 const direct=item('NVDA earnings release',1000),google=[{...direct,title:direct.title+' - Reuters',link:'https://news.google.com/rss/articles/duplicate'},...Array.from({length:6},(_,i)=>item('NVDA report '+i,(i+2)*1000,{link:'https://news.google.com/rss/articles/'+i}))];
 const svc=createNewsService({now:()=>NOW,log,yahooNews:async()=>[direct],httpsGet:async()=>({status:200,body:rss(google)})});
 const result=await svc.requestNews('NVDA');assert.equal(result.items.length,5);assert.equal(result.items[0].link,direct.link);assert.equal(result.items[0].t,direct.t);assert.equal(result.items.filter(n=>n.title.includes('earnings release')).length,1);assert.equal(result.quality.rejected_by_reason.duplicate,1);
});
test('one failed source remains visible through cache and context projection while usable results survive',async()=>{
 const svc=createNewsService({now:()=>NOW,log,yahooNews:async()=>[item('NVDA report')],httpsGet:async()=>{throw Error('offline');}});
 const result=await svc.requestNews('NVDA');assert.equal(result.stale,true);assert.equal(result.items.length,1);assert.equal(result.quality.source_attempts[1].status,'error');
 const projected=projectContextNews(svc.peek('NVDA'),NOW);assert.equal(projected.quality.source_attempts[1].status,'error');assert.equal(projected.items[0].provenance.publisher_classification.status,'registered_domain');
});
test('all direct feeds get domain-based categories; unknown domains and name spoofing remain unverified',()=>{
 const checked=filterRecentNews([item('known newsroom'),item('company release',60000,{src:'Company',link:'https://www.businesswire.com/news/home/123'}),item('official filing',60000,{src:'SEC',link:'https://www.sec.gov/Archives/edgar/data/1'}),item('unregistered',60000,{src:'Reuters',link:'https://reuters.com.evil.example/article'})],NOW);
 assert.deepEqual(checked.items.map(n=>n.provenance.publisher_classification.category),['newsroom','press_release','official','unclassified']);assert.equal(checked.items[3].provenance.publisher_classification.status,'unregistered_domain');assert.equal(checked.quality.unregistered_publisher_items,1);assert.ok(checked.items.every(n=>n.provenance.verification==='feed_metadata_not_independent_fact_check'));
});
test('a multi-company title cannot assign its headline tone as either security investment direction',async()=>{
 const title='Nvidia stock falls while AMD surges to record',svc=createNewsService({now:()=>NOW,log,yahooNews:async()=>[item(title,1000,{tickers:['NVDA','AMD']})],httpsGet:async()=>({status:200,body:rss([])})});
 for(const symbol of ['NVDA','AMD']){const result=await svc.requestNews(symbol),news=result.items[0];assert.equal(news.sent,null);assert.equal(news.headlineTone.scope,'headline_only');assert.equal(news.headlineTone.targetDirection,'unknown');const projected=projectContextNews(result,NOW);assert.equal(projected.items[0].headline_tone.target_direction,'unknown');assert.equal(projected.items[0].association.symbol,symbol);}
});
test('canceling the final reader aborts both concurrently running source loads',async()=>{
 const signals=[],wait=signal=>{signals.push(signal);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const svc=createNewsService({now:()=>NOW,log,yahooNews:(_,{signal})=>wait(signal),httpsGet:(_,__,{signal})=>wait(signal)}),controller=new AbortController();
 const pending=svc.requestNews('NVDA',{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));assert.equal(signals.length,2);controller.abort();await assert.rejects(pending);assert.ok(signals.every(signal=>signal.aborted));assert.equal(svc.newsCache.size,0);
});
