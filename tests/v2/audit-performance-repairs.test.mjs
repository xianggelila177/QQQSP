import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter,once} from 'node:events';
import {applyChartVersions,parseCv} from '../../lib/http-charts.js';
import {createQuoteEngine,quoteSignature} from '../../lib/quote-engine.js';
import {createHistoryPrewarm} from '../../lib/history-prewarm.js';
import {createSse} from '../../lib/sse.js';
import {createStreamBudget} from '../../lib/stream-budget.js';
import {createQuoteSamples} from '../../lib/quote-samples.js';
import {createHttp} from '../../lib/http.js';

const turn=()=>new Promise(setImmediate);
const copy=value=>JSON.parse(JSON.stringify(value));
function client(files,extra={}){
  const window={fetch:async()=>{},...extra},context={window,AbortController,URLSearchParams,Date,setTimeout,clearTimeout};
  vm.createContext(context);for(const file of files)vm.runInContext(fs.readFileSync(new URL('../../public/modules/'+file,import.meta.url),'utf8'),context);
  return window;
}
const bar=(date,c=100)=>({t:Date.parse(date+'T00:00:00Z')/1000,periodStart:date,periodEndExclusive:'2026-10-01',o:100,h:Math.max(101,c),l:99,c,v:100});
const historyValue=(period,bars=[bar('2026-09-01')],revision='1')=>({schemaVersion:1,symbol:'QQQ',period,seriesId:'series',revision,barsRevision:revision,bars,sourceCheckedAt:1000,status:'ready',requestedCount:period==='yearly'?39:79});

test('regular chart conditional delivery preserves metadata and client series identity',()=>{
  const bars=Object.freeze(Array.from({length:390},(_,i)=>Object.freeze({t:1000+i*60,o:100,h:101,l:99,c:100,v:100})));
  const quote={symbol:'QQQ',price:100,charts:{intraday:bars,daily30:[]},regularChart:{bars,source:'test',tradeDate:'2026-09-24',previousCloseReference:{value:99}}};
  const store=client(['panel-market-store.js']).PANEL_MARKET_STORE.createMarketStore();
  const first=store.prepareQuote(copy(applyChartVersions([quote],new Map())[0]));
  const versions=parseCv(store.chartVersions(['QQQ']));
  const next=applyChartVersions([{...quote,regularChart:{...quote.regularChart,previousCloseReference:{value:98}}}],versions)[0];
  assert.equal(next.regularChart.bars,'same');assert.ok(JSON.stringify(next).length<600);
  const resolved=store.prepareQuote(copy(next));assert.equal(resolved.regularChart.bars,first.regularChart.bars);assert.equal(resolved.regularChart.previousCloseReference.value,98);
  const changed={...quote,regularChart:{...quote.regularChart,bars:[...bars.slice(0,-1),{...bars.at(-1),c:101}]}};
  assert.ok(Array.isArray(applyChartVersions([changed],versions)[0].regularChart.bars));
  assert.ok(Array.isArray(applyChartVersions([quote],parseCv('QQQ:0:0'))[0].regularChart.bars),'old clients get full regular bars');
  assert.ok(quoteSignature(quote).length<500);assert.notEqual(quoteSignature(quote),quoteSignature(changed));
});

test('quote admission is atomic and reference counts survive overlapping clients and leases',()=>{
  let clock=1000;const memberships=[];
  const engine=createQuoteEngine({readQuote:()=>null,now:()=>clock,maxSymbols:2,onMembership:list=>memberships.push(list)});
  const a=engine.watch(['A','B','A']),b=engine.watch(['A']);
  assert.throws(()=>engine.watch(['C']),{code:'QUOTES_CAPACITY_EXCEEDED',statusCode:503});
  assert.throws(()=>engine.read(['C']),{code:'QUOTES_CAPACITY_EXCEEDED'});assert.deepEqual(engine.diagnostics().active,['A','B']);
  engine.read(['A']);a();a();assert.deepEqual(engine.diagnostics().active,['A']);b();assert.deepEqual(engine.diagnostics().active,['A']);
  clock+=15001;assert.deepEqual(engine.diagnostics().active,[]);assert.equal(engine.diagnostics().subscribers,0);
  const before=memberships.length;engine.tick();engine.diagnostics();assert.equal(memberships.length,before);engine.stop();
});

