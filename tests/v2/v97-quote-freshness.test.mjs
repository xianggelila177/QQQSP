import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const now=Date.parse('2026-09-21T14:00:00Z');
const sandbox=vm.createContext({window:{},Date});
for(const name of ['panel-state.js','panel-card-view.js'])vm.runInContext(fs.readFileSync(new URL('../../public/modules/'+name,import.meta.url),'utf8'),sandbox);
sandbox.window.PANEL_FORMAT={esc:String,fmtVol:String,pct:String,fmtTime8:value=>new Date(value).toISOString()};
const fresh=sandbox.window.PANEL_STATE.selectFreshness;
const view=sandbox.window.PANEL_CARD_VIEW.createCardView({document:{},panelsEl:{},stripEl:{},chartController:{},formatterFor:()=>({}),cardCurOf:()=>'USD',nameOf:()=>'',humanizeAge:String,getReadIntervalMs:()=>2000});
const quote=extra=>Object.freeze({symbol:'SOXX',price:100,currency:'USD',src:'naver-us',priceBasis:'website-last-trade',marketState:'REGULAR',
 quoteAt:now-40000,sourceCheckedAt:now-1000,feedDelayMinutes:0,checkIntervalMs:7000,pollAfterMs:1000,...extra});
function card(data,at=now){const q={d:data,quoteMeta:{textContent:'',title:''},staleWarn:{hidden:true,textContent:'',title:''}};view.updateQuoteMeta(q,at);return q;}

test('website and streamed quotes share a finite event-age budget and keep quiet updates neutral',()=>{
 for(const age of [40000,120000]){
  const data=quote({symbol:age===40000?'SKHY':'SOXX',quoteAt:now-age}),state=fresh(data,now),q=card(data);
  assert.equal(state.stale,false);assert.equal(state.noNewQuote,true);assert.equal(state.quoteBudgetMs,300000);
  assert.equal(q.staleWarn.hidden,true);assert.match(q.quoteMeta.textContent,/本来源暂无更新报价/);assert.doesNotMatch(q.quoteMeta.textContent,/市场无成交|实时/);
  assert.equal(data.quoteAt,now-age);assert.equal(data.sourceCheckedAt,now-1000);
  assert.equal(fresh({...data,priceBasis:'reported-trade',src:'finnhub',realtimeSource:'finnhub'},now).quoteBudgetMs,state.quoteBudgetMs);
 }
 assert.equal(fresh(quote({quoteAt:now-300000}),now).stale,false);
 const old=quote({quoteAt:now-300001});assert.equal(fresh(old,now).reason,'quote-overdue');
 assert.equal(card(old).staleWarn.textContent,'报价久未更新');assert.equal(card(old).staleWarn.hidden,false);
 const unknown=quote({marketState:'UNKNOWN',quoteAt:now-360000});assert.equal(fresh(unknown,now).reason,'quote-overdue');
 assert.equal(card(unknown).staleWarn.textContent,'报价久未更新','unknown session cannot grant an unlimited price lifetime');
});

test('a live related stream never excuses a missed website source check',()=>{
 const data=quote({sourceCheckedAt:now-31000,realtimeSource:'finnhub',realtimeStatus:'streaming',realtimeConnectionHealthy:true,connectionCheckedAt:now});
 assert.equal(fresh(data,now).reason,'source-overdue');const q=card(data);
 assert.equal(q.staleWarn.textContent,'来源检查超时');assert.equal(q.staleWarn.hidden,false);assert.doesNotMatch(q.quoteMeta.textContent,/本来源暂无更新报价/);
 const stream={...data,priceBasis:'reported-trade',src:'finnhub',sourceCheckedAt:now-40000};assert.equal(fresh(stream,now).stale,false);
});

test('declared delays are always explicit but do not imply a failed check or an unknown feed is real time',()=>{
 const data=quote({quoteAt:now-14*60000,feedDelayMinutes:15}),q=card(data);
 assert.equal(fresh(data,now).stale,false);assert.equal(fresh(data,now).declaredDelayMinutes,15);
 assert.equal(q.staleWarn.hidden,true);assert.match(q.quoteMeta.textContent,/来源声明延迟15分钟/);
 assert.equal(fresh({...data,quoteAt:now-930001},now).reason,'quote-overdue');
 const unknown=card(quote({feedDelayMinutes:null}));assert.match(unknown.quoteMeta.textContent,/来源延迟未核验/);assert.doesNotMatch(unknown.quoteMeta.textContent,/实时/);
});

