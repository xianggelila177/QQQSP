import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseTwseStockDay,createTwseHistory} from '../../lib/providers/twse-history.js';
import {createTwseQuotes} from '../../lib/providers/twse-quotes.js';

const fixture=JSON.parse(readFileSync(new URL('./twse-2330-fixture.json',import.meta.url),'utf8'));
const emptyMonth={stat:'很抱歉，沒有符合條件的資料!',total:0};
const clock=()=>Date.parse('2026-09-25T08:20:24Z');
const response=payload=>({status:200,headers:{},body:JSON.stringify(payload)});

test('TWSE month rollover retains September history and the dated previous close',async t=>{
  const now=()=>Date.parse('2026-10-01T10:00:05+08:00');
  const september=structuredClone(fixture.daily);
  september.data.push(['115/09/30','1,000','2,500,000','2,480.00','2,510.00','2,470.00','2,500.00','+25.00','100','']);
  const calls=[];
  const daily=createTwseHistory({now,maxMonths:2,httpsGet:async url=>{
    const month=new URL(url).searchParams.get('date');calls.push(month);
    return response(month==='20261001'?emptyMonth:september);
  }});
  t.after(()=>daily.close());
  const chart=await daily('2330.TW','?interval=1d&range=2y');
  assert.deepEqual(calls,['20261001','20260901']);
  assert.equal(chart.coverage.lastTradingDate,'2026-09-30');
  assert.equal(chart.indicators.quote[0].close.at(-1),2500);
  const mis=structuredClone(fixture.quote),row=mis.msgArray[0];
  Object.assign(row,{d:'20261001','^':'20261001',key:'tse_2330.tw_20261001',t:'10:00:00'});row.trade.t='10:00:00';
  const quote=await createTwseQuotes({now,daily,httpsGet:async()=>response(mis)}).getQuote('2330.TW');
  assert.equal(quote.price,2475);assert.equal(quote.prevClose,2500);
  assert.equal(quote.previousCloseTradeDate,'2026-09-30');assert.equal(quote.changePct,-1);
  assert.equal(calls.length,2,'empty month and prior month are reused');
});

test('only the exact official empty-month response is treated as empty; errors retain cooldown',async t=>{
  assert.deepEqual(parseTwseStockDay(emptyMonth,'2330.TW','2026-10'),[]);
  for(const payload of [
    {stat:'查詢日期大於今日，請重新查詢!',total:0},
    {stat:'查詢日期小於99年1月4日，請重新查詢!',total:0},
    {...emptyMonth,total:'0'},
    {...emptyMonth,data:[['unexpected record']]},
    {...emptyMonth,title:'115年10月 0050 wrong listing'}
  ])assert.throws(()=>parseTwseStockDay(payload,'2330.TW','2026-10'),{code:'HISTORY_BAD_RESPONSE'});
  let calls=0;
  const daily=createTwseHistory({now:clock,httpsGet:async()=>{calls++;return {status:429,headers:{'retry-after':'120'},body:JSON.stringify(emptyMonth)};}});
  t.after(()=>daily.close());
  for(let i=0;i<2;i++)await assert.rejects(daily('2330.TW','?interval=1d'),{code:'HISTORY_RATE_LIMITED'});
  assert.equal(calls,1,'rate limiting must not turn into empty-month retries');
});

test('canceling one TWSE reader leaves the other reader and producer alive',async t=>{
  let ready,complete,upstreamSignal,calls=0;
  const started=new Promise(resolve=>ready=resolve);
  const daily=createTwseHistory({now:clock,httpsGet:async(url,headers,{signal})=>{
    calls++;upstreamSignal=signal;ready();return new Promise(resolve=>complete=resolve);
  }});
  t.after(()=>daily.close());
  const a=new AbortController();
  const first=daily.quoteContext('2330.TW','2026-09-24',{signal:a.signal});
  const firstRejected=assert.rejects(first,{code:'READER_LEFT'});
  await started;
  const second=daily.quoteContext('2330.TW','2026-09-24');
  a.abort(Object.assign(new Error('reader left'),{code:'READER_LEFT'}));
  await firstRejected;assert.equal(upstreamSignal.aborted,false);
  complete(response(fixture.daily));
  const context=await second;assert.equal(context.previous.c,2500);assert.equal(calls,1);
});

test('last TWSE reader cancellation aborts the producer without caching its failure; close can reopen',async()=>{
  const pending=[];
  const daily=createTwseHistory({now:clock,httpsGet:async(url,headers,{signal})=>new Promise((resolve,reject)=>{
    pending.push({signal,resolve});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const started=async()=>{while(!pending.length)await new Promise(resolve=>setImmediate(resolve));};
  try{
    const a=new AbortController(),b=new AbortController();
    const first=daily.quoteContext('2330.TW','2026-09-24',{signal:a.signal});
    const second=daily.quoteContext('2330.TW','2026-09-24',{signal:b.signal});
    const readers=Promise.allSettled([first,second]);await started();
    a.abort();assert.equal(pending[0].signal.aborted,false);b.abort();
    await readers;assert.equal(pending[0].signal.aborted,true);
    pending.length=0;
    const after=daily.quoteContext('2330.TW','2026-09-24');
    const closed=assert.rejects(after,{code:'STOPPED'});await started();daily.close();await closed;
    pending.length=0;daily.reopen();
    const reopened=daily.quoteContext('2330.TW','2026-09-24');await started();
    pending[0].resolve(response(fixture.daily));assert.equal((await reopened).previous.c,2500);
  }finally{daily.close();}
});

function searchFixture(mode){
  const clicks={},inputs={},calls=[];let scheduled;
  const qEl={value:'TSM',parentNode:{appendChild(){}},setAttribute(){},addEventListener(name,fn){inputs[name]=fn;}};
  const srEl={hidden:true,innerHTML:'',setAttribute(){},addEventListener(name,fn){clicks[name]=fn;}};
  const document={createElement:()=>({setAttribute(){}}),addEventListener(){}};
  const sandbox={window:{},AbortController,setTimeout:fn=>{scheduled=fn;return 1;},clearTimeout:()=>{scheduled=null;}};
  vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../../public/modules/panel-search-controller.js',import.meta.url),'utf8'),sandbox);
  const controller=sandbox.window.PANEL_SEARCH_CONTROLLER.createSearchController({qEl,srEl,document,esc:String,client:{normalizeList:x=>x},onSelect(){},network:{request:async(key,url)=>{
    calls.push(url);if(mode==='error')throw new Error('source down');
    return {ok:true,headers:{get:()=>mode},json:async()=>mode==='unavailable'?[]:[{symbol:'TSM',name:'ADR',market:'US',type:'EQUITY'}]};
  }}});
  return {controller,calls,qEl,retry:async()=>{clicks.click({target:{closest:selector=>selector==='[data-search-retry]'?{}:null}});await new Promise(resolve=>setImmediate(resolve));},type:async value=>{qEl.value=value;inputs.input();await scheduled();}};
}

test('search retry preserves expanded sources for partial, unavailable and failed searches',async()=>{
  for(const mode of ['partial','unavailable','error']){
    const view=searchFixture(mode);await view.controller.runSearch(true);await view.retry();
    assert.deepEqual(view.calls,['/api/search?q=TSM&more=1','/api/search?q=TSM&more=1'],mode);
  }
});

test('new search input and its retry return to ordinary source selection',async()=>{
  const view=searchFixture('partial');await view.controller.runSearch(true);
  await view.type('AAPL');await view.retry();
  assert.deepEqual(view.calls,['/api/search?q=TSM&more=1','/api/search?q=AAPL','/api/search?q=AAPL']);
});