test('background history remains near and exposes long tabs for explicit loading',async()=>{
  let clock=1000;const calls=[];
  const history={cache:new Map(),exportState:()=>({schemaVersion:1,entries:[]}),prepare:async(s,o)=>{calls.push([s,o.tier]);return Object.fromEntries(['daily','weekly','monthly','yearly'].map(p=>[p,historyValue(p)]));}};
  const worker=createHistoryPrewarm({history,now:()=>clock,tickMs:600000,expandAfterMs:0});worker.retain(['QQQ']);await worker.start();await worker.settled();
  try{clock+=5001;await worker.runDue();assert.equal(calls.length,1);clock+=60000;await worker.runDue();assert.deepEqual(calls,[['QQQ','near'],['QQQ','near']]);
    assert.equal(worker.read('QQQ','yearly'),null);assert.equal(worker.read('QQQ','daily').prewarmScope,'near');
  }finally{await worker.stop();}
});

test('near prewarm cannot cancel or replace requested long periods; deltas preserve loaded bars',async()=>{
  let resolve;const requests=[];
  const window=client(['panel-timeframes.js','panel-history-store.js']);
  const store=window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'QQQ',network:{request:async(_,url)=>{requests.push(url);return new Promise(r=>resolve=r);}}});
  const near={...historyValue('yearly',[bar('2026-01-01')]),prewarmScope:'near'};
  assert.equal(store.hydrate('yearly',near),true);assert.equal(store.needsLoad('yearly'),true);
  const pending=store.load('yearly');assert.match(requests[0],/limit=39/);
  store.hydrate('yearly',{...near,sourceCheckedAt:1100,bars:'same'});
  const wide=historyValue('yearly',[bar('2025-01-01'),bar('2026-01-01')],'wide');wide.sourceCheckedAt=1200;
  resolve({ok:true,status:200,json:async()=>wide});await pending;
  const loaded=store.getSeries('yearly');assert.equal(loaded.length,2);assert.equal(store.needsLoad('yearly'),false);
  store.hydrate('yearly',{...near,sourceCheckedAt:1300});assert.equal(store.getSeries('yearly'),loaded);assert.equal(store.getMeta('yearly').meta.revision,'wide');
  assert.equal(store.hydrate('yearly',{...near,sourceCheckedAt:1400,bars:'same'}),true);assert.equal(store.getSeries('yearly'),loaded);
  assert.equal(store.hydrate('yearly',{...near,seriesId:'different',bars:'same'}),false);assert.equal(store.getSeries('yearly'),loaded);
  const daily=historyValue('daily');store.hydrate('daily30',daily);const dailyBars=store.getSeries('daily30');
  store.hydrate('daily30',{...daily,bars:'same',status:'stale',errorCode:'SOURCE_UNAVAILABLE'});assert.equal(store.getSeries('daily30'),dailyBars);assert.equal(store.getMeta('daily30').errorCode,'SOURCE_UNAVAILABLE');
  store.hydrate('daily30',{...daily,bars:'same',status:'ready'});assert.equal(store.getMeta('daily30').errorCode,null);
  store.abort();
});

