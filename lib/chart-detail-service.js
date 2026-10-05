import {regularChartTarget,recentRegularSessions,projectRegularBars,chartPreviousClose} from './regular-chart-service.js';
import {normalizeOrderBook} from './order-book.js';
import {instrumentTypeFor,marketKeyFor} from './instruments.js';
import {volumeCapability} from './volume-normalizer.js';
import {localDateAt,validSymbol,validDate,contentHash} from './history-contract.js';
import {createTaskQueue} from './task-queue.js';
import {atomicWriteFile} from './atomic-file.js';
import fs from 'node:fs/promises';
import {sourceTiming,intervalCoverage,knownCoverageRegressed} from './history-state-contract.js';
import {createLatestCheckpoint} from './latest-checkpoint.js';

// Browser-facing read-only projection. Provider credentials stay inside the server.
export function createChartDetailService({readQuote,fetchChart,advanced,tape,publicTape,publicBook,streamState,now=Date.now,
  statePath='',freshMs=120000,retainMs=7*86400000,maxEntries=30,maxBytes=8*1024*1024,
  deadlineMs=25000,writeFile=atomicWriteFile,log={warn(){}}}={}){
  const cache=new Map(),jobs=new Map(),queue=createTaskQueue({maxActive:2,maxQueued:16,now});
  let bytes=0,closed=false,initializing=null,initialized=false,dirty=false,saveTimer=null,
    loadError=null,saveError=null,restored=0,restoreSkipped=0,hits=0,staleHits=0,evictions=0;
  const checkpoint=createLatestCheckpoint({write:body=>writeFile(statePath,body),capture:()=>({schemaVersion:1,savedAt:now(),
    entries:[...cache.values()].filter(e=>e.value.bars.length&&e.value.sourceCheckedAt>0&&e.retainUntil>now()).map(({bytes,...entry})=>entry)}),
    onSuccess(){saveError=null;},onError(error){dirty=true;saveError=error.code||error.message;log.warn('[five-day checkpoint]',{code:saveError});}});
  const identityFor=(symbol,quote,sessions)=>({symbol,market:marketKeyFor(symbol),currency:quote.currency,
    instrumentType:quote.instrumentType||instrumentTypeFor(symbol)||'UNKNOWN',
    tradeDates:sessions.map(day=>day.date),regularSessions:sessions.flatMap(day=>day.sessions)});
  const keyFor=identity=>contentHash(identity);
  function withCoverage(value){
    if(!value?.bars.length||!value.sourceCheckedAt)return value;
    const coverage=intervalCoverage(value.days,value);
    return {...value,revision:contentHash([value.source,value.pointKind,value.resolution,value.bars]),intervalCoverage:coverage,
      days:value.days.map((day,i)=>({...day,intervalCoverage:coverage.days[i],
        ...(day.status==='ready'&&coverage.days[i].status!=='complete'?{status:'partial',missingReason:day.missingReason||'FIVE_DAY_INTERVAL_COVERAGE_UNVERIFIED'}:{})})),
      ...(coverage.status!=='complete'?{status:'partial',reason:value.reason||'FIVE_DAY_INTERVAL_COVERAGE_UNVERIFIED'}:{})};
  }
  const stopped=()=>Object.assign(new Error('Chart detail stopped'),{code:'STOPPED'});
  function remove(key){const old=cache.get(key);if(old){bytes-=old.bytes;cache.delete(key);}}
  function remember(key,entry){
    remove(key);const {bytes:oldBytes,...saved}=entry;entry.bytes=Buffer.byteLength(JSON.stringify(saved))+256;
    if(entry.bytes>maxBytes)return;
    cache.set(key,entry);bytes+=entry.bytes;
    while(cache.size>maxEntries||bytes>maxBytes){remove(cache.keys().next().value);evictions++;}
  }
  function cached(key){
    const value=cache.get(key);if(!value)return null;
    if(value.retainUntil<=now()){remove(key);return null;}
    cache.delete(key);cache.set(key,value);return value;
  }
  const describe=(entry,key,{cached:fromCache=false}={})=>({...entry.value,cached:fromCache,
    stale:!!entry.error||entry.freshUntil<=now()||Number.isFinite(entry.value.sourceFreshUntil)&&entry.value.sourceFreshUntil<=now(),refreshing:jobs.has(key),cacheAsOf:entry.value.sourceCheckedAt,
    cacheServedAt:now(),...(entry.error?{status:'partial'}:{}),
    ...(entry.error?{refreshError:entry.error,retryAt:entry.retryAt||null}:{} )});
  // Cancellation belongs to this reader. The bounded producer continues warming
  // the application cache when a dialog closes, and only shutdown cancels it.
  function waitFor(promise,signal){
    if(!signal)return promise;
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  function persist(){
    clearTimeout(saveTimer);saveTimer=null;if(!statePath||!dirty)return checkpoint.settled();
    dirty=false;return checkpoint.persist();
  }
  function saveSoon(){if(!statePath||closed||saveTimer)return;saveTimer=setTimeout(()=>void persist().catch(()=>{}),1000);saveTimer.unref?.();}
  function validEntry(entry){
    const id=entry?.identity,v=entry?.value,at=now();
    if(!id||!validSymbol(id.symbol)||id.market!==marketKeyFor(id.symbol)||
      typeof id.currency!=='string'||!/^(?:[A-Z]{3}|GBp|ZAc)$/.test(id.currency)||
      typeof id.instrumentType!=='string'||id.instrumentType.length>40||
      !Array.isArray(id.tradeDates)||id.tradeDates.length!==5||!id.tradeDates.every(validDate)||
      !v||!['ready','partial'].includes(v.status)||v.currency!==id.currency||
      typeof v.source!=='string'||v.source.length>80||!['1m','5m'].includes(v.resolution)||
      !['bar-start','bar-close','price-point'].includes(v.pointKind)||
      !Number.isFinite(v.sourceCheckedAt)||v.sourceCheckedAt<=0||v.sourceCheckedAt>at+60000||
      v.sourceFreshUntil!=null&&(!Number.isFinite(v.sourceFreshUntil)||v.sourceFreshUntil<v.sourceCheckedAt||v.sourceFreshUntil>v.sourceCheckedAt+7*86400000)||
      v.sourceTimeBasis!=null&&(typeof v.sourceTimeBasis!=='string'||v.sourceTimeBasis.length>80)||
      v.sourceCheckedAt+retainMs<=at||!Number.isFinite(entry.freshUntil)||
      !Number.isFinite(entry.retainUntil)||entry.retainUntil<=at||entry.retainUntil>v.sourceCheckedAt+retainMs||
      !Array.isArray(v.days)||v.days.length!==5||!Array.isArray(v.bars)||!v.bars.length||v.bars.length>5000||v.totalDays!==5)return false;
    const sessions=recentRegularSessions(id.symbol,id.tradeDates.at(-1),5);
    if(sessions.length!==5||keyFor(identityFor(id.symbol,id,sessions))!==keyFor(id)||
      contentHash(v.tradeDates)!==contentHash(id.tradeDates)||contentHash(v.regularSessions)!==contentHash(id.regularSessions))return false;
    const duration=v.resolution==='1m'?60:300;
    const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
    const barValid=(bar,day)=>{
      if(!positive(bar?.t)||bar.t*1000>v.sourceCheckedAt+5000||!positive(bar.c)||
        bar.v!=null&&(!Number.isFinite(bar.v)||bar.v<0))return false;
      if(['o','h','l'].some(key=>bar[key]!=null&&!positive(bar[key])))return false;
      if(bar.h!=null&&(bar.h<bar.c||bar.o!=null&&bar.h<bar.o)||
        bar.l!=null&&(bar.l>bar.c||bar.o!=null&&bar.l>bar.o)||bar.l!=null&&bar.h!=null&&bar.l>bar.h)return false;
      return day.sessions.some(session=>{const t=bar.t*1000;
        if(v.pointKind==='price-point')return t>=session.open_at_ms&&t<=session.close_at_ms;
        if(v.pointKind==='bar-close')return t-duration*1000>=session.open_at_ms&&t<=session.close_at_ms;
        return t>=session.open_at_ms&&t+duration*1000<=session.close_at_ms;});
    };
    if(v.days.some((day,i)=>day?.date!==sessions[i].date||!['ready','partial','missing'].includes(day.status)||
      day.pointKind!==v.pointKind||!Array.isArray(day.bars)||
      contentHash(day.regularSessions)!==contentHash(sessions[i].sessions)||
      day.bars.some((bar,j)=>!barValid(bar,sessions[i])||j&&day.bars[j-1].t>=bar.t)))return false;
    return contentHash(v.bars)===contentHash(v.days.flatMap(day=>day.bars))&&
      v.coveredDays===v.days.filter(day=>day.bars.length).length;
  }
  function start(){
    if(initialized&&!closed)return Promise.resolve();
    if(initializing)return initializing;
    closed=false;queue.reopen();
    initializing=(async()=>{
      if(statePath&&!initialized)try{
        const stat=await fs.lstat(statePath);
        if(!stat.isFile()||stat.size>maxBytes+65536)throw Object.assign(new Error('Invalid five-day checkpoint size'),{code:'INVALID_STATE_FILE'});
        const state=JSON.parse(await fs.readFile(statePath,'utf8'));
        if(state?.schemaVersion!==1||!Number.isFinite(state.savedAt)||state.savedAt<=0||state.savedAt>now()+60000||!Array.isArray(state.entries))throw Error('Invalid five-day checkpoint');
        if(!closed)for(const entry of state.entries.slice(-maxEntries)){
          let valid=false;try{valid=validEntry(entry);}catch{}
          if(!valid){restoreSkipped++;continue;}
          const error=typeof entry.error==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(entry.error)?entry.error:null;
          const clean={identity:entry.identity,value:withCoverage(entry.value),retainUntil:entry.retainUntil,
            freshUntil:Math.min(entry.freshUntil,entry.value.sourceCheckedAt+freshMs),error,
            retryAt:error&&Number.isFinite(entry.retryAt)?Math.min(entry.retryAt,now()+300000):null};
          remember(keyFor(clean.identity),clean);restored++;
        }
      }catch(error){if(error.code!=='ENOENT'){loadError=error.code||error.message;log.warn('[five-day restore]',{code:loadError});}}
      initialized=true;
    })().finally(()=>{initializing=null;});
    return initializing;
  }
  async function stop(){
    closed=true;clearTimeout(saveTimer);saveTimer=null;
    for(const job of jobs.values())job.controller.abort(stopped());queue.close();
    await initializing;await Promise.allSettled([...jobs.values()].map(job=>job.promise));await persist();
    if(saveError)throw Object.assign(new Error('Five-day checkpoint failed'),{code:saveError});
  }
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
        pointKind:'bar-start',volumeQuality:matched?projection.volumeQuality:null,
        missingReason:matched?null:results[i].error?.code||data?.missing_reason||'SOURCE_DAY_MISSING'};
    });
    const covered=days.filter(d=>d.status!=='missing').length,open=days.some(d=>d.status==='partial');
    if(!covered)return null;
    const checks=results.map(r=>r.value?.sourceCheckedAt).filter(value=>Number.isFinite(value)&&value>0);
    const checked=checks.length>0&&checks.length===results.filter(r=>r.value).length?Math.min(...checks):null;
    return {status:covered===5&&!open?'ready':'partial',reason:covered<5?'FIVE_DAY_SOURCE_GAPS':open?'FIVE_DAY_SESSION_OPEN':null,
      source,currency:quote.currency,volumeUnit:'shares',resolution:'1m',pointKind:'bar-start',tradeDates:sessions.map(d=>d.date),coveredDays:covered,totalDays:5,
      days,bars:days.flatMap(d=>d.bars),regularSessions:sessions.flatMap(d=>d.sessions),
      previousCloseReference:chartPreviousClose(quote,sessions[0].date),
      adjustment:'raw',coverage:source==='alpaca-iex'?'single-exchange':'us-sip',...sourceTiming(checked?{sourceCheckedAt:checked}:null,now())};
  }
  async function fetchFiveDay(symbol,quote,sessions,signal,priority){
      let value,retryAt=null;
      try{
        value=await alpacaFiveDay(symbol,quote,sessions,signal);
        if(!value){
        if(!fetchChart)throw Object.assign(new Error('Source unavailable'),{code:'FIVE_DAY_SOURCE_UNAVAILABLE'});
        const first=sessions[0].sessions[0].open_at_ms,last=sessions.at(-1).sessions.at(-1).close_at_ms;
        const query='?interval=5m&period1='+Math.floor((first-3600000)/1000)+
          '&period2='+Math.ceil((last+3600000)/1000)+'&includePrePost=false';
        const chart=await fetchChart(symbol,query,{signal,priority,instrumentType:quote.instrumentType});
        if(chart?.meta?.symbol?.toUpperCase()!==symbol||!['5m','1m'].includes(chart?.meta?.dataGranularity)||
          !Array.isArray(chart.timestamp)||!chart.indicators?.quote?.[0]||
          chart.meta?.currency!==quote.currency)throw Object.assign(new Error('Chart identity mismatch'),{code:'SOURCE_IDENTITY_MISMATCH'});
        const q=chart.indicators.quote[0],raw=chart.timestamp.map((t,i)=>({t,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:q.volume?.[i]??null}));
        const source=chart.source||'yahoo',pointKind=chart.meta.chartTimeBasis==='bar-close'?'bar-close':
          chart.meta.chartTimeBasis==='price-point'||source==='nasdaq-intraday'?'price-point':'bar-start';
        const days=sessions.map(day=>{
          const projection=projectRegularBars(symbol,raw,{source,pointKind,
            intervalSeconds:chart.meta.chartIntervalSeconds||({'1m':60,'5m':300}[chart.meta.dataGranularity]),instrumentType:instrumentTypeFor(symbol),
            targetDate:day.date,now:now()});
          const matched=projection.tradeDate===day.date;
          const status=matched?(now()<day.sessions.at(-1).close_at_ms||projection.volumeQuality?.closingPrintStatus==='unverified'?'partial':'ready'):'missing';
          return {date:day.date,status,bars:matched?projection.bars:[],
            regularSessions:day.sessions,pointKind,volumeQuality:matched?projection.volumeQuality:null,
            missingReason:matched?projection.missingReason:'SOURCE_DAY_MISSING'};
        });
        const bars=days.flatMap(d=>d.bars),covered=days.filter(d=>d.status!=='missing').length,
          open=sessions.some(d=>now()<d.sessions.at(-1).close_at_ms),
          closingUnverified=days.some(d=>d.volumeQuality?.closingPrintStatus==='unverified');
        value={status:covered===5&&!open&&!closingUnverified?'ready':covered?'partial':'unavailable',
          reason:covered<5?'FIVE_DAY_SOURCE_GAPS':open?'FIVE_DAY_SESSION_OPEN':closingUnverified?'CLOSING_PRINT_COVERAGE_UNVERIFIED':null,
          source,currency:quote.currency,
          volumeUnit:volumeCapability({source,market:marketKeyFor(symbol),instrumentType:instrumentTypeFor(symbol)}).unit,
          resolution:chart.meta.dataGranularity,pointKind,tradeDates:sessions.map(d=>d.date),
          coveredDays:covered,totalDays:5,days,bars,regularSessions:sessions.flatMap(d=>d.sessions),
          adjustment:'source-default-unverified',coverage:source+'-chart-source',
          previousCloseReference:chartPreviousClose(quote,sessions[0].date),...sourceTiming(chart,now())};
        }
      }catch(error){
        if(signal?.aborted)throw error;
        // Only this symbol/date caches this failure. Host-wide limits are owned
        // by the transport gate; rereading this result never extends its deadline.
        if(error.status===429||error.statusCode===429||['SOURCE_COOLDOWN','RATE_LIMITED','SOURCE_RATE_LIMITED','HISTORY_RATE_LIMITED'].includes(error.code))
          retryAt=Math.max(now()+300000,Number(error.retryAt)||0);
        const days=sessions.map(day=>{
          const current=quote.regularChart?.tradeDate===day.date?quote.regularChart:null;
          return {date:day.date,status:current?.bars?.length?'ready':'missing',bars:current?.bars||[],
            regularSessions:day.sessions,pointKind:current?.pointKind||'price-point',volumeQuality:current?.volumeQuality||null};
        });
        const fallback=days.some(day=>day.bars.length)?quote.regularChart:null;
        const declaredInterval=fallback?.intervalSeconds??({'1m':60,'5m':300}[fallback?.resolution]??null);
        const intervalSeconds=[60,300].includes(declaredInterval)?declaredInterval:null;
        value={status:days.some(d=>d.status==='ready')?'partial':'unavailable',reason:error.code||'FIVE_DAY_SOURCE_UNAVAILABLE',
          retryAt,source:fallback?.source||null,
          currency:quote.currency,volumeUnit:fallback?.volumeUnit||null,intervalSeconds,
          resolution:intervalSeconds===60?'1m':intervalSeconds===300?'5m':null,pointKind:fallback?.pointKind||'price-point',
          adjustmentBasis:typeof fallback?.adjustmentBasis==='string'?fallback.adjustmentBasis:null,
          adjustment:typeof fallback?.adjustment==='string'?fallback.adjustment:null,
          tradeDates:sessions.map(d=>d.date),coveredDays:days.filter(d=>d.status==='ready').length,totalDays:5,
          days,bars:days.flatMap(d=>d.bars),regularSessions:sessions.flatMap(d=>d.sessions),
          previousCloseReference:chartPreviousClose(quote,sessions[0].date),sourceCheckedAt:null};
      }
      return withCoverage(value);
  }
  function refresh(key,identity,quote,sessions,priority='background'){
    const pending=jobs.get(key);if(pending)return pending.promise;
    if(closed)return Promise.reject(stopped());
    const controller=new AbortController(),job={controller,promise:null};jobs.set(key,job);
    job.promise=queue.run(async()=>{
      const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Five-day source deadline exceeded'),{code:'HISTORY_TIMEOUT'})),deadlineMs);
      try{
        const value=await fetchFiveDay(identity.symbol,quote,sessions,controller.signal,priority);
        if(closed||controller.signal.aborted)throw controller.signal.reason||stopped();
        const prior=cached(key),regressed=prior?.value.bars.length&&value.sourceCheckedAt&&
          knownCoverageRegressed(prior.value,value),failed=!value.sourceCheckedAt||!value.bars.length||prior?.value.coveredDays>value.coveredDays||regressed;
        let entry;
        if(prior?.value.bars.length&&failed){
          entry={...prior,error:regressed?'FIVE_DAY_COVERAGE_REGRESSION':value.reason||'FIVE_DAY_SOURCE_UNAVAILABLE',retryAt:Math.max(now()+freshMs,Number(value.retryAt)||0),freshUntil:now()+freshMs};
        }else{
          entry={identity,value:{...value,previousRevision:prior?.value.revision??null},freshUntil:Math.max(now()+freshMs,Number(value.retryAt)||0),
            retainUntil:(value.sourceCheckedAt||now())+retainMs,error:failed?value.reason||'FIVE_DAY_SOURCE_UNAVAILABLE':null,retryAt:value.retryAt||null};
        }
        remember(key,entry);dirty=true;saveSoon();return entry;
      }finally{clearTimeout(timer);}
    },{signal:controller.signal,priority}).catch(error=>{
      if(closed)throw error;
      const prior=cached(key);
      if(prior?.value.bars.length){const entry={...prior,error:error.code||'FIVE_DAY_SOURCE_UNAVAILABLE',retryAt:now()+freshMs,freshUntil:now()+freshMs};
        remember(key,entry);dirty=true;saveSoon();return entry;}
      throw error;
    }).finally(()=>{if(jobs.get(key)===job)jobs.delete(key);});
    // There need not be an HTTP reader left when this producer settles.
    void job.promise.catch(()=>{});return job.promise;
  }
  async function fiveDay(symbol,quote,signal){
    const target=regularChartTarget(symbol,now());
    if(target.status!=='ready')return {status:'unavailable',reason:target.missingReason,days:[],bars:[]};
    const sessions=recentRegularSessions(symbol,target.targetDate,5);
    if(sessions.length!==5)return {status:'unavailable',reason:'FIVE_DAY_CALENDAR_INCOMPLETE',days:sessions,bars:[]};
    const identity=identityFor(symbol,quote,sessions),key=keyFor(identity),old=cached(key);
    if(old){
      hits++;
      if(old.freshUntil>now()||old.retryAt>now())return describe(old,key,{cached:true});
      if(old.value.bars.length){staleHits++;void refresh(key,identity,quote,sessions).catch(()=>{});return describe(old,key,{cached:true});}
    }
    const entry=await waitFor(refresh(key,identity,quote,sessions,'foreground'),signal);
    return describe(entry,key);
  }
  async function read(symbol,{range='1d',tapeSession='auto',sections='all',signal}={}){
    if(closed)throw stopped();await waitFor(start(),signal);if(closed)throw stopped();signal?.throwIfAborted();
    const withChart=sections!=='market',withMarket=sections!=='chart';
    const quote=readQuote(symbol)||{},target=regularChartTarget(symbol,now());
    const chart=quote?.regularChart||{status:'unavailable',bars:[],tradeDate:null,missingReason:'REGULAR_HISTORY_NOT_AVAILABLE'};
    const tradeDate=range==='5d'?null:chart.tradeDate||target.targetDate;
    const session=tapeSession==='auto'?({'PRE':'pre','POST':'post'}[quote.priceSession]||'regular'):tapeSession;
    const day=session==='regular'?(range==='5d'?target.targetDate:tradeDate):
      quote.quoteTradeDate||(quote.quoteAt?localDateAt(quote.quoteAt,'America/New_York'):target.targetDate);
    const received=withMarket&&session==='regular'?tape?.snapshot(symbol,day):null;
    const quoteBook=withMarket?normalizeOrderBook(quote?.orderBook,quote,now()):null;
    const preferredBook=quoteBook&&quoteBook.status!=='unavailable'&&!quoteBook.stale&&quoteBook.reason!=='CROSSED_BOOK';
    const [five,published,publishedBook]=await Promise.all([
      withChart&&range==='5d'?fiveDay(symbol,quote,signal):null,
      withMarket?publicTape?.read(symbol,{session,tradeDate:day,instrumentType:quote.instrumentType,signal}):null,
      withMarket&&!preferredBook?publicBook?.read(symbol,{currency:quote.currency,instrumentType:quote.instrumentType,signal}):null
    ]);
    // A published window and a stream fragment may report the same trades.
    // Select a single source; never add their counts or volumes together.
    const selected=published?.events?.length?published:received?.events?.length?
      {...received,session,publicSourceReason:published?.reason||null}:published||received||
      {status:'unavailable',reason:'TRADE_STREAM_NOT_CONFIGURED',session,tradeDate:day,events:[]};
    let book=quoteBook;
    if(publishedBook){
      if(publishedBook.status==='unavailable')book=quoteBook.status!=='unavailable'&&quoteBook.reason!=='CROSSED_BOOK'?
        {...quoteBook,refreshReason:publishedBook.reason}:{...quoteBook,...publishedBook};
      else book={...publishedBook,...normalizeOrderBook(publishedBook,quote,now())};
    }
    return {symbol,range,sections,quote:{symbol:quote?.symbol,name:quote?.name,price:quote?.price,change:quote?.change,
      changePct:quote?.changePct,priceSession:quote?.priceSession,quoteAt:quote?.quoteAt,quoteTradeDate:quote?.quoteTradeDate,
      currency:quote?.currency,open:quote?.open,high:quote?.dayHigh,low:quote?.dayLow,volume:quote?.volume,
      regularPrice:quote?.regularPrice,prevClose:quote?.prevClose,previousCloseTradeDate:quote?.previousCloseTradeDate,
      previousCloseStatus:quote?.previousCloseStatus,ext:quote?.ext},
      chart:withChart?chart:null, fiveDay:five,book,tape:withMarket?{...selected,
        stream:streamState?.(symbol)||{state:'unavailable',healthy:false,source:null,checkedAt:null,errorCode:'TRADE_STREAM_NOT_CONFIGURED'}}:null,
      capabilities:{book:book?.status||null,tape:withMarket?selected.coverage?.scope||'unavailable':null,
        fiveDay:five?.status||null,volume:chart.volumeQuality?.status||'missing'}};
  }
  return Object.freeze({read,start,stop,persist,async settled(){await initializing;await Promise.allSettled([...jobs.values()].map(job=>job.promise));},
    diagnostics:()=>({entries:cache.size,bytes,maxBytes,maxEntries,freshMs,retainMs,hits,staleHits,evictions,
      inflight:jobs.size,restored,restoreSkipped,loadError,saveError,checkpoint:checkpoint.diagnostics(),closed,...queue.diagnostics()})});
}
