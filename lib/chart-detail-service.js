import {regularChartTarget,recentRegularSessions,projectRegularBars,chartPreviousClose} from './regular-chart-service.js';
import {normalizeOrderBook} from './order-book.js';
import {instrumentTypeFor,marketKeyFor} from './instruments.js';

// Browser-facing read-only projection. Provider credentials stay inside the server.
export function createChartDetailService({readQuote,fetchChart,advanced,tape,streamState,now=Date.now}={}){
  const cache=new Map(),jobs=new Map();let cooldownUntil=0;
  async function alpacaFiveDay(symbol,quote,sessions,signal){
    if(marketKeyFor(symbol)!=='us'||advanced?.capabilities?.()?.intraday?.authenticated!==true)return null;
    const results=await Promise.all(sessions.map(day=>advanced.intraday({symbol,intraday_date:day.date},{signal})
      .then(value=>({value})).catch(error=>({error}))));
    const sources=new Set(results.map(r=>r.value?.source).filter(Boolean));
    if(sources.size!==1)return null;
    const source=[...sources][0],days=sessions.map((day,i)=>{
      const data=results[i].value,usable=data?.source===source&&data?.currency===quote.currency&&
        data?.volumeUnit==='shares'&&data?.adjustment==='raw';
      const projection=usable?projectRegularBars(symbol,data.points,{source,instrumentType:instrumentTypeFor(symbol),
        targetDate:day.date,now:now()}):null;
      const matched=projection?.tradeDate===day.date;
      return {date:day.date,status:matched?(now()<day.sessions.at(-1).close_at_ms?'partial':'ready'):'missing',
        bars:matched?projection.bars:[],regularSessions:day.sessions,
        volumeQuality:matched?projection.volumeQuality:null,
        missingReason:matched?null:results[i].error?.code||data?.missing_reason||'SOURCE_DAY_MISSING'};
    });
    const covered=days.filter(d=>d.status!=='missing').length,open=days.some(d=>d.status==='partial');
    if(!covered)return null;
    return {status:covered===5&&!open?'ready':'partial',reason:covered<5?'FIVE_DAY_SOURCE_GAPS':open?'FIVE_DAY_SESSION_OPEN':null,
      source,currency:quote.currency,volumeUnit:'shares',resolution:'1m',tradeDates:sessions.map(d=>d.date),coveredDays:covered,totalDays:5,
      days,bars:days.flatMap(d=>d.bars),regularSessions:sessions.flatMap(d=>d.sessions),
      previousCloseReference:chartPreviousClose(quote,sessions[0].date),
      adjustment:'raw',coverage:source==='alpaca-iex'?'single-exchange':'us-sip',sourceCheckedAt:now()};
  }
  async function fiveDay(symbol,quote,signal){
    const target=regularChartTarget(symbol,now());
    if(target.status!=='ready')return {status:'unavailable',reason:target.missingReason,days:[],bars:[]};
    const sessions=recentRegularSessions(symbol,target.targetDate,5);
    if(sessions.length!==5)return {status:'unavailable',reason:'FIVE_DAY_CALENDAR_INCOMPLETE',days:sessions,bars:[]};
    const key=symbol+':'+target.targetDate,old=cache.get(key);
    if(old&&old.until>now())return old.value;
    if(jobs.has(key))return jobs.get(key);
    const job=(async()=>{
      let value;
      try{
        value=await alpacaFiveDay(symbol,quote,sessions,signal);
        if(!value){
        if(cooldownUntil>now())throw Object.assign(new Error('Source cooldown'),{code:'SOURCE_COOLDOWN',retryAt:cooldownUntil});
        if(!fetchChart)throw Object.assign(new Error('Source unavailable'),{code:'FIVE_DAY_SOURCE_UNAVAILABLE'});
        const first=sessions[0].sessions[0].open_at_ms,last=sessions.at(-1).sessions.at(-1).close_at_ms;
        const query='?interval=5m&period1='+Math.floor((first-3600000)/1000)+
          '&period2='+Math.ceil((last+3600000)/1000)+'&includePrePost=false';
        const chart=await fetchChart(symbol,query,{signal});
        if(chart?.meta?.symbol?.toUpperCase()!==symbol||chart?.meta?.dataGranularity!=='5m'||
          !Array.isArray(chart.timestamp)||!chart.indicators?.quote?.[0]||
          chart.meta?.currency!==quote.currency)throw Object.assign(new Error('Chart identity mismatch'),{code:'SOURCE_IDENTITY_MISMATCH'});
        const q=chart.indicators.quote[0],raw=chart.timestamp.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]??null}));
        const days=sessions.map(day=>{
          const projection=projectRegularBars(symbol,raw,{source:'yahoo',instrumentType:instrumentTypeFor(symbol),
            targetDate:day.date,now:now()});
          const matched=projection.tradeDate===day.date;
          const status=matched?(now()<day.sessions.at(-1).close_at_ms?'partial':'ready'):'missing';
          return {date:day.date,status,bars:matched?projection.bars:[],
            regularSessions:day.sessions,volumeQuality:matched?projection.volumeQuality:null};
        });
        const bars=days.flatMap(d=>d.bars),covered=days.filter(d=>d.status!=='missing').length,
          open=days.some(d=>d.status==='partial');
        value={status:covered===5&&!open?'ready':covered?'partial':'unavailable',
          reason:covered<5?'FIVE_DAY_SOURCE_GAPS':open?'FIVE_DAY_SESSION_OPEN':null,
          source:'yahoo',currency:quote.currency,
          volumeUnit:marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol))?'shares':null,
          resolution:'5m',tradeDates:sessions.map(d=>d.date),
          coveredDays:covered,totalDays:5,days,bars,regularSessions:sessions.flatMap(d=>d.sessions),
          adjustment:'source-default-unverified',coverage:'yahoo-chart-source',
          previousCloseReference:chartPreviousClose(quote,sessions[0].date),sourceCheckedAt:now()};
        }
      }catch(error){
        if(signal?.aborted)throw error;
        if(error.status===429||['SOURCE_COOLDOWN','RATE_LIMITED','SOURCE_RATE_LIMITED'].includes(error.code))
          cooldownUntil=Math.max(now()+300000,Number(error.retryAt)||0);
        const days=sessions.map(day=>{
          const current=quote.regularChart?.tradeDate===day.date?quote.regularChart:null;
          return {date:day.date,status:current?.bars?.length?'ready':'missing',bars:current?.bars||[],
            regularSessions:day.sessions,volumeQuality:current?.volumeQuality||null};
        });
        value={status:days.some(d=>d.status==='ready')?'partial':'unavailable',reason:error.code||'FIVE_DAY_SOURCE_UNAVAILABLE',
          retryAt:cooldownUntil||null,source:days.some(d=>d.status==='ready')?quote.regularChart?.source||null:null,
          currency:quote.currency,volumeUnit:quote.regularChart?.volumeUnit||null,resolution:'5m',
          tradeDates:sessions.map(d=>d.date),coveredDays:days.filter(d=>d.status==='ready').length,totalDays:5,
          days,bars:days.flatMap(d=>d.bars),regularSessions:sessions.flatMap(d=>d.sessions),
          previousCloseReference:chartPreviousClose(quote,sessions[0].date),sourceCheckedAt:null};
      }
      cache.set(key,{value,until:Math.max(now()+120000,cooldownUntil)});
      while(cache.size>30)cache.delete(cache.keys().next().value);
      return value;
    })().finally(()=>jobs.delete(key));jobs.set(key,job);return job;
  }
  async function read(symbol,{range='1d',signal}={}){
    const quote=readQuote(symbol)||{},target=regularChartTarget(symbol,now());
    const chart=quote?.regularChart||{status:'unavailable',bars:[],tradeDate:null,missingReason:'REGULAR_HISTORY_NOT_AVAILABLE'};
    const tradeDate=range==='5d'?null:chart.tradeDate||target.targetDate;
    const five=range==='5d'?await fiveDay(symbol,quote,signal):null;
    const day=range==='5d'?five?.tradeDates?.at(-1):tradeDate;
    const book=normalizeOrderBook(quote?.orderBook,quote,now());
    return {symbol,range,quote:{symbol:quote?.symbol,name:quote?.name,price:quote?.price,change:quote?.change,
      changePct:quote?.changePct,priceSession:quote?.priceSession,quoteAt:quote?.quoteAt,quoteTradeDate:quote?.quoteTradeDate,
      currency:quote?.currency,open:quote?.open,high:quote?.dayHigh,low:quote?.dayLow,volume:quote?.volume,
      regularPrice:quote?.regularPrice,prevClose:quote?.prevClose,previousCloseTradeDate:quote?.previousCloseTradeDate,
      previousCloseStatus:quote?.previousCloseStatus,ext:quote?.ext},
      chart, fiveDay:five,book,tape:{...(tape?.snapshot(symbol,day)||{status:'unavailable',reason:'TRADE_STREAM_NOT_CONFIGURED',events:[]}),
        stream:streamState?.(symbol)||{state:'unavailable',healthy:false,source:null,checkedAt:null,errorCode:'TRADE_STREAM_NOT_CONFIGURED'}},
      capabilities:{book:book.status,tape:tape?'received-stream-fragment':'unavailable',
        fiveDay:five?.status||null,volume:chart.volumeQuality?.status||'missing'}};
  }
  return Object.freeze({read});
}
