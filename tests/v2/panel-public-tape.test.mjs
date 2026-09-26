import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element{
  constructor(){this.children=[];this.fields=new Map();this.listeners={};this.dataset={};this.value='';this._text='';this.open=false;
    this.style={setProperty(){}};this.classList={contains:()=>false,toggle(){}};}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text;}
  querySelector(selector){if(!this.fields.has(selector))this.fields.set(selector,new Element());return this.fields.get(selector);}
  querySelectorAll(){return [];}
  appendChild(child){this.children.push(child);return child;}
  replaceChildren(){this.children=[];this._text='';}
  addEventListener(type,handler){this.listeners[type]=handler;}
  setAttribute(){} focus(){} showModal(){this.open=true;} close(){this.open=false;}
  getBoundingClientRect(){return {width:1000,height:500};}
}
function harness(){
  const elements=[],pending=[],timeouts=new Map();let timeoutId=0;
  const document={body:new Element(),createElement:()=>{const e=new Element();elements.push(e);return e;},addEventListener(){},removeEventListener(){}};
  const panel={PANEL_CHART_ENGINE:{createChartEngine:()=>({})},PANEL_CHART:{},PANEL_FORMAT:{fmtVol:String},
    innerWidth:1100,innerHeight:700,addEventListener(){},removeEventListener(){}};
  const context={window:panel,document,Date,Intl,AbortController,location:{href:'https://panel.test/'},history:{pushState(){},back(){}},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){},
    setTimeout:fn=>{const id=++timeoutId;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    fetch:(url,{signal})=>new Promise((resolve,reject)=>{pending.push({url,signal,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('aborted')));})};
  const source=readFileSync(new URL('../../public/modules/panel-chart-detail.js',import.meta.url),'utf8');
  for(const name of ['panel-scheduler','panel-network','panel-timeframes','panel-format'])vm.runInNewContext(readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),context);
  vm.runInNewContext(source.replace('return Object.freeze({mount,update:q=>',
    'return Object.freeze({open,fetchDetail,selectTapeSession,setPeriod:value=>{tf=value;},mount,update:q=>'),context);
  const view=panel.PANEL_CHART_DETAIL.createChartDetailView({document,formatterFor:()=>({money:v=>'$'+v}),UP:'red',DOWN:'green'});
  const quote={symbol:'NVDA',currency:'USD',price:110,quoteAt:Date.parse('2026-09-25T20:02:03Z'),
    regularChart:{exchangeZone:'America/New_York',tradeDate:'2026-09-25',bars:[{t:1,c:109,v:20}]}};
  const card={symbol:'NVDA',d:quote,cv:new Element()};view.open(card);
  const dialog=elements[0];
  const respond=async(index,tape)=>{pending[index].resolve({ok:true,json:async()=>({symbol:'NVDA',range:new URL(pending[index].url,'https://panel.test').searchParams.get('range'),tape})});for(let n=0;n<20;n++)await Promise.resolve();};
  return {view,pending,dialog,card,respond,field:selector=>dialog.querySelector(selector)};
}
const trade={at:Date.parse('2026-09-25T20:02:03Z'),price:110,size:10,source:'nasdaq-public-trades',reportState:'reported',eventId:null,side:null};
const publicTape=(events=[{...trade},{...trade}])=>({session:'post',tradeDate:'2026-09-25',source:'nasdaq-public-trades',sourceLabel:'Nasdaq 公开成交',
  sourceCheckedAt:trade.at+30000,asOf:trade.at,delayMinutes:null,stale:false,status:'partial',reason:'PUBLIC_TRADE_WINDOW',
  coverage:{scope:'public-trade-window',complete:false,firstAt:trade.at,lastAt:trade.at,count:events.length},
  quality:['NO_TRADE_IDS','CORRECTIONS_UNAVAILABLE','DELAY_UNVERIFIED'],events,
  stream:{state:'subscribing',errorCode:'WAITING_FOR_TRADE'}});

