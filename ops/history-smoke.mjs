// One pass, no aggressive retries: a healthy web process is not proof that
// upstream history works from the deployment server's network.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validSymbol,HISTORY_PERIOD_LIST} from '../lib/history-contract.js';
export async function checkHistory(base,{symbols=['NVDA','MRVL'],periods=HISTORY_PERIOD_LIST,fetchImpl=fetch,timeoutMs=90000}={}){
 const origin=new URL(base);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('无效服务地址');
 if(!Array.isArray(symbols)||!symbols.length||symbols.length>12||symbols.some(s=>!validSymbol(s)))throw new Error('无效证券代码');
 if(periods.some(p=>!HISTORY_PERIOD_LIST.includes(p)))throw new Error('无效图表周期');
 const checks=[];
 for(const symbol of [...new Set(symbols)]){
  for(const period of periods){
   const url=new URL('/api/history',origin);url.search=new URLSearchParams({symbol,period,count:'12'}).toString();
   try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs)}),data=await response.json();
    const bars=data.bars;
    const valid=response.ok&&data.symbol===symbol&&data.period===period&&data.status==='ready'&&Array.isArray(bars)&&bars.length>0&&bars.every((b,i)=>['t','o','h','l','c'].every(k=>Number.isFinite(b[k]))&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c)&&b.h>=b.l&&(!i||b.t>bars[i-1].t));
    checks.push({symbol,period,ok:!!valid,httpStatus:response.status,status:data.status,source:data.source,bars:bars?.length||0,asOf:data.historyAsOf??data.bars?.at(-1)?.lastTradingDate??null,error:valid?undefined:data.error||data.code||data.status||'没有有效 K 线',retryAt:data.retryAt??null});
    // The four tabs share one raw history. Do not repeat a failing/cooling read.
    if(!valid)break;
   }catch(error){checks.push({symbol,period,ok:false,error:error.message});break;}
  }
 }
 return {ok:checks.every(c=>c.ok),mode:'real history API, no test prices injected',origin:origin.origin,checkedAt:new Date().toISOString(),checks};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await checkHistory(process.argv[2]||'http://127.0.0.1:8568',{symbols:process.argv[3]?.split(',')});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
