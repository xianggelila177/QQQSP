import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForCharts} from './chart-smoke.mjs';
import {isUsableChartFamily} from '../lib/quote-contract.js';

export function livePointFailures(quote,history,now=Date.now()){
 const failures=[],point=quote?.intradayLivePoint;
 if(!quote||quote.error||quote.pending||quote.stale||quote.staleInfo||quote.recovery||quote.offlineRecovery||quote.marketState!=='REGULAR')return ['active regular-session quote required'];
 const tail=history?.at(-1),lead=tail?.t*1000-quote.quoteAt;
 // A newer history source must not be overwritten by an older fast quote.
 // This narrowly accepts the intentional null-point handoff, never bad points.
 if(point===null&&quote.intradayLiveStatus==='unavailable'&&isUsableChartFamily(history)&&
    Number.isFinite(quote.price)&&quote.price>0&&Number.isFinite(quote.quoteAt)&&quote.quoteAt>0&&
    typeof quote.currency==='string'&&quote.currency&&typeof quote.src==='string'&&quote.src&&
    Number.isFinite(now)&&quote.quoteAt<=now&&now-quote.quoteAt<=30000&&
    Number.isFinite(lead)&&lead>0&&lead<=10000&&tail.t*1000<=now)return [];
 if(quote.intradayLiveStatus!=='ready'||!point)return ['latest quote point unavailable'];
 if(!Array.isArray(history)||!history.length)failures.push('historical intraday data unavailable');
 if(!Number.isFinite(quote.price)||quote.price<=0||!Number.isFinite(point.c)||Math.abs(point.c-quote.price)>Math.max(1e-8,Math.abs(quote.price)*1e-10))failures.push('latest point price differs from quote');
 if(!Number.isFinite(point.t)||point.t<=0||!Number.isFinite(quote.quoteAt)||Math.abs(point.t*1000-quote.quoteAt)>1)failures.push('latest point time differs from quote');
 if(!Number.isFinite(now)||point.t*1000>now)failures.push('latest point is in the future');
 if(point.t<(history?.at(-1)?.t??Infinity))failures.push('latest point precedes historical tail');
 if(point.v!==null||['o','h','l'].some(key=>Object.hasOwn(point,key)))failures.push('quote point must not fabricate volume or OHLC');
 if(!point.currency||point.currency!==quote.currency)failures.push('latest point currency differs from quote');
 if(!point.source||point.source!==quote.src)failures.push('latest point source differs from quote');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(point.sessionDate)||point.sessionDate!==point.historyDate)failures.push('latest point crosses historical session date');
 return failures;
}

export async function runIntradaySmoke(base,{symbols=['QQQ','SPY'],durationMs=20000,fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const origin=new URL(base);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('Invalid origin');
 if(!Number.isFinite(durationMs)||durationMs<6000||durationMs>60000)throw new Error('Duration must be 6 to 60 seconds');
 const safeFetch=(url,options)=>fetchImpl(url,{...options,redirect:'error'});
 await waitForCharts(origin,{symbols,fetchImpl:safeFetch,now,sleep});
 const cached=new Map(),versions=new Map(),observations=[],failures=[];
 const started=now();
 do{
  const url=new URL('/api/market',origin);url.searchParams.set('symbols',symbols.join(','));
  if(versions.size)url.searchParams.set('cv',[...versions].map(([s,v])=>s+':'+v.i+':'+v.d).join(';'));
  const response=await safeFetch(url,{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Market readback unavailable');
  const quotes=await response.json();if(!Array.isArray(quotes))throw new Error('Invalid market readback');
  for(const symbol of symbols){
   const matches=quotes.filter(q=>q?.symbol===symbol),quote=matches[0];
   if(matches.length!==1){failures.push(symbol+': missing or duplicate quote');continue;}
   const incoming=quote.charts?.intraday;
   if(Array.isArray(incoming))cached.set(symbol,incoming);
   else if(incoming!=='same')failures.push(symbol+': invalid intraday transfer');
   else if(versions.get(symbol)?.i!==quote.intradayVer)failures.push(symbol+': conditional history revision mismatch');
   const history=cached.get(symbol);
   failures.push(...livePointFailures(quote,history,now()).map(reason=>symbol+': '+reason));
   if(Number.isSafeInteger(quote.intradayVer)&&Number.isSafeInteger(quote.daily30Ver))versions.set(symbol,{i:quote.intradayVer,d:quote.daily30Ver});
   observations.push({at:now(),symbol,price:quote.price,quoteAt:quote.quoteAt,historyLast:history?.at(-1)??null,historyVersion:quote.intradayVer,transfer:incoming==='same'?'same':'full',point:quote.intradayLivePoint??null,status:quote.intradayLiveStatus??null,historyAhead:quote.intradayLivePoint===null&&quote.intradayLiveStatus==='unavailable'&&history?.at(-1)?.t*1000>quote.quoteAt});
  }
  if(now()-started>=durationMs)break;
  await sleep(Math.min(2000,durationMs-(now()-started)));
 }while(now()-started<=durationMs);
 const summary=symbols.map(symbol=>{
  const rows=observations.filter(q=>q.symbol===symbol);
  const changes=rows.slice(1).filter((q,i)=>q.price!==rows[i].price||q.quoteAt!==rows[i].quoteAt).length;
  const same=rows.filter(q=>q.transfer==='same').length;
  const matched=rows.filter(q=>q.point&&q.status==='ready');
  const matchedUpdates=matched.slice(1).filter((q,i)=>q.price!==matched[i].price||q.quoteAt!==matched[i].quoteAt).length;
  const matchedSame=matched.filter(q=>q.transfer==='same').length;
  if(matched.length<3)failures.push(symbol+': insufficient matched quote points');
  if(!matchedUpdates)failures.push(symbol+': no changing matched quote points observed');
  if(!matchedSame)failures.push(symbol+': no conditional transfer with a matched point observed');
  if(!changes)failures.push(symbol+': no changing quote observed during acceptance window');
  if(!same)failures.push(symbol+': no conditional history transfer observed');
  return {symbol,samples:rows.length,quoteUpdates:changes,sameTransfers:same,matchedPoints:matched.length,matchedQuoteUpdates:matchedUpdates,matchedSameTransfers:matchedSame,historyAheadSamples:rows.filter(q=>q.historyAhead).length};
 });
 return {ok:!failures.length,checkedAt:new Date(now()).toISOString(),durationMs,summary,failures:[...new Set(failures)],observations};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await runIntradaySmoke(process.argv[2]||'http://127.0.0.1:8567',{symbols:process.argv[3]?.split(',')||['QQQ','SPY'],durationMs:Number(process.argv[4]||20)*1000});console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;}
 catch{console.error('Live intraday acceptance failed');process.exitCode=1;}
}
