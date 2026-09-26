import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=name=>fs.readFileSync(new URL('../../public/'+name,import.meta.url),'utf8');
const load=(context,names)=>{for(const name of names)vm.runInNewContext(source('modules/'+name+'.js'),context);};
const settle=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
class Element {
  constructor(){this.textContent='';this.nodes=new Map();this.listeners=new Map();this.children=[];this.style={setProperty(){}};this.classList={contains(){return false;},toggle(){},add(){},remove(){}};this.dataset={};this.open=false;}
  querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Element());return this.nodes.get(key);}
  querySelectorAll(){return [];}
  setAttribute(){} addEventListener(key,fn){this.listeners.set(key,fn);} removeEventListener(key){this.listeners.delete(key);}
  appendChild(node){this.children.push(node);} replaceChildren(){this.children=[];} showModal(){this.open=true;} close(){this.open=false;} focus(){}
  getBoundingClientRect(){return {width:800,height:400};}
}
function detailHarness(){
  const pending=[],intervals=new Map();let intervalId=0,mode='economy',clock=Date.now();
  class Clock extends Date {static now(){return clock;}}
  const document=Object.assign(new Element(),{body:new Element(),hidden:false,createElement:()=>new Element()});
  const window=Object.assign(new Element(),{PANEL_CHART_ENGINE:{createChartEngine:()=>({})},PANEL_CHART:{},innerWidth:1200,innerHeight:800});
  const context={window,document,Intl,Date:Clock,AbortController,location:{href:'https://panel.test/'},history:{pushState(){},back(){}},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout,clearTimeout,
    setInterval:fn=>{intervals.set(++intervalId,fn);return intervalId;},clearInterval:id=>intervals.delete(id),
    fetch:(url,{signal})=>new Promise((resolve,reject)=>{pending.push({url,resolve,reject,signal});signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));})};
  load(context,['panel-scheduler','panel-network','panel-timeframes','panel-format']);
  vm.runInNewContext(source('modules/panel-chart-detail.js').replace('return Object.freeze({mount,update:q=>','return Object.freeze({open,fetchDetail,chartInfo,selectPeriod,mount,update:q=>'),context);
  const view=window.PANEL_CHART_DETAIL.createChartDetailView({document,formatterFor:()=>({money:String}),UP:'red',DOWN:'green',canPoll:()=>!document.hidden||mode==='continuous'});
  const card=(symbol,extra={})=>({symbol,el:new Element(),cv:new Element(),d:{symbol,price:100,quoteAt:Date.now(),regularChart:{bars:[]},...extra}});
  const field=selector=>document.body.children[0].querySelector(selector);
  async function respond(index,payload={},status=200,headers=null){const request=pending[index],params=new URL(request.url,'https://panel.test').searchParams;
    request.resolve({ok:status===200,status,headers,json:async()=>({symbol:params.get('symbol'),range:params.get('range'),tape:{events:[]},...payload})});await settle();}
  return {view,document,pending,intervals,card,field,respond,advance:ms=>{clock+=ms;},now:()=>clock,setMode:value=>{mode=value;view.syncVisibility();}};
}
const book={status:'ready',source:'fixture',ask:{price:100,size:20},bid:{price:99,size:30},sizeUnit:'shares',asOf:Date.now()};

test('detail clears the entire previous instrument state and rejects wrong response identities',async()=>{
  const h=detailHarness();h.view.open(h.card('AAA'));await h.respond(0,{book});assert.equal(h.field('.cd-ask').textContent,'100');h.view.close();
  h.view.open(h.card('BBB'));assert.equal(h.field('.cd-ask').textContent,'—');assert.match(h.field('.cd-book-status').textContent,/加载中/);
  await h.respond(1,{symbol:'AAA',book});assert.equal(h.field('.cd-ask').textContent,'—');assert.match(h.field('.cd-tape-status').textContent,/证券身份/);
  const correct=h.view.fetchDetail();await h.respond(2,{book});await correct;assert.equal(h.field('.cd-ask').textContent,'100');
  const failed=h.view.fetchDetail();h.pending[3].reject(new Error('offline'));await failed;
  assert.equal(h.field('.cd-ask').textContent,'—');assert.doesNotMatch(h.field('.cd-book-status').textContent,/实时盘口/);h.view.close();
  h.view.open({symbol:'PENDING',cv:new Element(),d:null});assert.match(h.field('#chart-detail-title').textContent,/PENDING/);assert.equal(h.field('.cd-price').textContent,'—');h.view.close();await settle();
});