test('public tape preserves identical rows, shows seconds and window limits, and replaces the prior snapshot',async()=>{
  const h=harness(),originalChart=JSON.stringify(h.card.d.regularChart);
  assert.match(h.pending[0].url,/tapeSession=auto/);await h.respond(0,publicTape());
  const status=h.field('.cd-tape-status').textContent,rows=h.field('.cd-tape-list').children;
  for(const expected of ['Nasdaq 公开成交','盘后','2026-09-25','最近成交窗口','2 笔','非完整逐笔','延迟未核验','更正/撤销未提供'])assert.ok(status.includes(expected),expected);
  assert.doesNotMatch(status,/subscribing|WAITING_FOR_TRADE|重连/);
  assert.equal(rows.length,2);assert.equal(rows[0].textContent,rows[1].textContent);assert.match(rows[0].textContent,/16:02:03/);
  assert.match(h.field('.cd-tape-stats').textContent,/当前窗口 2 笔 · 窗口成交量 20 股/);
  assert.match(h.field('.cd-tape-stats').textContent,/不是全天成交统计/);
  const next=h.view.fetchDetail();await h.respond(1,publicTape([{...trade,size:7,price:122.9478}]));await next;
  assert.equal(h.field('.cd-tape-list').children.length,1);assert.match(h.field('.cd-tape-stats').textContent,/窗口成交量 7 股/);
  assert.match(h.field('.cd-tape-list').children[0].textContent,/\$122\.9478.*Nasdaq 公开成交/);
  assert.doesNotMatch(h.field('.cd-tape-list').children[0].textContent,/nasdaq-public-trades/);
  assert.equal(JSON.stringify(h.card.d.regularChart),originalChart);h.view.close();
});

test('session change clears old trades and stats, retains five-day range, and cancels only the old session request',async()=>{
  const h=harness();await h.respond(0,publicTape());h.view.setPeriod('fiveDay');
  const regular=h.view.selectTapeSession('regular');
  assert.match(h.pending[1].url,/range=5d&tapeSession=regular/);
  assert.equal(h.field('.cd-tape-list').children.length,0);assert.doesNotMatch(h.field('.cd-tape-stats').textContent,/20 股/);
  assert.match(h.field('.cd-tape-status').textContent,/逐笔加载中/);
  assert.equal(h.view.fetchDetail('5d'),regular,'same range and session shares the request');
  const pre=h.view.selectTapeSession('pre');assert.equal(h.pending[1].signal.aborted,true);
  assert.match(h.pending[2].url,/range=5d&tapeSession=pre/);
  await h.respond(2,{...publicTape(),session:'pre'});await Promise.all([regular,pre]);
  assert.match(h.field('.cd-tape-status').textContent,/盘前/);h.view.close();
});

test('empty public tape reasons are translated and clear previous rows and totals',async()=>{
  const h=harness();await h.respond(0,publicTape());
  const reasons={PUBLIC_TRADES_EMPTY:'该时段暂无公开逐笔',SOURCE_DATE_MISSING:'来源未提供可核验交易日',
    SOURCE_DATE_MISMATCH:'来源交易日与所选日期不符',PUBLIC_TRADES_UNSUPPORTED:'该证券暂无适用的公开逐笔来源',
    PUBLIC_TRADES_UNAVAILABLE:'公开逐笔来源暂不可用',SOURCE_COOLDOWN:'逐笔来源限流冷却中'};
  for(const [reason,label]of Object.entries(reasons)){
    const job=h.view.fetchDetail();await h.respond(h.pending.length-1,{...publicTape([]),reason,status:'unavailable',stale:true});await job;
    assert.ok(h.field('.cd-tape-status').textContent.includes(label));assert.match(h.field('.cd-tape-status').textContent,/缓存已过期/);
    assert.equal(h.field('.cd-tape-list').children.length,0);assert.doesNotMatch(h.field('.cd-tape-stats').textContent,/20 股/);
  }h.view.close();
});

test('opening a new detail resets the selector and request to the recent session',async()=>{
  const h=harness();await h.respond(0,publicTape());
  const post=h.view.selectTapeSession('post');await h.respond(1,publicTape());await post;
  assert.equal(h.field('.cd-tape-session').value,'post');h.view.close();h.view.open(h.card);
  assert.equal(h.field('.cd-tape-session').value,'auto');assert.match(h.pending[2].url,/range=1d&tapeSession=auto/);
  assert.equal(h.field('.cd-tape-list').children.length,0);h.view.close();
});

test('a failed refresh clears prior successful rows and totals while retaining the request error',async()=>{
  const h=harness();await h.respond(0,publicTape());
  const request=h.view.fetchDetail();h.pending[1].reject(new Error('HTTP 503'));await request;
  assert.equal(h.field('.cd-tape-list').children.length,0);assert.doesNotMatch(h.field('.cd-tape-stats').textContent,/20 股/);
  assert.match(h.field('.cd-tape-status').textContent,/详情接口暂不可用：HTTP 503/);h.view.close();
});
