// Offline end-to-end fixture. Never used by production startup.
import {createApplication} from '../../app.js';
import {quote,record} from './fundamentals-fixture.mjs';
const at=Date.parse('2026-09-18T14:00:00Z'),admin='browser-admin-'.repeat(4),readonly='browser-read-'.repeat(4);
const bars=Array.from({length:60},(_,i)=>({t:at/1000-3600+i*60,c:100+i/100,v:1000+i}));
const app=createApplication({now:()=>at,env:{PORT:0,LOG_FILE:'',STATS_TOKEN:admin,LLM_API_KEY:readonly,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',HISTORY_STATE_PATH:'',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:''},
 providerOverrides:{fetchQuote:async symbol=>quote(symbol,{displayName:'离线验收样本 '+symbol,quoteAt:at,sourceCheckedAt:at,ts:at,regularQuoteAt:at,charts:{intraday:bars},orderBook:{symbol,currency:'USD',asOf:at,checkedAt:at,source:'offline-fixture',coverage:'single-exchange',sizeUnit:'round_lots',bid:{price:105.3,size:2},ask:{price:105.4,size:3}}}),
 fetchFundamentals:async symbol=>{const r=record(symbol,at);r.fields.peTTM={value:20,status:'available',source:'offline-fixture',asOf:at,fetchedAt:at,calculated:true,formula:'regular-price / trailing-EPS',inputs:[{name:'denominator',value:5.268,source:'offline-earnings',asOf:at-86400000,period:'2026-TTM'}]};return r;},
 fetchChart:async symbol=>({meta:{symbol,currency:'USD',instrumentType:'EQUITY',exchangeName:'NASDAQ',exchangeTimezoneName:'America/New_York'},timestamp:Array.from({length:260},(_,i)=>at/1000-(260-i)*86400),indicators:{quote:[{open:Array(260).fill(100),high:Array(260).fill(102),low:Array(260).fill(99),close:Array(260).fill(101),volume:Array(260).fill(1000)}]}})},
 upstream:async url=>({status:200,body:url.includes('news.google.com')?'<rss><channel></channel></rss>':'{"quotes":[],"news":[]}',headers:{}})});
app.start();app.httpServer.once('listening',()=>console.log(JSON.stringify({port:app.httpServer.address().port})));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.stop().then(()=>process.exit()));
