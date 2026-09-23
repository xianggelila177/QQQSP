import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {publishQuote} from './quote-contract.js';
import {validWeek52Range} from './instruments.js';
import {marketKeyFor} from './instruments.js';
import {regularChartTarget,projectRegularBars,chartPreviousClose,recentRegularSessions} from './regular-chart-service.js';
export function createChartEnricher({fetchChart,fetchHistoricalChart,fallback,tx,now=Date.now,includeDaily=true}={}){
 const cache=new Map(),jobs=new Map(),historyCache=new Map(),historyJobs=new Map();
 let historicalCooldown=0;
 async function family(symbol,kind){
  const key=symbol+':'+kind,old=cache.get(key);if(old&&old.until>now())return old.value;
  if(jobs.has(key))return jobs.get(key);
  const job=(async()=>{
   let value;
   try{
    let chart;
    if(/^\d{6}\.(SS|SZ)$/.test(symbol)){
     const bars=kind==='intraday'?await tx.txMinuteBarsCn(symbol):await tx.txDailyBarsCn(symbol,320);
     value={bars,source:'tencent'};
    }else{
     chart=await fetchChart(symbol,kind==='intraday'?'?interval=5m&range=1d&includePrePost=true':'?interval=1d&range=2y&includePrePost=false');
     if(chart.meta?.symbol&&chart.meta.symbol.toUpperCase()!==symbol)throw new Error('Chart identity mismatch');
     const q=chart.indicators?.quote?.[0]||{},bars=(chart.timestamp||[]).map((t,i)=>({t,c:q.close?.[i],v:q.volume?.[i]??null,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i]})).filter(b=>Number.isFinite(b.t)&&b.t*1000<=now()&&b.c>0&&(kind==='intraday'||[b.o,b.h,b.l].every(Number.isFinite)));
     value={bars,source:chart.source||'yahoo',currency:chart.meta?.currency,...validWeek52Range(chart.meta?.fiftyTwoWeekHigh,chart.meta?.fiftyTwoWeekLow),...(chart.meta?.chartTimeContract?{timeContract:chart.meta.chartTimeContract,timeBasis:chart.meta.chartTimeBasis,timeZone:chart.meta.chartTimeZone}:{})};
    }
    if(!value.bars.length)throw new Error('Chart empty');
    value={...value,bars:Object.freeze(value.bars.map(Object.freeze)),updatedAt:now(),stale:false};
   }catch(error){value={...(old?.value||{bars:[],source:'unavailable',updatedAt:null}),stale:true,status:old?.value?.bars?.length?'degraded':'missing',retryable:true,error:'历史来源暂不可用',retryAt:error.retryAt||null};}
   cache.set(key,{value,until:Math.max(now()+(value.stale||kind==='intraday'?60000:300000),value.retryAt||0)});
   while(cache.size>MAX_WATCHLIST_SYMBOLS*2)cache.delete(cache.keys().next().value);
   return value;
  })().finally(()=>jobs.delete(key));jobs.set(key,job);return job;
 }
 async function datedYahoo(symbol,target){
  if(!fetchHistoricalChart||marketKeyFor(symbol)!=='us'||historicalCooldown>now())return null;
  const key=symbol+':'+target.targetDate,old=historyCache.get(key);
  if(old?.until>now())return old.value;
  if(historyJobs.has(key))return historyJobs.get(key);
  const job=(async()=>{
    let value=null,until=now()+300000;
    try{
      const open=target.regularSessions[0].open_at_ms,close=target.regularSessions.at(-1).close_at_ms;
      const query='?interval=5m&period1='+Math.floor((open-3600000)/1000)+
        '&period2='+Math.ceil((close+3600000)/1000)+'&includePrePost=false';
      const chart=await fetchHistoricalChart(symbol,query);
      if(chart?.meta?.symbol&&chart.meta.symbol.toUpperCase()!==symbol||
        chart?.meta?.dataGranularity!=='5m'||!Array.isArray(chart.timestamp)||!chart.indicators?.quote?.[0])
        throw new Error('Historical chart identity or granularity mismatch');
      const q=chart.indicators.quote[0];
      value={source:'yahoo',currency:chart.meta.currency||null,
        bars:chart.timestamp.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]??null}))};
    }catch(error){
      if(error.status===429||error.code==='SOURCE_COOLDOWN'||error.code==='RATE_LIMITED')
        historicalCooldown=Math.max(now()+300000,Number(error.retryAt)||0);
      until=Math.max(now()+300000,Number(error.retryAt)||0);
    }
    historyCache.set(key,{value,until});
    while(historyCache.size>MAX_WATCHLIST_SYMBOLS*2)historyCache.delete(historyCache.keys().next().value);
    return value;
  })().finally(()=>historyJobs.delete(key));
  historyJobs.set(key,job);return job;
 }
 return async function enrich(symbol,base){
  if(!base||base.price==null)return fallback(symbol);
  const [i,d]=await Promise.all([family(symbol,'intraday'),includeDaily?family(symbol,'daily30'):Promise.resolve({bars:base.charts?.daily30||[],source:'on-demand',updatedAt:null,stale:false,status:'not-requested'})]);
  const safe=x=>x.currency&&x.currency!==base.currency?{...x,bars:[],week52High:null,week52Low:null,stale:true,status:'missing',error:'图表币种不匹配',retryable:true}:x;
  const intra=safe(i),daily=safe(d),meta=({bars,currency,...m})=>m;
  const range=[intra,daily].find(v=>v.week52High>0&&v.week52Low>0&&v.currency===base.currency),extraRange=range?{week52High:range.week52High,week52Low:range.week52Low}:{};
  const target=regularChartTarget(symbol,now());
  let projected=target.status==='ready'?projectRegularBars(symbol,intra.bars,{source:intra.source,
    pointKind:intra.source==='nasdaq-intraday'?'price-point':'bar-start',instrumentType:base.instrumentType,
    targetDate:target.targetDate,now:now()}):null;
  if(target.status==='ready'&&(!projected?.bars.length||projected.tradeDate!==target.targetDate||projected.volumeQuality?.status==='missing')){
    const alternate=await datedYahoo(symbol,target);
    if(alternate&&(!alternate.currency||alternate.currency===base.currency)){
      const other=projectRegularBars(symbol,alternate.bars,{source:alternate.source,instrumentType:base.instrumentType,
        targetDate:target.targetDate,now:now()});
      if(other.tradeDate===target.targetDate&&other.bars.length&&
         (!projected?.bars.length||projected.tradeDate!==target.targetDate||other.volumeQuality.knownBars>0))projected=other;
    }
  }
  const regularChart={status:target.status==='unavailable'?'unavailable':projected?.bars.length?
    projected.tradeDate===target.targetDate?'ready':'partial':'unavailable',
    targetDate:target.targetDate||null,tradeDate:projected?.tradeDate||null,
    exchangeZone:target.exchangeZone||null,calendarSource:target.calendarSource||null,
    recentSessions:target.targetDate?recentRegularSessions(symbol,target.targetDate,5):[],
    regularSessions:projected?.regularSessions||target.regularSessions||[],
    bars:projected?.bars||[],source:projected?.source||intra.source,
    pointKind:projected?.pointKind||null,volumeUnit:projected?.volumeUnit||null,
    volumeQuality:projected?.volumeQuality||null,
    previousCloseReference:projected?.tradeDate?chartPreviousClose(base,projected.tradeDate):null,
    missingReason:target.missingReason||projected?.missingReason||null};
  return publishQuote({...base,...extraRange,regularChart,
    charts:{intraday:intra.bars,daily30:daily.bars.slice(-126)},slowFields:{...(range?{week52Range:{source:range.source,updatedAt:range.updatedAt,stale:range.stale}}:{}),intraday:meta(intra),daily30:meta(daily),charts:{source:intra.source+'/'+daily.source,updatedAt:now(),stale:intra.stale||daily.stale}},daily30Version:daily.bars.at(-1)?.t||0});
 };
}