test('detail shares futures baseline semantics and exposes stale regular-chart evidence',async()=>{
  const h=detailHarness();h.view.open(h.card('CL=F',{instrumentType:'FUTURE',changeBasis:'previous-settlement',prevClose:-10,
    regularChart:{bars:[],stale:true,error:'UPSTREAM_TIMEOUT',missingReason:'CHART_SOURCE_STALE',sourceCheckedAt:Date.now()}}));
  assert.match(h.field('.cd-baseline').textContent,/较前结算基准 -10/);assert.match(h.field('.cd-facts').textContent,/前结算 -10/);
  assert.doesNotMatch(h.field('.cd-baseline').textContent,/常规收盘/);
  const info=h.view.chartInfo({},0);assert.match(info,/缓存分时已过期/);assert.match(info,/UPSTREAM_TIMEOUT/);assert.match(info,/来源检查/);h.view.close();await settle();
});

test('detail obeys cooldown and economy lifecycle while continuous mode remains active',async()=>{
  const h=detailHarness();h.view.open(h.card('AAA'));await h.respond(0,{},429,{get:()=> '120'});
  assert.match(h.field('.cd-tape-status').textContent,/限流/);
  for(const run of h.intervals.values())run();await settle();assert.equal(h.pending.length,1,'cooldown must not issue another fetch');
  h.document.hidden=true;h.view.syncVisibility();assert.equal(h.intervals.size,0);
  h.document.hidden=false;h.view.syncVisibility();assert.equal(h.intervals.size,1);await settle();assert.equal(h.pending.length,1);
  h.view.close();h.view.open(h.card('BBB'));assert.equal(h.pending.length,2);
  h.document.hidden=true;h.view.syncVisibility();assert.equal(h.pending[1].signal.aborted,true);assert.equal(h.intervals.size,0);
  h.setMode('continuous');assert.equal(h.pending.length,3);assert.equal(h.intervals.size,1);
  h.view.close();await settle();
});

test('detail loads deeper history when the shared store marks near-only prewarm incomplete',async()=>{
  const h=detailHarness(),card=h.card('AAA');let loads=0;
  card.historyStore={getSeries:()=>[{c:1}],needsLoad:tf=>tf==='yearly',load:async()=>{loads++;}};
  h.view.open(card);await h.respond(0);await h.view.selectPeriod('yearly');assert.equal(loads,1);h.view.close();await settle();
});

test('detail refreshes its own yearly period at one minute and respects loading, cooldown and visibility',async()=>{
  const h=detailHarness(),card=h.card('AAA');let loads=0,needsLoad=true;const entry={status:'ready',retryAt:0};
  card.tf='intraday';card.historyStore={getSeries:()=>[{periodStart:'2026-01-01',c:1}],getMeta:()=>entry,needsLoad:()=>needsLoad,
    load:async()=>{loads++;needsLoad=false;}};
  h.view.open(card);await h.respond(0);await h.view.selectPeriod('yearly');assert.equal(loads,1);
  const poll=async()=>{for(const run of h.intervals.values())run();await settle();};
  h.advance(10000);await poll();assert.equal(loads,1);
  h.advance(50000);await poll();assert.equal(loads,2,'detail period refreshes independently of main-card intraday');
  h.advance(60000);entry.status='loading';await poll();assert.equal(loads,2);
  entry.status='ready';entry.retryAt=h.now()+60000;await poll();assert.equal(loads,2);
  h.advance(60000);await poll();assert.equal(loads,3);
  h.document.hidden=true;h.view.syncVisibility();assert.equal(h.intervals.size,0);
  h.document.hidden=false;h.view.syncVisibility();await settle();assert.equal(loads,4,'returning to foreground checks the current history period');
  h.view.close();await settle();
});

test('VWAP caches by series revision and reuses one time-zone formatter',()=>{
  let allocations=0,dayReads=0;
  function DateTimeFormat(...args){allocations++;const formatter=new Intl.DateTimeFormat(...args);return {format(value){dayReads++;return formatter.format(value);}};}
  const window={};load({window,Date,Intl:{DateTimeFormat}},['panel-chart-engine']);
  const engine=window.PANEL_CHART_ENGINE.createChartEngine({UP:'red',DOWN:'green',fmtDate:String,formatterFor:()=>({money:String}),maSeries:()=>[]});
  const bars=Array.from({length:1950},(_,i)=>({t:1789983000+i*60,h:102,l:99,c:101,v:1000}));
  const q={tf:'intraday',d:{intradayVer:1,regularChart:{bars,exchangeZone:'America/New_York'}},_displayIntraday:bars,_estimatedVwap:true,_chartWidth:800,followEnd:true};
  engine.computePlot(q);const cached=q._vwapSeries;assert.equal(allocations,1);assert.equal(dayReads,1950);
  engine.computePlot(q);assert.equal(q._vwapSeries,cached);assert.equal(dayReads,1950,'pan/resize/quote-only redraw reuses calculations');
  bars.at(-1).c=105;engine.computePlot(q);assert.notEqual(q._vwapSeries,cached);assert.equal(dayReads,3900);
  q.d.intradayVer=2;engine.computePlot(q);assert.equal(dayReads,5850);assert.equal(allocations,1);
});