test('verified index publication waiting keeps the prior value visible without hiding source or age failures',()=>{
 const data=quote({symbol:'^SOX',instrumentType:'INDEX',src:'naver-index',marketState:'CLOSED',quoteTimeBasis:'provider-published',
  quoteAt:Date.parse('2026-09-18T21:15:59Z'),publicationSession:{kind:'index-publication',verified:true,phase:'waiting',nextPublishAt:now+60000}});
 const q=card(data);assert.equal(q.staleWarn.hidden,true);assert.match(q.quoteMeta.textContent,/上一发布时段数值，等待发布/);
 assert.equal(q.d.quoteAt,data.quoteAt);assert.equal(q.d.sourceCheckedAt,data.sourceCheckedAt);
 assert.equal(card({...data,sourceCheckedAt:now-31000}).staleWarn.textContent,'来源检查超时');
 assert.equal(fresh({...data,quoteAt:now-14*86400000},now).stale,false);
 const expired=card({...data,quoteAt:now-14*86400000-1});assert.equal(expired.staleWarn.textContent,'报价久未更新');assert.equal(expired.staleWarn.hidden,false);
 assert.doesNotMatch(card({...data,publicationSession:{...data.publicationSession,verified:false}}).quoteMeta.textContent,/上一发布时段数值，等待发布/);
});

test('missing or future timestamps and explicitly retained values remain warnings',()=>{
 for(const extra of [{quoteAt:null},{quoteAt:now+5000},{sourceCheckedAt:null},{sourceCheckedAt:null,fetchedAt:now},{sourceCheckedAt:now+5000}]){
  const data=quote(extra);assert.equal(fresh(data,now).stale,true);assert.equal(card(data).staleWarn.hidden,false);
 }
 assert.equal(card(quote({recovery:true,staleInfo:{reason:'offline-cache'}})).staleWarn.textContent,'离线缓存·旧报价');
 assert.match(card(quote({stale:true,staleInfo:{reason:'rate-limited',etaMs:12000}})).staleWarn.textContent,/上游限流/);
 const providerOld=card(quote({stale:true,staleInfo:{reason:'trade-age-exceeded'}}));assert.equal(providerOld.staleWarn.textContent,'报价久未更新');
});

test('detail timestamps label source publications independently from transaction timestamps',async()=>{
 const leaf=()=>({children:[],listeners:{},dataset:{},textContent:'',append(...children){this.children.push(...children);},appendChild(child){this.children.push(child);},
  replaceChildren(...children){this.children=children;},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){}});
 const texts=node=>[node.textContent,...node.children.flatMap(texts)].join('\n');
 for(const [type,basis,label] of [['INDEX','provider-published','指数发布时间'],['EQUITY','provider-published','来源发布时间'],['EQUITY','source_time','成交时间']]){
  const doc={body:leaf(),createElement:leaf},button=leaf();
  const context=vm.createContext({window:{},AbortController,setTimeout,clearTimeout,Date});
  vm.runInContext(fs.readFileSync(new URL('../../public/modules/panel-detail.js',import.meta.url),'utf8'),context);
  const payload={schema_version:2,status:'ready',generated_at_ms:now,instrument:{symbol:'QQQ',name:'fixture',type,currency:'USD',price_unit:'USD'},
   sections:{quote:{status:'ready',delay_minutes:null,data:{price:100,quote_at_ms:now-40000,source_checked_at_ms:now,quote_time_basis:basis,market_state:'REGULAR'}}},sources:{}};
  const detail=context.window.PANEL_DETAIL.createDetailView({document:doc,fetchImpl:async()=>({ok:true,json:async()=>payload})});
  detail.mount({symbol:'QQQ',el:{querySelector:()=>button}});button.listeners.click();await new Promise(resolve=>setImmediate(resolve));
  const content=texts(doc.body);assert.match(content,new RegExp(label+'：'));
  if(basis==='provider-published')assert.doesNotMatch(content,/成交时间：/);detail.close();
 }
});
