// Real application + history source/enrichment + HTTP/SSE, synthetic upstream
// payloads. This entry is never imported by server.js or copied by install.sh.
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
const at=Date.parse('2026-09-11T14:16:12Z'),started=Date.now();
const now=()=>at+Date.now()-started;
const calls=[];
const prices={LITE:928.34,AAOI:105.85,ALAB:293,INTC:103.45};
const quote=symbol=>({symbol,displayName:symbol,market:'美股',marketState:'REGULAR',calendarCoverage:{known:true},price:prices[symbol]||100,
 quoteAt:at-12000,ts:at-12000,sourceCheckedAt:at,src:'test-batch',priceSession:'REGULAR',quoteKind:'snapshot',currency:'USD',gmtoff:-14400,instrumentType:'EQUITY',prevClose:prices[symbol]*.99,
 change:prices[symbol]*.01,changePct:1,pollAfterMs:1000,open:prices[symbol]*.98,dayHigh:prices[symbol]*1.01,dayLow:prices[symbol]*.97,volume:10000,feedDelayMinutes:0,fxMap:{USD:7,CNY:1},fxStale:false,charts:{intraday:[],daily30:[]}});
const app=createApplication({now,env:{MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',RECOVERY_PATH:'',PORT:0,PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'1'},telemetry:createTelemetry(),providerOverrides:{fetchSnapshotBatch:async symbols=>({quotes:symbols.map(quote),pollAfterMs:1000})},upstream:async url=>{
 calls.push(url);const u=new URL(url),symbol=u.pathname.split('/')[3];
 if(u.hostname==='api.nasdaq.com'&&u.pathname.endsWith('/chart')){
  return {status:200,body:JSON.stringify({data:{symbol,chart:Array.from({length:47},(_,i)=>{
   const x=Date.parse('2026-09-11T09:30:00Z')+i*60000,d=new Date(x),hour=d.getUTCHours(),minute=String(d.getUTCMinutes()).padStart(2,'0');
   return {x,y:(prices[symbol]||100)*(1-.01*(46-i)/46)+Math.sin(i)*.1,z:{dateTime:`Sep 11, 2026 ${hour}:${minute} AM`,value:'fixture'}};
  })}})};
 }
 if(u.hostname==='api.nasdaq.com'&&u.pathname.endsWith('/historical')){
  const rows=[];for(let t=Date.parse('2017-01-03T12:00:00Z');t<at;t+=86400000){const d=new Date(t);if([0,6].includes(d.getUTCDay()))continue;rows.push({date:`${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,open:100,high:102,low:98,close:101,volume:1000});}
  return {status:200,body:JSON.stringify({data:{symbol,tradesTable:{rows}}})};
 }
 return {status:429,headers:{'retry-after':'120'},body:''};
}});
app.start();await once(app.httpServer,'listening');console.log(JSON.stringify({port:app.httpServer.address().port,fixture:true,at}));
process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{if(line.trim()==='stats')console.log(JSON.stringify({calls}));});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>app.stop().then(()=>process.exit(0)));
