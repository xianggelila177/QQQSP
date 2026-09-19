import assert from 'node:assert/strict';
import { loadApp } from './_harness.mjs';

let passed=0; const failures=[];
async function test(name,run){try{await run();passed++;console.log('PASS '+name);}catch(error){failures.push(name);console.log('FAIL '+name+': '+error.message);}}
const rates={USD:7,GBP:0.8,ZAR:18,EUR:0.9};
await test('raw subunit currency is case-sensitive and all conversion vectors agree',async()=>{
  const e=await loadApp({watchlist:[]});await e.drain();const convert=e.win.PANEL_CURRENCY.convert;
  for(const [from,value,usd,cny] of [['GBp',1000,12.5,87.5],['GBX',1000,12.5,87.5],['GBP',10,12.5,87.5],['ZAc',1800,1,7],['ZAC',1800,1,7],['ZAR',18,1,7],['EUR',9,10,70]]){
    assert.equal(convert(value,from,'USD',rates),usd,from+' USD');assert.equal(convert(value,from,'CNY',rates),cny,from+' CNY');
    assert.equal(convert(-value,from,'CNY',rates),-cny,from+' negative change');
    assert.equal(convert(value,from,'NATIVE',{}, {fxStale:true}),value,from+' native does not depend on FX');
  }
  assert.equal(convert(100,'TWD','USD',rates),null);
  assert.equal(convert(100,'GBP','JPY',rates),null,'unsupported target is not silently USD');
});
await test('native units and index points survive formatter and stale FX',async()=>{
  const e=await loadApp({watchlist:[]});await e.drain();const format=e.win.PANEL_FORMAT.createFormatter;
  for(const currency of ['GBp','GBX','GBP','ZAc','ZAC','ZAR']){
    const f=format({data:{currency,price:1000,fxStale:true},displayCurrency:'NATIVE',fxMap:rates});
    assert.equal(f.money(1000),'1,000.00');assert.equal(f.unit,currency);assert.equal(f.canConvert,true);
  }
  const missing=format({data:{currency:'GBp',price:1000},displayCurrency:'USD',fxMap:{}});
  assert.equal(missing.unit,'GBp');assert.equal(missing.money(1000),'1,000.00');assert.equal(missing.canConvert,false);
  const index=format({data:{currency:'GBp',instrumentType:'INDEX',price:8000,fxStale:true},displayCurrency:'CNY',fxMap:rates});
  assert.equal(index.money(8000),'8,000.00');assert.equal(index.unit,'点');assert.equal(index.convert(8000),8000);
});
await test('saved watchlists support ampersand without accepting invalid symbols; old currencies remain',async()=>{
  const e=await loadApp({watchlist:[]});await e.drain();const store=new Map([['wl',JSON.stringify(['QQQ','M&M.NS','00632R.TW','A<B','X?Y'])],['cur',JSON.stringify({QQQ:'CNY',SPY:'USD','M&M.NS':'NATIVE',bad:'XYZ'})]]);
  const state=e.win.PANEL_STATE.createState({getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)});
  assert.deepEqual(Array.from(state.loadWatchlist('wl')),['QQQ','M&M.NS','00632R.TW']);
  const currencies=state.loadCurrencies('cur');assert.deepEqual(Array.from(currencies,entry=>Array.from(entry)),[['QQQ','CNY'],['SPY','USD'],['M&M.NS','NATIVE']]);
  state.saveCurrencies('cur',currencies);assert.equal(JSON.parse(store.get('cur'))['M&M.NS'],'NATIVE');
});
await test('card price change OHLC and chart share subunit conversion without changing source bars',async()=>{
  const quote={symbol:'VOD.L',currency:'GBp',price:1000,change:100,changePct:11.11,prevClose:900,open:900,dayHigh:1100,dayLow:800,volume:100,marketState:'CLOSED',instrumentType:'EQUITY',fxKind:'reference',fxMap:rates,fxDate:'2026-09-04',charts:{intraday:[{t:1788508800,o:900,h:1100,l:800,c:1000,v:100}]}};
  const e=await loadApp({watchlist:['VOD.L']});await e.drain();e.fetch.push('market',{body:[quote]});await e.hooks().refresh(false);const q=e.hooks().cardCache.get('VOD.L');
  assert.equal(q.cur.textContent,'≈12.50');assert.equal(q.change.textContent,'+≈1.25');assert.equal(q.open.textContent,'≈11.25');assert.match(q.ohlc.innerHTML,/12\.50/);
  assert.equal(q.d.price,1000);assert.equal(q.plot.bars[0].c,1000);
  e.hooks().setCardCurrency('VOD.L','NATIVE');assert.equal(q.cur.textContent,'1,000.00');assert.equal(q.unit.textContent,'GBp');assert.match(q.ohlc.innerHTML,/1,000\.00/);assert.match(q.fxNote.textContent,/100 GBp = 1 GBP/);assert.doesNotMatch(q.fxNote.textContent,/参考汇率/);
  assert.equal(JSON.parse(e.sandbox.localStorage.getItem('qqq-card-cur'))['VOD.L'],'NATIVE');
  e.hooks().setCardCurrency('VOD.L','CNY');assert.equal(q.cur.textContent,'≈¥87.50');
  e.fetch.push('market',{body:[{...quote,fxStale:true}]});await e.hooks().refresh(false);
  assert.equal(q.cur.textContent,'1,000.00');assert.equal(q.unit.textContent,'GBp');assert.equal(q.fxNote.hidden,false);assert.match(q.fxNote.textContent,/原币|汇率/);
});
await test('directory controller is independently available and no startup subscription is added',async()=>{
  const e=await loadApp({watchlist:['QQQ']});await e.drain();
  assert.equal(typeof e.win.PANEL_MARKET_DIRECTORY?.createMarketDirectory,'function');
  assert.equal(e.fetchLog.some(url=>url.startsWith('/api/markets')),false,'directory is lazy');
  assert.deepEqual([...e.hooks().cardCache.keys()],['QQQ']);
});
const catalog={version:1,featured:['^FTSE'],markets:[
  {key:'uk',name:'英国',label:'英股',region:'欧洲',exchange:'London Stock Exchange',timezone:'Europe/London',currency:'GBP',benchmarks:[{symbol:'^FTSE',name:'富时100',type:'INDEX'}],examples:[{symbol:'VOD.L',name:'Vodafone',type:'EQUITY'},{symbol:'VUKE.L',name:'FTSE ETF',type:'ETF'}],sourceNote:'公开来源可能延迟'},
  {key:'in',name:'印度',label:'印股',region:'亚洲',exchange:'NSE',timezone:'Asia/Kolkata',currency:'INR',benchmarks:[],examples:[{symbol:'M&M.NS',name:'Mahindra',type:'EQUITY'}],sourceNote:'公开来源可能延迟'}
]};
const descendants=node=>[node,...node.children.flatMap(descendants)];
async function directoryFixture(watchlist=['QQQ']){
  const e=await loadApp({watchlist});await e.drain();
  const root=e.doc.createElement('details'),status=e.doc.createElement('p'),retry=e.doc.createElement('button'),content=e.doc.createElement('div');
  let calls=0,payload=catalog,fail=false;
  const controller=e.win.PANEL_MARKET_DIRECTORY.createMarketDirectory({document:e.doc,root,status,retry,content,network:{request:async()=>{calls++;if(fail)throw new Error('offline');return {ok:true,json:async()=>payload};}},onSelect:e.hooks().addToWatch,getWatchlist:()=>[...e.hooks().cardCache.keys()]});
  return {e,root,status,retry,content,controller,calls:()=>calls,setFail:value=>fail=value,setPayload:value=>payload=value};
}
await test('directory loads once on expansion, preserves watchlist and only selects explicit symbols',async()=>{
  const d=await directoryFixture();const before=d.e.countFetch('/api/market?');assert.equal(d.calls(),0);
  await Promise.all([d.controller.load(),d.controller.load()]);assert.equal(d.calls(),1);assert.equal(d.e.countFetch('/api/market?'),before);
  const buttons=descendants(d.content).filter(node=>node.dataset.symbol);assert.equal(buttons[0].dataset.symbol,'^FTSE');
  assert.match(buttons[0].getAttribute('aria-label'),/富时100.*指数/);
  buttons[0].click();await d.e.drain();assert.deepEqual([...d.e.hooks().cardCache.keys()],['QQQ','^FTSE']);assert.match(d.status.textContent,/加入/);
  buttons[0].click();await d.e.drain();assert.deepEqual([...d.e.hooks().cardCache.keys()],['QQQ','^FTSE']);assert.match(d.status.textContent,/已在/);
  const filter=descendants(d.content).find(node=>node.id==='marketDirectoryFilter');filter.value='in';for(const fn of filter._handlers.change||[])fn();
  assert.equal(descendants(d.content).filter(node=>node.dataset.market==='uk')[0].hidden,true);assert.equal(descendants(d.content).filter(node=>node.dataset.market==='in')[0].hidden,false);
});
await test('directory failure and malformed data are recoverable without disturbing quotes',async()=>{
  const d=await directoryFixture();d.setFail(true);assert.equal(await d.controller.load(),false);assert.equal(d.retry.hidden,false);assert.match(d.status.textContent,/失败/);
  d.setFail(false);d.setPayload({version:1,markets:[]});assert.equal(await d.controller.load(),false);assert.equal(d.retry.hidden,false);
  d.setPayload(catalog);assert.equal(await d.controller.load(),true);assert.equal(d.retry.hidden,true);assert.deepEqual([...d.e.hooks().cardCache.keys()],['QQQ']);
});
await test('directory respects hundred-card limit and updates membership without replacing focused button',async()=>{
  const d=await directoryFixture(Array.from({length:100},(_,i)=>'S'+i));await d.controller.load();
  const button=descendants(d.content).find(node=>node.dataset.symbol==='^FTSE');button.focus();button.click();await d.e.drain();
  assert.equal(d.e.hooks().cardCache.size,100);assert.match(d.status.textContent,/未添加/);d.controller.syncMembership();assert.equal(d.e.doc.activeElement,button);
});
await test('ampersand search is URL encoded and renders instrument type without HTML injection',async()=>{
  const e=await loadApp({watchlist:[]});await e.drain();e.byId('q').value='M&M.NS';
  e.fetch.push('search',{body:[{symbol:'M&M.NS',name:'Mahindra <example>',type:'EQUITY',market:'印股',exch:'NSE'}]});
  await e.hooks().runSearch();assert.ok(e.fetchLog.includes('/api/search?q=M%26M.NS'));
  assert.match(e.byId('sresults').innerHTML,/股票/);assert.match(e.byId('sresults').innerHTML,/M&amp;M.NS/);assert.match(e.byId('sresults').innerHTML,/&lt;example&gt;/);
});
await test('unannounced special session is explicitly unknown on card and global header',async()=>{
  const e=await loadApp({watchlist:['M&M.NS']});await e.drain();
  for(const coverage of [{known:false,pending:true,warning:'特殊交易日时间尚未公布'},{known:false,reason:'special-session-time-unannounced',warning:'特殊交易日时间尚未公布'}]){
    e.fetch.push('market',{body:[{symbol:'M&M.NS',price:3000,currency:'INR',marketState:'UNKNOWN',calendarCoverage:coverage,charts:{}}]});
    await e.hooks().refresh(false);const card=e.hooks().cardCache.get('M&M.NS');assert.match(card.state.textContent,/待公布/);assert.match(e.byId('session').textContent,/待公布/);assert.match((card.quoteDetails?.textContent||'')+(card.quoteAge?.textContent||'')+(card.sourceCheckAge?.textContent||''),/特殊交易日时间尚未公布/);
  }
});
console.log(`Global frontend: ${passed} passed, ${failures.length} failed`);
if(failures.length)process.exitCode=1;
