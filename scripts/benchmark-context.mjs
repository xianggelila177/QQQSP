// Pure formatting benchmark with deterministic offline data; no provider requests.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const root=path.resolve(process.argv[2]||'.');
const {buildMarketContext}=await import(pathToFileURL(path.join(root,'lib/market-context-format.js')).href);
const at=Date.parse('2026-09-18T20:00:00Z'),dayMs=86400000;
const quote={symbol:'NVDA',price:100,currency:'USD',quoteAt:at,sourceCheckedAt:at,src:'fixture',instrumentType:'EQUITY',priceSession:'REGULAR',marketState:'CLOSED',charts:{intraday:Array.from({length:390},(_,i)=>({t:(at-390*60000+i*60000)/1000,c:100+i/10000,v:1000}))},slowFields:{intraday:{source:'fixture',updatedAt:at}},fundamentals:{fields:{peTTM:{value:20,status:'available',unit:'ratio',source:'fixture',asOf:at,fetchedAt:at}}}};
const daily={symbol:'NVDA',currency:'USD',source:'fixture',sourceCheckedAt:at,bars:Array.from({length:500},(_,i)=>{const t=Date.parse('2026-09-18T00:00:00Z')-(499-i)*dayMs;return {t:t/1000,periodStart:new Date(t).toISOString().slice(0,10),o:100,h:102,l:99,c:101,v:1000};})};
const dates=['2026-09-16','2026-09-17','2026-09-18'];const samples={symbol:'NVDA',tradingDays:dates,intervalMs:60000,points:dates.flatMap(day=>Array.from({length:390},(_,i)=>({t:Date.parse(day+'T13:30:00Z')/1000+i*60,c:100,observedAt:at,sourceCheckedAt:at,source:'fixture',currency:'USD',tradingDate:day,priceSession:'REGULAR'})))};
const results=[];
for(const [name,include] of [['analysis',['quote','intraday','daily','samples','fundamentals','news','macro']],['snapshot',['quote','fundamentals']]]){
 const query={symbol:'NVDA',daily_bar_count:500,sample_trading_days:3,include};
 const input={query,requestId:'benchmark',generatedAt:at,quote,daily,samples,news:{items:[],updatedAt:at}};
 for(let i=0;i<3;i++)buildMarketContext(input);global.gc?.();
 const cpu=process.cpuUsage(),times=[];let bytes=0;
 for(let i=0;i<20;i++){const start=performance.now();bytes=Buffer.byteLength(JSON.stringify(buildMarketContext(input)));times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);const usage=process.cpuUsage(cpu);
 results.push({name,iterations:20,p50_ms:+times[9].toFixed(3),p95_ms:+times[18].toFixed(3),max_ms:+times[19].toFixed(3),response_bytes:bytes,cpu_ms:+((usage.user+usage.system)/1000).toFixed(3)});
}
console.log(JSON.stringify({node:process.versions.node,mode:'offline deterministic projection + JSON serialization',rows:{intraday:390,daily:500,samples:1170},results},null,2));
