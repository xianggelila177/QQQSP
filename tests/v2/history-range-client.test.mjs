import test from 'node:test';
import assert from 'node:assert/strict';
import {modules,mounted} from './chart-viewport-fixture.mjs';
import {detailHarness} from './detail-ux-fixture.mjs';
const date=t=>new Date(t).toISOString().slice(0,10);
function rows(tf,count,before=tf==='yearly'?'2027-01-01':'2026-11-01'){
 const end=new Date(before+'T00:00Z'),year=end.getUTCFullYear(),month=end.getUTCMonth();
 return Array.from({length:count},(_,i)=>{const offset=count-i,
  t=Date.UTC(year-(tf==='yearly'?offset:0),tf==='yearly'?0:month-offset,1),next=Date.UTC(year-(tf==='yearly'?offset-1:0),tf==='yearly'?0:month-offset+1,1);
  return {t:t/1000,periodStart:date(t),periodEndExclusive:date(next),o:100+i,h:102+i,l:99+i,c:101+i,v:10,periodState:'closed'};});
}
const result=(tf,bars,revision,extra={})=>({schemaVersion:1,symbol:'NVDA',period:tf,seriesId:'range-'+tf,revision:String(revision),sourceCheckedAt:revision,status:'ready',bars,...extra});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
function historySource(tf){
 const requests=[],count=tf==='yearly'?2:12;let revision=10,hasMore=true,invalidOverlap=false;
 const network={request:async(key,url)=>{const query=new URL(url,'https://test').searchParams,before=query.get('before'),bars=rows(tf,count,before||undefined);
  requests.push(Object.fromEntries(query));
  const boundary=before?new Date(before+'T00:00Z'):null,next=boundary?date(Date.UTC(boundary.getUTCFullYear()+(tf==='yearly'?1:0),boundary.getUTCMonth()+(tf==='monthly'?1:0),1)):null;
  const overlap=before?{...rows(tf,1,next)[0],o:100,h:155,l:88,c:101,v:100,coverageStatus:'complete-to-asof'}:null;
  if(overlap&&invalidOverlap)overlap.periodStart='1999-01-01';
  return {ok:true,status:200,json:async()=>result(tf,bars,++revision,{hasMore,nextBefore:bars[0].periodStart,...(overlap?{overlapBars:[overlap]}:{})})};
 }};
 return {network,requests,near:result(tf,rows(tf,count),1,{hasMore:true,prewarmScope:'near',extent:{scope:'near',satisfied:false}}),
  setHasMore:value=>hasMore=value,setInvalid:()=>invalidOverlap=true};
}

test('main monthly/yearly request full counts, paginate bounded pages, repair overlap OHLC and preserve left cursor against near/tail updates',async()=>{
 for(const tf of ['monthly','yearly']){
  const src=historySource(tf),m=modules(),store=m.window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',network:src.network});store.hydrate(tf,src.near);
  const c=mounted(m,[],'daily30',20,store);await c.q.tabs.find(b=>b.dataset.tf===tf).dispatch('click',{});await settle();m.flush();
  assert.equal(src.requests[0].limit,tf==='yearly'?'39':'79');assert.equal(src.requests[0].before,undefined);assert.equal(c.q.loadOlderButton.hidden,false);
  const anchor=store.getSeries(tf)[0].periodStart,count=store.getSeries(tf).length;
  await c.meter.children.find(e=>e.className==='zoombar').dispatch('click',{target:{dataset:{z:'older'}}});await settle();m.flush();
  assert.equal(src.requests[1].before,anchor);assert.equal(store.getSeries(tf).length,count*2);
  assert.equal(store.getSeries(tf).find(b=>b.periodStart===anchor).h,155,'old partial bucket must be replaced by corrected aggregate');
  const loaded=store.getSeries(tf);store.hydrate(tf,{...src.near,revision:'100',sourceCheckedAt:100,hasMore:false});assert.equal(store.getSeries(tf),loaded);
  const cursor=store.getSeries(tf)[0].periodStart;src.setHasMore(null);await store.load(tf);c.controller.drawChart(c.q,true);
  assert.equal(c.q.loadOlderButton.hidden,false,'an unrelated tail response cannot disable a proven older-page cursor');
  src.setHasMore(true);await c.q.cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100});await c.q.cv.dispatch('pointermove',{pointerId:1,clientX:99999});m.flush();await settle();m.flush();
  assert.equal(src.requests.at(-1).before,cursor);c.controller.unmount(c.q);
 }
});

test('detail monthly/yearly buttons and left drag send before, apply corrected overlap and retain paging after tail refresh',async()=>{
 for(const tf of ['monthly','yearly']){
  const src=historySource(tf),h=detailHarness({historyNetwork:src.network}),store=h.card.historyStore;store.hydrate(tf,src.near);await h.select(tf);
  assert.equal(src.requests[0].limit,tf==='yearly'?'39':'79');assert.equal(h.field('[data-action="older"]').hidden,false);
  const anchor=store.getSeries(tf)[0].periodStart;h.field('[data-action="older"]').click();await h.flush();
  assert.equal(src.requests[1].before,anchor);assert.equal(store.getSeries(tf).find(b=>b.periodStart===anchor).h,155);
  const loaded=store.getSeries(tf);store.hydrate(tf,{...src.near,revision:'100',sourceCheckedAt:100,hasMore:false});await h.flush();assert.equal(store.getSeries(tf),loaded);
  const cursor=store.getSeries(tf)[0].periodStart;src.setHasMore(null);await store.load(tf);await h.flush();assert.equal(h.field('[data-action="older"]').hidden,false);
  src.setHasMore(true);const cv=h.field('.cd-canvas');cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:100,clientY:10});cv.dispatch('pointermove',{pointerId:1,clientX:99999,clientY:10});await h.flush();
  assert.equal(src.requests.at(-1).before,cursor);h.view.close();
 }
});

test('history cursor accepts only strictly earlier continuation and unknown sources do not become infinite pagination',async()=>{
 const m=modules(),tf='yearly',history=rows(tf,2),before=history[0].periodStart;let cursor='2024-01-01',hasMore=true;
 const store=m.window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',network:{request:async()=>({ok:true,status:200,json:async()=>result(tf,[],String(Date.now()),{hasMore,nextBefore:cursor})})}});
 store.hydrate(tf,result(tf,history,1,{hasMore:true,nextBefore:before}));await store.load(tf,{before});
 assert.equal(store.getMeta(tf).pagination.before,'2024-01-01');
 cursor='2025-01-01';await store.load(tf,{before:'2024-01-01'});assert.equal(store.getMeta(tf).pagination.before,'2024-01-01','non-progressing cursor cannot rewind');
 hasMore=null;await store.load(tf,{before:'2024-01-01'});assert.equal(store.getMeta(tf).pagination.hasMore,null);
});

test('malformed or unrelated overlap bars are rejected without erasing the previously usable range',async()=>{
 for(const tf of ['monthly','yearly']){
  const src=historySource(tf),m=modules(),store=m.window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',network:src.network});store.hydrate(tf,src.near);const old=store.getSeries(tf);src.setInvalid();
  await store.load(tf,{before:old[0].periodStart});assert.equal(store.getSeries(tf),old);assert.equal(store.getMeta(tf).status,'stale');assert.equal(store.getMeta(tf).errorCode,'HISTORY_BAD_RESPONSE');
 }
});
