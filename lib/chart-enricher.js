import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {publishQuote} from './quote-contract.js';
import {validWeek52Range} from './instruments.js';
import {marketKeyFor,instrumentTypeFor} from './instruments.js';
import {validPrice} from './price-values.js';
import {regularChartTarget,projectRegularBars,chartPreviousClose,recentRegularSessions} from './regular-chart-service.js';
export function createChartEnricher({fetchChart,fetchHistoricalChart,fallback,tx,now=Date.now,includeDaily=true}={}){
 const cache=new Map(),jobs=new Map(),historyCache=new Map(),historyJobs=new Map(),versions=new Map();
 async function family(symbol,kind){
  const key=symbol+':'+kind,old=cache.get(key);if(old&&old.until>now())return old.value;
  if(jobs.has(key))return jobs.get(key);
  const version=versions.get(symbol)||0;
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
     const q=chart.indicators?.quote?.[0]||{},bars=(chart.timestamp||[]).map((t,i)=>({t,c:q.close?.[i],v:q.volume?.[i]??null,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i]})).filter(b=>Number.isFinite(b.t)&&b.t*1000<=now()&&validPrice(b.c,instrumentTypeFor(symbol))&&(kind==='intraday'||[b.o,b.h,b.l].every(value=>validPrice(value,instrumentTypeFor(symbol)))));
     value={bars,source:chart.source||'yahoo',currency:chart.meta?.currency,
       intervalSeconds:chart.meta?.chartIntervalSeconds||({'1m':60,'5m':300}[chart.meta?.dataGranularity]??null),
       pointKind:chart.meta?.chartTimeBasis==='bar-close'?'bar-close':chart.source==='nasdaq-intraday'?'price-point':'bar-start',
       ...validWeek52Range(chart.meta?.fiftyTwoWeekHigh,chart.meta?.fiftyTwoWeekLow),
       ...(chart.meta?.chartTimeContract?{timeContract:chart.meta.chartTimeContract,timeBasis:chart.meta.chartTimeBasis,timeZone:chart.meta.chartTimeZone}:{})};
    }
    if(!value.bars.length)throw new Error('Chart empty');
    value={...value,bars:Object.freeze(value.bars.map(Object.freeze)),updatedAt:now(),stale:false};
   }catch(error){value={...(old?.value||{bars:[],source:'unavailable',updatedAt:null}),stale:true,status:old?.value?.bars?.length?'degraded':'missing',retryable:true,error:'历史来源暂不可用',retryAt:error.retryAt||null};}
   if((versions.get(symbol)||0)===version)cache.set(key,{value,until:Math.max(now()+(value.stale||kind==='intraday'?60000:300000),value.retryAt||0)});
   while(cache.size>MAX_WATCHLIST_SYMBOLS*2)cache.delete(cache.keys().next().value);
   return value;
  })().finally(()=>{if(jobs.get(key)===job)jobs.delete(key);});jobs.set(key,job);return job;
 }
 async function datedHistory(symbol,target){
  if(!fetchHistoricalChart||marketKeyFor(symbol)!=='us')return null;
  const key=symbol+':'+target.targetDate,old=historyCache.get(key);
  if(old?.until>now())return old.value;
  if(historyJobs.has(key))return historyJobs.get(key);
  const version=versions.get(symbol)||0;
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
      value={source:chart.source||'yahoo',updatedAt:now(),stale:false,pointKind:chart.meta.chartTimeBasis==='bar-close'?'bar-close':
        chart.source==='nasdaq-intraday'?'price-point':'bar-start',currency:chart.meta.currency||null,
        intervalSeconds:chart.meta.chartIntervalSeconds||({'1m':60,'5m':300}[chart.meta.dataGranularity]??null),
        bars:chart.timestamp.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]??null}))};
    }catch(error){
      // The failed symbol and target date own this cooldown. Host-wide limits
      // remain with the transport host gate.
      until=Math.max(now()+300000,Number(error.retryAt)||0);
    }
    if((versions.get(symbol)||0)===version)historyCache.set(key,{value,until});
    while(historyCache.size>MAX_WATCHLIST_SYMBOLS*2)historyCache.delete(historyCache.keys().next().value);
    return value;
  })().finally(()=>{if(historyJobs.get(key)===job)historyJobs.delete(key);});
  historyJobs.set(key,job);return job;
 }
 async function enrich(symbol,base){
  if(!base||base.price==null)return fallback(symbol);
  const version=versions.get(symbol)||0;
  const twseNoMinute=marketKeyFor(symbol)==='tw'&&base.src==='twse-mis'&&base.slowFields?.intraday?.status==='no-history';
  const twseDaily=marketKeyFor(symbol)==='tw'&&base.slowFields?.daily30?.source==='twse-stock-day';
  const [i,d]=await Promise.all([
    twseNoMinute?Promise.resolve({...base.slowFields.intraday,bars:base.charts?.intraday||[]}):family(symbol,'intraday'),
    twseDaily?Promise.resolve({...base.slowFields.daily30,bars:base.charts?.daily30||[]}):includeDaily?family(symbol,'daily30'):
      Promise.resolve({bars:base.charts?.daily30||[],source:base.slowFields?.daily30?.source||'on-demand',updatedAt:base.slowFields?.daily30?.updatedAt||null,
       stale:false,status:base.charts?.daily30?.length?'ready':'not-requested'})
  ]);
  const safe=x=>x.currency&&x.currency!==base.currency?{...x,bars:[],week52High:null,week52Low:null,stale:true,status:'missing',error:'图表币种不匹配',retryable:true}:x;
  const intra=safe(i),daily=safe(d),meta=({bars,currency,...m})=>m;
  const range=[intra,daily].find(v=>v.week52High>0&&v.week52Low>0&&v.currency===base.currency),extraRange=range?{week52High:range.week52High,week52Low:range.week52Low}:{};
  const target=regularChartTarget(symbol,now());
  let projectionSource=intra;
  let projected=target.status==='ready'?projectRegularBars(symbol,intra.bars,{source:intra.source,
    pointKind:intra.pointKind||'bar-start',intervalSeconds:intra.intervalSeconds,instrumentType:base.instrumentType,
    targetDate:target.targetDate,now:now()}):null;
  if(target.status==='ready'&&(!projected?.bars.length||projected.tradeDate!==target.targetDate||projected.volumeQuality?.status==='missing')){
    const alternate=await datedHistory(symbol,target);
    if(alternate&&(!alternate.currency||alternate.currency===base.currency)){
      const other=projectRegularBars(symbol,alternate.bars,{source:alternate.source,pointKind:alternate.pointKind,intervalSeconds:alternate.intervalSeconds,instrumentType:base.instrumentType,
        targetDate:target.targetDate,now:now()});
      if(other.tradeDate===target.targetDate&&other.bars.length&&
         (!projected?.bars.length||projected.tradeDate!==target.targetDate||other.volumeQuality.knownBars>0)){projected=other;projectionSource=alternate;}
   }
  }
  if((versions.get(symbol)||0)!==version)return enrich(symbol,base);
  const sourceCheckedAt=Number.isFinite(projectionSource.updatedAt)?projectionSource.updatedAt:null;
  const stale=!!(projectionSource.stale||projectionSource.error||!sourceCheckedAt);
  const regularChart={status:target.status==='unavailable'?'unavailable':projected?.bars.length?
    !stale&&projected.tradeDate===target.targetDate&&!projected.missingReason?'ready':'partial':'unavailable',
    stale,sourceCheckedAt,error:projectionSource.error||null,
    targetDate:target.targetDate||null,tradeDate:projected?.tradeDate||null,
    exchangeZone:target.exchangeZone||null,calendarSource:target.calendarSource||null,
    recentSessions:target.targetDate?recentRegularSessions(symbol,target.targetDate,5):[],
    regularSessions:projected?.regularSessions||target.regularSessions||[],
    bars:projected?.bars||[],source:projected?.source||intra.source,
    pointKind:projected?.pointKind||null,volumeUnit:projected?.volumeUnit||null,
    volumeQuality:projected?.volumeQuality||null,
    previousCloseReference:projected?.tradeDate?chartPreviousClose(base,projected.tradeDate):null,
    missingReason:target.missingReason||twseNoMinute&&'NO_VERIFIED_MINUTE_HISTORY'||(stale?'CHART_SOURCE_STALE':null)||projected?.missingReason||null};
  return publishQuote({...base,...extraRange,regularChart,
    charts:{intraday:intra.bars,daily30:daily.bars.slice(-126)},slowFields:{...(range?{week52Range:{source:range.source,updatedAt:range.updatedAt,stale:range.stale}}:{}),intraday:meta(intra),daily30:meta(daily),charts:{source:intra.source+'/'+daily.source,updatedAt:now(),stale:intra.stale||daily.stale}},daily30Version:daily.bars.at(-1)?.t||0});
 }
 enrich.invalidate=symbol=>{
  versions.set(symbol,(versions.get(symbol)||0)+1);
  for(const map of [cache,jobs,historyCache,historyJobs])for(const key of map.keys())if(key.startsWith(symbol+':'))map.delete(key);
 };
 return enrich;
}