test('futures keep finite nonpositive chart prices without weakening stock validation',()=>{
  const window={};load({window,Date,Intl},['panel-chart-engine']);
  const now=Date.now(),date=new Date(now).toISOString().slice(0,10),t=now/1000;
  const bars=[{t:t-60,c:-5}],point={t,c:0,v:null,currency:'USD',source:'fixture',sessionDate:date,historyDate:date};
  const d={instrumentType:'FUTURE',price:0,quoteAt:now,currency:'USD',src:'fixture',marketState:'REGULAR',priceSession:'REGULAR',intradayLiveStatus:'ready',intradayLivePoint:point,
    regularChart:{bars,source:'fixture',tradeDate:date,regularSessions:[{open_at_ms:now-3600000,close_at_ms:now+3600000}],previousCloseReference:{value:0}}};
  assert.equal(window.PANEL_CHART_ENGINE.livePointFor(d).c,0);
  assert.equal(window.PANEL_CHART_ENGINE.livePointFor({...d,instrumentType:'EQUITY'}),null);
  const engine=window.PANEL_CHART_ENGINE.createChartEngine({UP:'red',DOWN:'green',fmtDate:String,formatterFor:()=>({money:String}),maSeries:()=>[]});
  const plot=engine.computePlot({tf:'intraday',d,_displayIntraday:bars,_chartWidth:800});assert.equal(plot.reference.value,0);assert.ok(plot.top>plot.bot);
});

test('price animations honor reduced motion and cancel when the preference changes',()=>{
  const media={matches:true,addEventListener(_,listener){this.change=listener;}};
  const window={matchMedia:()=>media,PANEL_STATE:{selectFreshness:()=>({stale:false,declaredDelayMinutes:0}),calendarStatus:()=>({message:''}),formatQuoteAge:()=> '0s'}};
  load({window,Date,Intl},['panel-timeframes','panel-format','panel-card-view']);
  const view=window.PANEL_CARD_VIEW.createCardView({document:{},panelsEl:new Element(),stripEl:new Element(),chartController:{drawChart(){}},formatterFor:()=>({money:String,canConvert:true,unit:'USD'}),cardCurOf:()=> 'USD',nameOf:()=> '',UP:'red',DOWN:'green'});
  const q={symbol:'AAA',el:new Element(),ccybtns:[]};
  for(const name of ['state','staleWarn','quoteMeta','quoteDetails','quoteAge','sourceCheckAge','fxNote','cur','unit','phasetag','change','pct','friendly','mkttag','changeBaseline','extRow','open','high','low','prev','volume','w52h','w52l','exch'])q[name]=new Element();
  let animations=0,cancelled=0;q.cur.animate=()=>{animations++;return {cancel(){cancelled++;}};};view.cardCache.set('AAA',q);
  const quote=price=>({symbol:'AAA',price,currency:'USD',change:1,quoteAt:Date.now(),sourceCheckedAt:Date.now()});
  q.d=quote(100);view.render(q);q.d=quote(101);view.render(q);assert.equal(animations,0);
  media.matches=false;q.d=quote(102);view.render(q);assert.equal(animations,1);
  media.matches=true;media.change();assert.equal(cancelled,1);
});

test('service worker keeps the installed complete shell and never falls across explicit asset versions',async()=>{
  const handlers={},entries=new Map(),origin='https://panel.test';let calls=0,online=false;
  const version=source('sw.js').match(/const VERSION = 'v(\d+)'/)[1],html=v=>'<link href="/style.css?v='+v+'"><script src="/panel.bundle.js?v='+v+'"></script>';
  entries.set(origin+'/',new Response(html(version)));entries.set(origin+'/panel.bundle.js?v='+version,new Response('installed bundle'));
  const cache={match:async key=>entries.get(new URL(key,origin).href)?.clone(),put:async(key,value)=>entries.set(key,value)};
  vm.runInNewContext(source('sw.js'),{self:{location:{origin},addEventListener:(name,fn)=>handlers[name]=fn},URL,Response,
    caches:{open:async()=>cache},fetch:async()=>{calls++;if(!online)throw new Error('offline');return new Response(html(Number(version)+1));}});
  async function request(path){let result;handlers.fetch({request:{method:'GET',url:origin+path},respondWith:value=>result=value,waitUntil(){}});return result;}
  const next=String(Number(version)+1);
  assert.equal((await request('/panel.bundle.js?v='+next)).type,'error','new asset URL never receives old bytes');
  const before=calls;assert.equal(await(await request('/panel.bundle.js?v='+version)).text(),'installed bundle');assert.equal(calls,before);
  online=true;assert.equal(await(await request('/')).text(),html(version),'new HTML waits for its complete new worker shell');
  online=false;assert.equal(await(await request('/')).text(),html(version));
});