class Response extends EventEmitter{
  chunks=[];writableLength=0;destroyed=false;writeHead(status){this.status=status;}flushHeaders(){}write(text){this.chunks.push(text);return true;}end(text){if(text)this.chunks.push(text);this.writableEnded=true;}destroy(){this.destroyed=true;this.emit('close');}
  histories(){return this.chunks.filter(s=>s.startsWith('event: history')).map(s=>JSON.parse(s.split('\ndata: ')[1]));}
}
test('history SSE sends full initial/reconnect bars and metadata-only unchanged updates',async()=>{
  let notify,entry={symbol:'QQQ',periods:{daily:historyValue('daily'),yearly:historyValue('yearly')},status:'ready'};
  const historyPrewarm={snapshot:()=>({enabled:true,entries:[entry]}),lease:()=>()=>{},subscribe:fn=>{notify=fn;return()=>{};}};
  const engine={watch:()=>()=>{},read:()=>[],subscribe:()=>()=>{}};
  const stream=createSse({engine,historyPrewarm}),res=new Response();stream.open({method:'GET'},res,['QQQ'],'',true,{},true);await turn();await turn();
  try{
    assert.ok(Array.isArray(res.histories()[0].entries[0].periods.daily.bars));
    entry={...entry,status:'refreshing'};notify(['QQQ']);await turn();assert.equal(res.histories()[1].entries[0].periods.daily.bars,'same');
    entry={...entry,periods:{...entry.periods,yearly:historyValue('yearly',[bar('2026-01-01',101)],'2')}};notify(['QQQ']);await turn();
    assert.equal(res.histories()[2].entries[0].periods.daily.bars,'same');assert.ok(Array.isArray(res.histories()[2].entries[0].periods.yearly.bars));
    res.destroy();const reconnect=new Response();stream.open({method:'GET'},reconnect,['QQQ'],'',true,{},true);await turn();await turn();assert.ok(Array.isArray(reconnect.histories()[0].entries[0].periods.daily.bars));
    reconnect.destroy();const legacy=new Response();stream.open({method:'GET'},legacy,['QQQ'],'');await turn();await turn();notify(['QQQ']);await turn();assert.ok(Array.isArray(legacy.histories()[1].entries[0].periods.daily.bars));
  }finally{stream.close();}
});
test('SSE rejects quote capacity before streaming headers and releases budget',()=>{
  const budget=createStreamBudget(),engine={watch:()=>{throw Object.assign(Error('full'),{code:'QUOTES_CAPACITY_EXCEEDED',statusCode:503});}};
  const stream=createSse({engine,budget}),res=new Response();stream.open({method:'GET'},res,['QQQ'],'');
  assert.equal(res.status,503);assert.equal(budget.diagnostics().connections,0);assert.equal(JSON.parse(res.chunks[0]).code,'QUOTES_CAPACITY_EXCEEDED');stream.close();
});
test('regular SSE deltas require negotiation on subsequent frames, including a cold new client',async()=>{
  const listeners=new Set(),quote={symbol:'QQQ',price:100,charts:{intraday:[],daily30:[]},regularChart:{bars:[bar('2026-09-01')],source:'test'}};
  const engine={watch:()=>()=>{},read:()=>[quote],subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const stream=createSse({engine}),legacy=new Response(),modern=new Response();
  const quotes=res=>res.chunks.filter(s=>s.startsWith('event: quotes')).map(s=>JSON.parse(s.split('\ndata: ')[1]).quotes[0]);
  stream.open({method:'GET'},legacy,['QQQ'],'');stream.open({method:'GET'},modern,['QQQ'],'',true,{},true,true);
  try{await turn();await turn();assert.ok(Array.isArray(quotes(legacy)[0].regularChart.bars));assert.ok(Array.isArray(quotes(modern)[0].regularChart.bars));
    for(const notify of listeners)notify(['QQQ']);await turn();await turn();
    assert.ok(Array.isArray(quotes(legacy)[1].regularChart.bars));assert.equal(quotes(modern)[1].regularChart.bars,'same');
  }finally{stream.close();}
});
test('sample background membership keeps its previous subscription when global capacity is exhausted',async()=>{
  let list=['QQQ'],reject=false,releases=0;
  const engine={watch:()=>{if(reject)throw Object.assign(Error('活跃证券数量达到上限'),{code:'QUOTES_CAPACITY_EXCEEDED',maxSymbols:200});return()=>{releases++;};},read:()=>[],subscribe:()=>()=>{}};
  const store={retain(){},touch(){},accept(){},takeUpdates:()=>[],prune(){},flush:async()=>{},restore:async()=>{},snapshot:symbol=>({symbol,supported:true,points:[]}),diagnostics:()=>({})};
  const samples=createQuoteSamples({engine,store,getWatchlist:()=>list,tickMs:600000});await samples.start();
  try{list=['SPY'];reject=true;assert.doesNotThrow(()=>samples.runDue());assert.deepEqual(samples.diagnostics().watchlist,['QQQ']);assert.equal(releases,0);
    assert.equal(samples.snapshot('SPY').errorCode,'QUOTES_CAPACITY_EXCEEDED');assert.equal(samples.snapshot('SPY').status,'degraded');
    reject=false;samples.runDue();assert.deepEqual(samples.diagnostics().watchlist,['SPY']);assert.equal(releases,1);assert.equal(samples.diagnostics().membershipError,null);
  }finally{await samples.stop();}
});
test('HTTP stream routes preserve both negotiated delta flags and keep legacy responses full',async t=>{
  const quoteListeners=new Set(),historyListeners=new Set(),quote={symbol:'QQQ',price:100,charts:{intraday:[],daily30:[]},regularChart:{bars:[bar('2026-09-01')],source:'test'}};
  const subscribe=set=>fn=>{set.add(fn);return()=>set.delete(fn);};
  const engine={read:()=>[quote],watch:()=>()=>{},subscribe:subscribe(quoteListeners),diagnostics:()=>({active:[]})};
  const historyPrewarm={snapshot:()=>({enabled:true,entries:[{symbol:'QQQ',periods:{daily:historyValue('daily')}}]}),lease:()=>()=>{},subscribe:subscribe(historyListeners)};
  const layer=createHttp({engine,historyPrewarm,getCachedQuote:()=>quote},{env:{PORT:0},monitorCore:false});layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
  const origin='http://127.0.0.1:'+layer.httpServer.address().port,modernPath=client(['panel-live-store.js']).PANEL_LIVE_STORE.symbolsUrl('/api/stream',['QQQ']);
  assert.equal(new URL(modernPath,origin).searchParams.get('historyDelta'),'1');assert.equal(new URL(modernPath,origin).searchParams.get('regularDelta'),'1');
  for(const [requestPath,delta] of [[modernPath,true],['/api/stream?symbols=QQQ',false]]){
    const controller=new AbortController(),response=await fetch(origin+requestPath,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(3000)])});assert.equal(response.status,200);
    const reader=response.body.getReader();let carry='';
    const readPair=async()=>{const result={};while(!result.quotes||!result.history){const part=await reader.read();assert.equal(part.done,false);carry+=new TextDecoder().decode(part.value);let end;
      while((end=carry.indexOf('\n\n'))>=0){const frame=carry.slice(0,end);carry=carry.slice(end+2);const match=/^event: (quotes|history)\ndata: (.+)$/.exec(frame);if(match)result[match[1]]=JSON.parse(match[2]);}}
      return result;};
    try{const initial=await readPair();assert.ok(Array.isArray(initial.quotes.quotes[0].regularChart.bars));assert.ok(Array.isArray(initial.history.entries[0].periods.daily.bars));
      for(const notify of quoteListeners)notify(['QQQ']);for(const notify of historyListeners)notify(['QQQ']);const next=await readPair();
      assert.equal(next.quotes.quotes[0].regularChart.bars==='same',delta);assert.equal(next.history.entries[0].periods.daily.bars==='same',delta);
      if(!delta){assert.ok(Array.isArray(next.quotes.quotes[0].regularChart.bars));assert.ok(Array.isArray(next.history.entries[0].periods.daily.bars));}
    }finally{controller.abort();await reader.cancel().catch(()=>{});}
  }
});
