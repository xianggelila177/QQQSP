// Injected only by the offline browser test. Production never imports this file.
window.__requests=[];window.__streams=[];window.__streamFail=false;
const memory=new Map([['qqq-watchlist','["SPY","QQQ","NVDA"]'],['qqq-refresh-mode','continuous']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});
window.__PANEL_TEST_HOOK__=value=>window.__app=value;
window.__baseAt=Date.now()-60000;
const bars=Array.from({length:100},(_,i)=>({t:Math.floor(window.__baseAt/1000)-6000+i*60,o:100+i/100,h:102+i/100,l:99+i/100,c:100+Math.sin(i/4),v:1000+i}));
window.__quote=(symbol,price=100)=>({symbol,displayName:symbol==='QQQ'?'纳指100 ETF':symbol==='SPY'?'标普500 ETF':'NVIDIA Corporation',market:'美股',marketState:'REGULAR',calendarCoverage:{known:true},
 price,quoteAt:window.__baseAt,ts:window.__baseAt,sourceCheckedAt:window.__baseAt,src:'fixture',priceSession:'REGULAR',quoteKind:'snapshot',feedDelayMinutes:0,feedCoverage:'fixture',
 currency:'USD',gmtoff:-14400,instrumentType:symbol==='NVDA'?'EQUITY':'ETF',prevClose:99,change:price-99,changePct:(price-99)/99*100,volume:100000,open:99,dayHigh:102,dayLow:98,pollAfterMs:2000,
 charts:{intraday:bars,daily30:bars},fxMap:{USD:7.1,CNY:1},currency2cny:7.1});
window.fetch=async input=>{
 const url=String(input);window.__requests.push({url,at:performance.now()});const params=new URL(url,'http://fixture.test').searchParams;
 let data=url.includes('/api/market')?(params.get('symbols')||'').split(',').map(s=>__quote(s)):
 url.includes('/api/news')?Object.fromEntries((params.get('symbols')||'').split(',').map(s=>[s,[{title:'离线测试资讯',src:'测试',t:Date.now(),link:'https://example.com',sent:'中性'}]])):
 url.includes('/api/macro')?{items:[],updatedAt:Date.now(),stale:false,sources:{}}:
 url.includes('/api/history')?{symbol:params.get('symbol'),period:params.get('period'),bars:[],status:'empty',stale:false,seriesId:'fixture',revision:'1',hasMore:false,warnings:[],source:'fixture',currency:'USD'}:[];
 return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','X-Server-Now-Ms':String(Date.now())}});
};
window.EventSource=class extends EventTarget{
 constructor(url){super();this.url=url;this.closed=false;__streams.push(this);
  this.initial=setTimeout(()=>{
    if(this.closed)return;if(__streamFail){this.onerror?.(new Event('error'));return;}
    if(url==='/api/macro/stream'){
      const payload={revision:1,news:{analysisVersion:1,items:[],updatedAt:Date.now()},context:{schemaVersion:2,factors:[],observations:[],calendar:{enabled:false}},monitor:{enabled:false,running:false,lanes:{news:{},context:{}},persistence:{},delivery:{}}};
      this.dispatchEvent(new MessageEvent('macro',{data:JSON.stringify(payload)}));return;
    }
    const symbols=(new URL(url,'http://fixture.test').searchParams.get('symbols')||'').split(',').filter(Boolean);
    this.emit(symbols.map(s=>__quote(s)));
  },100);
  this.pulse=setInterval(()=>{if(!this.closed)this.dispatchEvent(new MessageEvent('heartbeat',{data:JSON.stringify({serverNow:Date.now()})}));},15000);
 }
 emit(quotes){if(!this.closed)this.dispatchEvent(new MessageEvent('quotes',{data:JSON.stringify({serverNow:Date.now(),quotes})}));}
 close(){this.closed=true;clearInterval(this.pulse);clearTimeout(this.initial);}
};
