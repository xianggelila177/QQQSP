import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {checkHistory} from './history-smoke.mjs';
import {isUsableChartFamily} from '../lib/quote-contract.js';

function smokeSymbols(symbols) {
 if(!Array.isArray(symbols)||symbols.length===0||Array.from(symbols).some(symbol=>typeof symbol!=='string'||symbol.length>16||!/^\^?[A-Z0-9][A-Z0-9.&=-]*$/.test(symbol)||/\s/.test(symbol)))throw new Error('Invalid smoke-test symbols');
 const unique=[...new Set(symbols)];
 if(unique.length>12)throw new Error('Invalid smoke-test symbols');
 return unique;
}
export function chartFailures(quotes,symbols=['QQQ','SPY']) {
 symbols=smokeSymbols(symbols);
 const failures=[];
 if(!Array.isArray(quotes))return ['invalid market payload'];
 for(const symbol of symbols){
  const quote=quotes.find(q=>q?.symbol===symbol);
  if(!quote||quote.error||quote.pending||quote.stale||quote.staleInfo||quote.recovery||quote.price==null||!Number.isFinite(Number(quote.price))||Number(quote.price)<=0){failures.push(symbol+':quote unavailable');continue;}
  for(const key of ['intraday','daily30']){
   const bars=quote.charts?.[key],meta=quote.slowFields?.[key]??quote.slowFields?.charts;
   if(!isUsableChartFamily(bars))failures.push(symbol+':'+key+' unavailable');
   else if(!meta||meta.stale!==false||!Number.isFinite(meta.updatedAt)||meta.updatedAt<=0||meta.expired||meta.retryable||meta.error||['failed','error','missing','degraded','unsupported','no-history','not-applicable'].includes(meta.status))failures.push(symbol+':'+key+' awaiting source recovery');
  }
 }
 return failures;
}
export async function waitForCharts(base,{symbols=['QQQ','SPY'],deadlineMs=120000,fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 symbols=smokeSymbols(symbols);
 const url=new URL('/api/market',base);
 url.searchParams.set('symbols',symbols.join(','));
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid smoke-test origin');
 const end=now()+deadlineMs;let failures=['not checked'];
 do {
  try{
   const response=await fetchImpl(url,{signal:AbortSignal.timeout(3000)});
   failures=response.ok?chartFailures(await response.json(),symbols):['HTTP '+response.status];
   if(!failures.length)return {ok:true,symbols,checkedAt:new Date(now()).toISOString()};
  }catch{failures=['request unavailable'];}
  if(now()>=end)break;
  await sleep(Math.min(1000,end-now()));
 }while(now()<=end);
 throw new Error('Chart acceptance failed: '+failures.join('; '));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await checkHistory(process.argv[2]||'http://127.0.0.1:8568',{symbols:process.argv[3]===undefined?undefined:process.argv[3].split(',')});console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
