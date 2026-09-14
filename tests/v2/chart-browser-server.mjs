// Real application + real HTTP/SSE, controlled upstream responses only.
// Production server.js never imports or enables this fixture server.
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {publishQuote} from '../../lib/quote-contract.js';
const now=Date.now(),end=new Date(now).toISOString().slice(0,10);
const sourceRows=[];
for(let t=Date.parse('1990-01-02T12:00:00Z'),i=0;t<now-86400000;t+=86400000,i++){
 if([0,6].includes(new Date(t).getUTCDay()))continue;
 const date=new Date(t).toISOString().slice(0,10),[y,m,d]=date.split('-'),o=120+i*.01+4*Math.sin(i/8),c=o+Math.sin(i)*1.5;
 sourceRows.push({iso:date,date:`${m}/${d}/${y}`,open:o.toFixed(2),high:(Math.max(o,c)+1).toFixed(2),low:(Math.min(o,c)-1).toFixed(2),close:c.toFixed(2),volume:String(100000+i*10)});
}
function quote(symbol){
 const history=symbol==='ALAB'?Array.from({length:100},(_,i)=>({t:Math.floor(now/1000)-9000+i*60,o:298,h:309,l:290,c:298+Math.sin(i/8)*3,v:1000+i})):[];
 return publishQuote({symbol,displayName:symbol,market:'美股',marketState:'REGULAR',calendarCoverage:{known:true},price: symbol==='ALAB'?301:symbol==='INTC'?104.56:220,
  quoteAt:now-5000,ts:now-5000,sourceCheckedAt:now,src:'test-fixture',priceSession:'REGULAR',quoteKind:'snapshot',currency:'USD',gmtoff:-14400,instrumentType:'EQUITY',prevClose:219,change:1,changePct:1/219*100,pollAfterMs:1000,
  open:218,dayHigh:222,dayLow:217,volume:100000,feedDelayMinutes:0,fxMap:{USD:7.1,CNY:1},currency2cny:7.1,
  charts:{intraday:history,daily30:[]},slowFields:{intraday:{source:'nasdaq-intraday',updatedAt:now,stale:false}}});
}
const calls=[];
const app=createApplication({env:{HISTORY_STATE_PATH:'',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',PORT:0,REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},telemetry:createTelemetry(),providerOverrides:{fetchQuote:async symbol=>quote(symbol)},upstream:async url=>{
 calls.push(url);const u=new URL(url);
 if(u.hostname==='api.nasdaq.com'&&u.pathname.includes('/historical')){
  const symbol=u.pathname.split('/')[3];
  if(symbol==='NVDA'){
   await new Promise(r=>setTimeout(r,50));const start=u.searchParams.get('fromdate')||'1990-01-01';
   return {status:200,body:JSON.stringify({data:{symbol,totalRecords:sourceRows.length,tradesTable:{rows:sourceRows.filter(r=>r.iso>=start).slice().reverse()}}})};
  }
  if(symbol==='MRVL')return {status:200,body:JSON.stringify({data:{symbol,tradesTable:{rows:[]}}})};
 }
 if(u.hostname==='push2his.eastmoney.com'&&u.searchParams.get('secid')==='105.MRVL'){
  const start=u.searchParams.get('beg')||'19900101';
  return {status:200,body:JSON.stringify({data:{code:'MRVL',market:105,klines:sourceRows.filter(r=>r.iso.replaceAll('-','')>=start).map(r=>[r.iso,r.open,r.close,r.high,r.low,r.volume,'100000','0','0','0','0'].join(','))}})};
 }
 return {status:429,headers:{'retry-after':'120'},body:''};
}});
app.start();await once(app.httpServer,'listening');console.log(JSON.stringify({port:app.httpServer.address().port,fixture:true,asOf:now,end}));
process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{if(line.trim()==='stats')console.log(JSON.stringify({calls,stats:app.cacheSizes()}));});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.stop().then(()=>process.exit()));
