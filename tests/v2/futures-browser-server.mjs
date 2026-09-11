// Test-only upstream fixtures. Never imported by production server.js.
import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
const now=Date.now();
const rows=[];
for(let t=Date.parse('2020-01-02T12:00:00Z'),i=0;t<now-86400000;t+=86400000,i++){
 if([0,6].includes(new Date(t).getUTCDay()))continue;
 const o=21000+i*.5+100*Math.sin(i/13),c=o+50*Math.sin(i);
 rows.push([new Date(t).toISOString().slice(0,10),o,c,Math.max(o,c)+70,Math.min(o,c)-70,12000+i].join(','));
}
const app=createApplication({env:{PORT:0,SYMBOLS:'',REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0'},telemetry:createTelemetry(),upstream:async url=>{
 const u=new URL(url),secid=u.searchParams.get('secid')||'',code=secid.split('.')[1];
 const ok=data=>({status:200,headers:{},body:JSON.stringify(data)});
 if(u.pathname.endsWith('/stock/get'))return ok({data:{f57:code,f43:25234.75,f44:25300,f45:25000,f46:25100,f47:23456,f60:25100,f86:Math.floor(now/1000)-10,f169:134.75,f170:.53685}});
 if(u.pathname.endsWith('/kline/get'))return ok({data:{code,market:Number(secid.split('.')[0]),klines:rows}});
 if(u.hostname==='futsseapi.eastmoney.com')return ok({total:2,list:[{dm:'NQ26Z',name:'小型纳指12月'},{dm:'NQ26U',name:'小型纳指9月'}]});
 if(u.pathname==='/v1/finance/search')return ok({quotes:[{symbol:'NQ=F',quoteType:'FUTURE',typeDisp:'Futures',shortname:'Nasdaq 100 futures'}]});
 if(u.pathname.includes('/v8/finance/chart/')){
  const symbol=decodeURIComponent(u.pathname.split('/').at(-1)),daily=u.searchParams.get('interval')==='1d';
  return ok({chart:{result:[{meta:{symbol,instrumentType:'FUTURE',currency:'USD',exchangeName:'CME',exchangeTimezoneName:'America/Chicago',regularMarketPrice:25234.75,regularMarketTime:Math.floor(now/1000)-10,previousClose:25100,dataGranularity:daily?'1d':'1m'},
   timestamp:daily?rows.map(r=>Date.parse(r.split(',')[0]+'T12:00:00Z')/1000):[Math.floor(now/1000)-180,Math.floor(now/1000)-120,Math.floor(now/1000)-60],
   indicators:{quote:[daily?Object.fromEntries(['open','close','high','low','volume'].map((key,i)=>[key,rows.map(r=>Number(r.split(',')[i+1]))])):{open:[25090,25100,25200],high:[25110,25210,25260],low:[25080,25095,25190],close:[25100,25200,25234.75],volume:[100,200,300]}]}}]}});
 }
 return {status:429,headers:{'Retry-After':'60'},body:''};
}});
app.start();await once(app.httpServer,'listening');console.log(JSON.stringify({port:app.httpServer.address().port}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.stop().then(()=>process.exit()));
