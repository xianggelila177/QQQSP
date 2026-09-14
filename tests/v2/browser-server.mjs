// Offline browser fixture. Not imported or enabled by the production entrypoint.
import {createApplication} from '../../app.js';
import {publishQuote} from '../../lib/quote-contract.js';
const baseAt=Date.now()-60000;let change=0;
const bars=Object.freeze(Array.from({length:100},(_,i)=>Object.freeze({t:Math.floor(baseAt/1000)-6000+i*60,o:100+i/100,h:102+i/100,l:99+i/100,c:100+Math.sin(i/4),v:1000+i})));
const quote=symbol=>publishQuote({symbol,displayName:symbol==='QQQ'?'纳指100 ETF':symbol==='SPY'?'标普500 ETF':'NVIDIA Corporation',market:'美股',marketState:'REGULAR',calendarCoverage:{known:true},
 price:100+change,quoteAt:baseAt+change*1000,ts:baseAt+change*1000,sourceCheckedAt:baseAt,src:'fixture',priceSession:'REGULAR',quoteKind:'snapshot',feedDelayMinutes:0,feedCoverage:'fixture',
 currency:'USD',gmtoff:-14400,instrumentType:symbol==='NVDA'?'EQUITY':'ETF',prevClose:99,change:1+change,changePct:(1+change)/99*100,volume:100000,open:99,dayHigh:102,dayLow:98,pollAfterMs:2000,
 charts:{intraday:bars,daily30:bars},fxMap:{USD:7.1,CNY:1},currency2cny:7.1});
let requests=[];
const app=createApplication({env:{MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PORT:'0',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},providerOverrides:{fetchQuote:async symbol=>quote(symbol),fetchChart:async(symbol)=>({
 meta:{symbol,currency:'USD',instrumentType:'ETF',exchangeName:'NASDAQ',exchangeTimezoneName:'America/New_York',dataGranularity:'1d'},
 timestamp:Array.from({length:360},(_,i)=>Math.floor(baseAt/1000)-(360-i)*86400),indicators:{quote:[{open:Array(360).fill(100),close:Array(360).fill(101),high:Array(360).fill(102),low:Array(360).fill(99),volume:Array(360).fill(100)}]}})},
 upstream:async url=>{requests.push(url);if(url.includes('news.google.com'))return {status:200,body:'<rss><channel><item><title>测试资讯</title><link>https://example.com/story</link><pubDate>'+new Date().toUTCString()+'</pubDate></item></channel></rss>',headers:{}};return {status:200,body:'{"quotes":[],"news":[]}',headers:{}};}});
app.start();app.httpServer.once('listening',()=>console.log(JSON.stringify({port:app.httpServer.address().port})));
process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{if(line.trim()==='change'){change++;for(const symbol of ['QQQ','SPY','NVDA']){app.services.quoteCache.cache?.delete?.(symbol);app.services.quote.cacheMap.delete(symbol);app.services.engine.poke(symbol);}}if(line.trim()==='stats')console.log(JSON.stringify({requests,stats:app.cacheSizes()}));});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.stop().then(()=>process.exit()));
