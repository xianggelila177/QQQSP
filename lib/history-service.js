import {createTaskQueue} from './task-queue.js';
import {futureInstrumentFor} from './futures-instruments.js';
import {aggregateHistory,periodBounds} from './history-aggregate.js';
import {normalizeDailyBar,historyQuery,validSymbol,validDate,contentHash,localDateAt,dateMs,addDays,historyError} from './history-contract.js';
import {timezoneForSymbol,calendarRegistry} from '../mkt.mjs';
import {marketKeyFor,instrumentTypeFor} from './instruments.js';
import {currencyUnitInfo} from './currency.js';
import {normalizeVolume,volumeCapability} from './volume-normalizer.js';
import {historyCloseConflict} from './history-close-consistency.js';
import {validPrice} from './price-values.js';

export function createHistoryService({fetchChart,getQuote=()=>null,now=()=>Date.now(),cacheTtl=60000,fullTtl=86400000,maxDaily=20000,maxEntries=24,maxBytes=48*1024*1024,maxConcurrent=1,maxQueued=16,deadlineMs=18000,totalDeadlineMs=20000,maxYears=45,failureCooldown=60000,maxFailureEntries=128}={}){
 const failures=new Map(),aggregated=new WeakMap();
 const taskQueue=createTaskQueue({maxActive:maxConcurrent,maxQueued,now});
 const restoreSkipped={total:0,reasons:{}};
 let aggregateBuilds=0;
 const cache=new Map(),rawInflight=new Map(),demands=new Map(),controllers=new Set();
 let generation=0,closed=false,bytes=0;
 const stopped=()=>historyError('STOPPED','History service stopped',503);
 function remember(symbol,raw){
  const previous=cache.get(symbol);if(previous)bytes-=previous.bytes;
  // Budget is a conservative estimate, not serialized payload size.
  raw.bytes=4096+raw.rows.length*(384+4*512)+Object.values(raw.sourceEvents||{}).reduce((n,group)=>n+Object.keys(group||{}).length*192,0);cache.delete(symbol);cache.set(symbol,raw);bytes+=raw.bytes;
  while(cache.size>maxEntries||bytes>maxBytes){const [key,value]=cache.entries().next().value;cache.delete(key);bytes-=value.bytes;}
 }
 function enqueue(fn,signal){
  return taskQueue.run(fn,{signal}).catch(error=>{
   if(error.code==='CAPACITY_EXCEEDED')throw historyError('HISTORY_BUSY','History queue is full',503);
   throw error;
  });
 }
 function parse(symbol,data,from,through){
  if(!data||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])throw historyError('HISTORY_BAD_RESPONSE','Invalid source history response',502);
  const meta=data.meta||{},market=marketKeyFor(symbol,meta.exchangeName),zone=meta.exchangeTimezoneName||timezoneForSymbol(symbol);
  if(meta.dataGranularity!=='1d')throw historyError('HISTORY_GRANULARITY','Source did not deliver daily bars',422);
  if(!market||!zone)throw historyError('HISTORY_UNSUPPORTED','Unsupported market or unknown time zone',422);
  const type=instrumentTypeFor(symbol,meta.instrumentType);
  if(!['EQUITY','ETF','INDEX','FUTURE'].includes(type))throw historyError('HISTORY_UNSUPPORTED','Unsupported history instrument type',422);
  if(meta.symbol&&String(meta.symbol).toUpperCase()!==symbol)throw historyError('HISTORY_IDENTITY_CONFLICT','Source returned another symbol',422);
  const unit=currencyUnitInfo(meta.currency||'');
  if(!meta.currency&&type!=='INDEX')throw historyError('HISTORY_CURRENCY','Source currency is missing',422);
  const points=type==='INDEX'||futureInstrumentFor(symbol)?.priceUnit==='POINTS';
  const currency=points?'POINTS':unit.currency,scale=points?1:unit.scale;
  // Yahoo OHLC is kept as delivered, with denomination normalization only.
  // No adjustment is inferred from adjclose and no total-return claim is made.
  const source=data.source||'yahoo';
  const volumeRule=volumeCapability({source,market,instrumentType:type});
  const identity={schemaVersion:1,symbol,source,market,exchangeTimeZone:zone,sessionScope:type==='FUTURE'?'source-futures-session':source==='twse-stock-day'?'source-mixed-sessions':'regular',currency,sourceCurrency:meta.currency||null,priceScale:scale,instrumentType:type,exchange:meta.exchangeName||null,adjustmentBasis:source+'-source-default-unverified',adjustmentRevision:'normalization-v1',volumeUnit:volumeRule.unit||'source-unit-unverified',volumeRevision:volumeRule.revision,weekStartsOn:1,calendarVersion:calendarRegistry.version};
  const rows=[],seen=new Map(),warnings=[],today=localDateAt(now(),zone),q=data.indicators.quote[0];
  const rawCount=data.timestamp.length;
  for(let i=0;i<rawCount;i++){
   const t=data.timestamp[i];if(!Number.isFinite(t)){warnings.push('invalid-source-timestamp');continue;}
   const sessionDate=localDateAt(t*1000,zone);
   if(sessionDate>today){warnings.push('future-source-record-rejected');continue;}
   if(sessionDate<from||sessionDate>through)continue;
   const sourceVolume=q.volume?.[i]??null;
   const normalizedVolume=normalizeVolume({source,market,instrumentType:type,rawVolume:sourceVolume,kind:'interval',tradeDate:sessionDate,session:'REGULAR'});
   const candidate={sessionDate,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:normalizedVolume.value,sourceVolume,
     volumeStatus:normalizedVolume.status,volumeMissingReason:normalizedVolume.missingReason,
     source,currency,adjustmentBasis:identity.adjustmentBasis,volumeUnit:identity.volumeUnit,quality:'source-unverified'};
    if(![candidate.o,candidate.h,candidate.l,candidate.c].every(value=>validPrice(value,type))||!normalizeDailyBar(candidate)){warnings.push('invalid-source-ohlcv');continue;}
   for(const k of ['o','h','l','c'])candidate[k]*=scale;
   if(seen.has(sessionDate)){if(contentHash(seen.get(sessionDate))!==contentHash(candidate))throw historyError('HISTORY_CONFLICT','Conflicting source records for one trading date',422);continue;}
   seen.set(sessionDate,candidate);rows.push(candidate);
  }
  rows.sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate));
  if(!rows.length&&warnings.some(w=>w.startsWith('invalid-')))throw historyError('HISTORY_BAD_RESPONSE','No valid source daily records',502);
  let budgetLimited=rows.length>maxDaily;
  if(budgetLimited){rows.splice(0,rows.length-maxDaily);warnings.push('history-memory-row-budget');from=rows[0].sessionDate;}
  const listingDate=Number.isFinite(meta.firstTradeDate)?localDateAt(meta.firstTradeDate*1000,zone):null;
  if(data.retrievalLimited)warnings.push('fallback-history-window-limited');
  const latestSessionPending=data.coverage?.recentTail?.status!=='confirmed'&&
   validDate(data.coverage?.recentTail?.expectedTradeDate)&&rows.at(-1)?.sessionDate<data.coverage.recentTail.expectedTradeDate?
   data.coverage.recentTail.expectedTradeDate:null;
  if(latestSessionPending)warnings.push('latest-session-pending');
  const requestedFrom=from;
  const retrievedFrom=data.retrievedFrom||data.coverage?.firstTradingDate;
  if(data.retrievalLimited&&validDate(retrievedFrom)&&retrievedFrom>from)from=retrievedFrom;
  return {rows,identity,latestSessionPending,retrievalLimited:!!data.retrievalLimited,sourceHasMore:data.hasMore===true?true:data.hasMore===false?false:null,
   seriesId:contentHash(identity),from,requestedFrom,through,listingDate,originReached:!!listingDate&&from<=listingDate&&rows[0]?.sessionDate===listingDate&&!budgetLimited,checkedAt:now(),fullCheckedAt:now(),sourceEvents:data.events||{},
   retrievalStopReason:typeof data.coverage?.stopReason==='string'?data.coverage.stopReason:null,
   sourceVolumeCoverage:typeof meta.sourceVolumeCoverage==='string'?meta.sourceVolumeCoverage:null,
   warnings:[...new Set(warnings)],budgetLimited};
 }
 async function readRange(symbol,from,through,signal,hint={}){
  const start=Math.floor(dateMs(addDays(from,-2))/1000),end=Math.floor(dateMs(addDays(through,2))/1000);
  const query='?interval=1d&period1='+start+'&period2='+end+'&events=div%2Csplits&includeAdjustedClose=true&includePrePost=false';
  const result=parse(symbol,await fetchChart(symbol,query,{signal,priority:'history',deadlineMs:Math.min(deadlineMs,12000),
   requestedPeriod:hint.period||null,requestedCount:hint.count||null,pageBefore:hint.pageBefore||null}),from,through);
  result.cursorWindow=hint.pageBefore||null;
  return result;
 }
 function twseNeedsOlder(raw,hint){
  if(raw?.identity.source!=='twse-stock-day'||raw.sourceHasMore!==true||!hint.period||!hint.count)return false;
  const available=new Set(raw.rows.filter(row=>!hint.pageBefore||periodBounds(row.sessionDate,hint.period).periodStart<hint.pageBefore)
   .map(row=>periodBounds(row.sessionDate,hint.period).periodStart));
  return available.size<hint.count;
 }
 async function ensureRaw(symbol,start,hint={}){
  const existing=cache.get(symbol);
  const needsOlder=twseNeedsOlder(existing,hint);
  if(existing&&!needsOlder&&!(existing.cursorWindow&&!hint.pageBefore)&&
   (existing.from<=start||existing.retrievalLimited&&existing.requestedFrom<=start)&&
   now()-existing.checkedAt<cacheTtl&&(!existing.failedAt||start>existing.failedFrom))return existing;
  const failure=failures.get(symbol);
  if(failure&&failure.retryAt>now()&&(failure.blocksAll||start<=failure.from))throw Object.assign(historyError(failure.code,'History source is cooling down',failure.statusCode),{retryAt:failure.retryAt});
  const pending=demands.get(symbol);
  if(!pending||start<pending.start||start===pending.start&&(hint.count||0)>(pending.hint.count||0))demands.set(symbol,{start,hint});
  if(rawInflight.has(symbol))return rawInflight.get(symbol).promise;
  const owner=generation,controller=new AbortController();controllers.add(controller);
  let timer;
  const record={controller,subscribers:0,promise:null,from:start};
  record.promise=enqueue(async()=>{
   timer=setTimeout(()=>controller.abort(historyError('HISTORY_TIMEOUT','History source deadline exceeded',504)),deadlineMs);
   if(controller.signal.aborted)throw controller.signal.reason;
   const prior=cache.get(symbol),demand=demands.get(symbol),needed=demand?.start||start,requested=demand?.hint||hint;demands.delete(symbol);
   record.from=needed;
   const zone=prior?.identity.exchangeTimeZone||timezoneForSymbol(symbol);
   const today=localDateAt(now(),zone);
   let raw;
   const twseBackfill=!(prior?.cursorWindow&&!requested.pageBefore)&&twseNeedsOlder(prior,requested);
   const full=!prior||prior.identity.source!=='twse-stock-day'&&
    (needed<prior.from||now()-prior.fullCheckedAt>=fullTtl)||prior.cursorWindow&&!requested.pageBefore;
   if(twseBackfill){
    const older=await readRange(symbol,needed,addDays(prior.from,-1),controller.signal,{...requested,pageBefore:prior.from});
    if(older.seriesId!==prior.seriesId)throw historyError('HISTORY_SERIES_CHANGED','TWSE history identity changed during backfill',409);
    if(!older.rows.length||older.rows.at(-1).sessionDate>=prior.from)throw historyError('HISTORY_CONFLICT','TWSE backfill overlaps existing history',422);
    const rows=[...older.rows,...prior.rows],budgetLimited=rows.length>maxDaily;
    if(budgetLimited)rows.splice(0,rows.length-maxDaily);
    const retrievalLimited=budgetLimited||older.retrievalLimited;
    raw={...prior,rows,from:budgetLimited?rows[0].sessionDate:older.from,
     requestedFrom:prior.requestedFrom&&prior.requestedFrom<needed?prior.requestedFrom:needed,
     retrievalLimited,sourceHasMore:budgetLimited?null:older.sourceHasMore,
     retrievalStopReason:older.retrievalStopReason,originReached:!budgetLimited&&older.originReached,
     checkedAt:now(),budgetLimited,cursorWindow:null,
     warnings:[...new Set([...prior.warnings.filter(w=>w!=='fallback-history-window-limited'),...older.warnings,
      ...(retrievalLimited?['fallback-history-window-limited']:[]),...(budgetLimited?['history-memory-row-budget']:[])])],
     failedAt:null,failedFrom:null,failureBlocksAll:null,error:null,retryAt:null};
   }
   else if(full)raw=await readRange(symbol,prior&&prior.from<needed?prior.from:needed,today,controller.signal,requested);
   else{
    const tailFrom=addDays(prior.rows.at(-1)?.sessionDate||today,-14);
    const tail=await readRange(symbol,tailFrom,today,controller.signal,requested);
    if(tail.seriesId!==prior.seriesId)raw=await readRange(symbol,prior.from,today,controller.signal,requested);
    else{
     const overlap=new Map(prior.rows.map(b=>[b.sessionDate,b]));
     const corrected=tail.rows.some(b=>b.sessionDate<prior.rows.at(-1)?.sessionDate&&overlap.has(b.sessionDate)&&contentHash(overlap.get(b.sessionDate))!==contentHash(b));
     if((corrected||Object.keys(tail.sourceEvents.splits||{}).some(k=>!prior.sourceEvents.splits?.[k]))&&
      prior.identity.source!=='twse-stock-day')raw=await readRange(symbol,prior.from,today,controller.signal,requested);
     else{
      for(const b of tail.rows)overlap.set(b.sessionDate,b);
      raw={...prior,rows:[...overlap.values()].sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate)),checkedAt:tail.checkedAt,through:today,
       latestSessionPending:tail.latestSessionPending,warnings:[...new Set([...prior.warnings.filter(w=>w!=='latest-session-pending'),...tail.warnings])],failedAt:null,error:null};
     }
    }
   }
   if(controller.signal.aborted)throw controller.signal.reason;
   if(closed||owner!==generation)throw stopped();
   failures.delete(symbol);remember(symbol,raw);return raw;
  },controller.signal).catch(error=>{
   if(owner===generation&&!closed&&!['HISTORY_CANCELLED','STOPPED','HISTORY_BUSY','REQUEST_CANCELLED'].includes(error.code)) {
    const count=Math.min((failures.get(symbol)?.count||0)+1,8);
    const retryAt=Math.max(now()+Math.min(300000,failureCooldown*2**(count-1)),Number(error.retryAt)||0);
    error.retryAt=retryAt;
    const blocksAll=error.status===429||error.statusCode===429||['HISTORY_RATE_LIMITED','SOURCE_COOLDOWN','RATE_LIMITED'].includes(error.code);
    failures.delete(symbol);failures.set(symbol,{count,retryAt,code:error.code||'HISTORY_SOURCE_UNAVAILABLE',statusCode:error.statusCode||503,from:record.from,blocksAll});
    while(failures.size>maxFailureEntries)failures.delete(failures.keys().next().value);
   }
   demands.delete(symbol);
   if(owner===generation&&!closed&&!['HISTORY_CANCELLED','HISTORY_BUSY','REQUEST_CANCELLED'].includes(error.code)&&cache.has(symbol)){
    const old=cache.get(symbol);
    if(old.identity.source==='twse-stock-day'&&error.code==='HISTORY_EMPTY')old.sourceHasMore=null;
    old.failedAt=now();old.failedFrom=record.from;
    old.failureBlocksAll=error.status===429||error.statusCode===429||['HISTORY_RATE_LIMITED','SOURCE_COOLDOWN','RATE_LIMITED'].includes(error.code);
    old.error=error.code||'HISTORY_SOURCE_UNAVAILABLE';old.retryAt=Math.max(now()+60000,Number(error.retryAt)||0);
   }
   throw error;
  }).finally(()=>{clearTimeout(timer);controllers.delete(controller);if(rawInflight.get(symbol)===record)rawInflight.delete(symbol);});
  rawInflight.set(symbol,record);return record.promise;
 }
 async function get(symbol,period,options={}){
  if(closed)throw stopped();
  const query=historyQuery(symbol,period,options);symbol=query.symbol;
  if(!validSymbol(symbol)||!marketKeyFor(symbol))throw historyError('BAD_HISTORY_QUERY','Invalid or unsupported symbol');
  const owner=generation,zone=timezoneForSymbol(symbol),today=localDateAt(now(),zone),endDate=query.before||today;
  const requestedYears=period==='yearly'?query.count+1:period==='monthly'?Math.ceil(query.count/12)+1:period==='weekly'?Math.ceil(query.count/52)+1:Math.ceil(query.count/252)+1;
  const year=Math.max(1900,Number(endDate.slice(0,4))-Math.min(maxYears,requestedYears));
  let start=year+'-01-01',raw=cache.get(symbol),error=null;
  if(options.cacheOnly&&!raw)throw historyError('HISTORY_WARMING','历史后台准备中',503);
  if(options.force&&raw)raw.checkedAt=0;
  try{
   if(raw?.retryAt>now()&&(raw.failureBlocksAll||!raw.failedFrom||start<=raw.failedFrom)){error=raw.error||'HISTORY_SOURCE_UNAVAILABLE';}
   else if(options.cacheOnly){error=raw.error||null;}
   else{
    const timeout=new AbortController();
    const timer=setTimeout(()=>timeout.abort(historyError('HISTORY_TIMEOUT','History total deadline exceeded',504)),Math.max(1,Math.min(totalDeadlineMs,(options.deadlineAt??now()+totalDeadlineMs)-now())));
    const signal=options.signal?AbortSignal.any([options.signal,timeout.signal]):timeout.signal;
    try{
     do {
      signal.throwIfAborted();
      const promise=ensureRaw(symbol,start,{period,count:query.count,pageBefore:query.before}),job=rawInflight.get(symbol);
      if(job)job.subscribers++;
      let abort;
      const cancelled=new Promise((_,reject)=>{
       abort=()=>reject(signal.reason);
       signal.addEventListener('abort',abort,{once:true});
       if(signal.aborted)abort();
      });
      try{raw=await Promise.race([promise,cancelled]);}
      finally{
       signal.removeEventListener('abort',abort);
       if(job&&--job.subscribers===0&&signal.aborted)job.controller.abort(historyError('HISTORY_CANCELLED','No history subscribers remain',499));
      }
     }while(raw.from>start&&!raw.budgetLimited&&!raw.retrievalLimited);
    }finally{clearTimeout(timer);}

   }
  }catch(e){if(options.signal?.aborted||closed||owner!==generation)throw e;raw=cache.get(symbol);if(!raw)throw e;error=e.code||'HISTORY_SOURCE_UNAVAILABLE';}
  if(!raw)throw historyError('HISTORY_SOURCE_UNAVAILABLE','No source history available',503);
  if(closed||owner!==generation)throw stopped();
  if(query.seriesId&&query.seriesId!==raw.seriesId)throw historyError('HISTORY_SERIES_CHANGED','History identity changed; reload the series',409);
  if(raw.latestSessionPending&&(!query.before||query.before>raw.latestSessionPending)&&
   raw.rows.at(-1)?.sessionDate<raw.latestSessionPending)error ||= 'HISTORY_LATEST_SESSION_PENDING';
  const closeConsistency=historyCloseConflict(symbol,raw.identity.currency,raw.rows,getQuote(symbol),now());
  if(closeConsistency){
   raw={...raw,rows:raw.rows.filter(row=>row.sessionDate!==closeConsistency.tradeDate),
    warnings:[...new Set([...raw.warnings,'daily-close-conflict'])]};
   error='HISTORY_CLOSE_CONFLICT';
  }
  const asOf=raw.rows.at(-1)?.sessionDate||null;
  let periods=aggregated.get(raw);if(!periods){periods=new Map();aggregated.set(raw,periods);}
  const bucket=Math.floor(now()/60000),entry=periods.get(period);
  let bars;
  if(entry?.bucket===bucket)bars=entry.bars;
  else {bars=aggregateHistory(raw.rows,period,{symbol,zone:raw.identity.exchangeTimeZone,asOf:now(),requestedFrom:raw.from,listingDate:raw.listingDate,historyAsOf:asOf});periods.set(period,{bucket,bars});aggregateBuilds++;}
  const filtered=bars.filter(b=>!query.before||b.periodStart<query.before);bars=filtered.slice(-query.count);
  if(raw.warnings.length)bars=bars.map(b=>({...b,coverageStatus:b.coverageStatus==='complete-to-asof'?'unknown':b.coverageStatus,qualityFlags:[...new Set([...b.qualityFlags,...raw.warnings])]}));
  const availableMore=filtered.length>bars.length;
  const reachedBudget=Number(raw.from.slice(0,4))<=1900||raw.budgetLimited;
  const hasMore=availableMore?true:raw.sourceHasMore===true?true:raw.retrievalLimited?null:raw.originReached?false:reachedBudget?null:true;
  const nextBefore=bars[0]?.periodStart||(hasMore===true?raw.from:null);
  const stale=!!error||now()-raw.checkedAt>=cacheTtl;
  const warnings=[...new Set(['source-adjustment-unverified',...(raw.identity.volumeUnit==='source-unit-unverified'?['source-volume-unit-unverified']:[]),'historical-calendar-coverage-limited',...raw.warnings,...(stale?['history-source-stale']:[]),...(reachedBudget&&!raw.originReached?['history-retrieval-budget']:[])])];
  const coverage={status:bars.some(b=>b.coverageStatus==='partial')?'partial':bars.every(b=>b.coverageStatus==='complete-to-asof')&&bars.length?'complete-to-asof':'unknown',requestedFrom:raw.requestedFrom||raw.from,firstTradingDate:raw.rows[0]?.sessionDate||null,lastTradingDate:asOf,sourceFirstTradeDate:raw.listingDate,originProven:raw.originReached,stopReason:raw.retrievalLimited?'fallback-window':reachedBudget?'retrieval-budget':raw.originReached?'source-first-trade-date':null,
   sourceStopReason:raw.retrievalStopReason||null,sourceHasMore:raw.sourceHasMore??null,sourceVolumeCoverage:raw.sourceVolumeCoverage||null};
  const status=stale?'stale':bars.length?'ready':'empty';
  const revision=contentHash([raw.seriesId,period,bars,coverage,status,warnings]);
  return {...raw.identity,symbol,period,seriesId:raw.seriesId,revision,historyAsOf:asOf,sourceCheckedAt:raw.checkedAt,stale,status,warnings,coverage,coverageStatus:coverage.status,priceBasis:raw.identity.adjustmentBasis,requestedCount:query.count,returnedCount:bars.length,nextBefore,hasMore,bars,...(closeConsistency?{closeConsistency}:{}),...(error?{errorCode:error,retryAt:raw.retryAt||null}:{})};
 }
 // A single wide daily read feeds all four tabs. Callers share the same raw job.
 async function prepare(symbol,{tier='near',signal}={}){
  await get(symbol,tier==='long'?'yearly':'daily',{count:tier==='long'?39:79,signal});
  return Object.fromEntries(await Promise.all(['daily','weekly','monthly','yearly'].map(async period=>[period,await get(symbol,period,{count:period==='yearly'?39:79,cacheOnly:true})])));
 }
 // Compact checkpoint is only an optimization. Identity and OHLC validation remain at the disk boundary.
 function exportState(symbols=[...cache.keys()]){
  return {schemaVersion:1,entries:symbols.filter(s=>cache.has(s)).map(symbol=>{
   const {rows,bytes,...meta}=cache.get(symbol);
   return {symbol,meta,rows:rows.map(b=>[b.sessionDate,b.o,b.h,b.l,b.c,b.sourceVolume])};
  })};
 }
 function restore(state){
  const skip=reason=>{restoreSkipped.total++;restoreSkipped.reasons[reason]=(restoreSkipped.reasons[reason]||0)+1;};
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const timestamp=value=>Number.isFinite(value)&&value>0&&value<=now()+60000;
  const events=value=>object(value)&&Object.values(value).every(group=>object(group)&&Object.values(group).every(event=>object(event)&&Object.values(event).every(v=>typeof v==='string'||typeof v==='number'&&Number.isFinite(v))));
  if(state?.schemaVersion!==1||!Array.isArray(state.entries)){skip('schema');return;}
  for(const item of state.entries.slice(0,maxEntries)){
   if(!object(item)){skip('entry');continue;}
   const {symbol,meta}=item;
   if(!validSymbol(symbol)||!object(meta)||!object(meta.identity)||meta.identity.symbol!==symbol||typeof meta.identity.exchangeTimeZone!=='string'){skip('identity');continue;}
   const id=meta.identity;
   try{new Intl.DateTimeFormat('en',{timeZone:id.exchangeTimeZone});}catch{skip('identity');continue;}
   if(id.schemaVersion!==1||!['source','market','sessionScope','currency','instrumentType','adjustmentBasis','volumeUnit'].every(k=>typeof id[k]==='string'&&id[k].length>0)||!Number.isFinite(id.priceScale)||id.priceScale<=0||id.weekStartsOn!==1||typeof id.adjustmentRevision!=='string'||typeof id.calendarVersion!=='string'||id.sourceCurrency!=null&&typeof id.sourceCurrency!=='string'||id.exchange!=null&&typeof id.exchange!=='string'||meta.seriesId!==contentHash(id)){skip('identity');continue;}
    if(!date(meta.from)||!date(meta.through)||meta.from>meta.through||meta.requestedFrom!=null&&(!date(meta.requestedFrom)||meta.requestedFrom>meta.from)||meta.failedFrom!=null&&!date(meta.failedFrom)||meta.cursorWindow!=null&&!date(meta.cursorWindow)||meta.listingDate!=null&&!date(meta.listingDate)||meta.latestSessionPending!=null&&!date(meta.latestSessionPending)||!timestamp(meta.checkedAt)||!timestamp(meta.fullCheckedAt)){skip('dates');continue;}
   if(!Array.isArray(meta.warnings)||meta.warnings.length>64||meta.warnings.some(v=>typeof v!=='string'||v.length>256)||!events(meta.sourceEvents)||
    meta.retrievalStopReason!=null&&(typeof meta.retrievalStopReason!=='string'||meta.retrievalStopReason.length>128)||
    meta.sourceVolumeCoverage!=null&&(typeof meta.sourceVolumeCoverage!=='string'||meta.sourceVolumeCoverage.length>256)){skip('metadata');continue;}
   if(['originReached','budgetLimited','retrievalLimited'].some(k=>typeof meta[k]!=='boolean')||meta.sourceHasMore!=null&&typeof meta.sourceHasMore!=='boolean'||meta.failureBlocksAll!=null&&typeof meta.failureBlocksAll!=='boolean'||meta.failedAt!=null&&!timestamp(meta.failedAt)||meta.retryAt!=null&&(!Number.isFinite(meta.retryAt)||meta.retryAt<0)||meta.error!=null&&typeof meta.error!=='string'){skip('metadata');continue;}
   if(!Array.isArray(item.rows)||item.rows.length>maxDaily||item.rows.some(row=>!Array.isArray(row)||row.length!==6)){skip('rows');continue;}
   const volumeRule=volumeCapability({source:id.source,market:id.market,instrumentType:id.instrumentType});
   if(id.volumeUnit!=='source-unit-unverified'&&id.volumeUnit!=='unknown'&&id.volumeUnit!==volumeRule.unit){skip('volume-identity');continue;}
   // Existing checkpoints retain sourceVolume. Re-normalize only known source,
   // market and instrument combinations, then change the series identity.
   const migratedIdentity=volumeRule.status==='verified'?{...id,volumeUnit:volumeRule.unit,volumeRevision:volumeRule.revision}:id;
   const rows=item.rows.map(([sessionDate,o,h,l,c,sourceVolume])=>{
     const volume=normalizeVolume({source:id.source,market:id.market,instrumentType:id.instrumentType,
       rawVolume:sourceVolume,kind:'interval',tradeDate:sessionDate,session:'REGULAR'});
     return normalizeDailyBar({sessionDate,o,h,l,c,v:volume.value,sourceVolume,
       volumeStatus:volume.status,volumeMissingReason:volume.missingReason,source:id.source,currency:id.currency,
       adjustmentBasis:id.adjustmentBasis,volumeUnit:migratedIdentity.volumeUnit,quality:'source-unverified'});
   });
    if(rows.some((b,i)=>!b||![b.o,b.h,b.l,b.c].every(value=>validPrice(value,id.instrumentType))||b.sessionDate<meta.from||b.sessionDate>meta.through||i&&rows[i-1].sessionDate>=b.sessionDate)){skip('rows');continue;}
    const restored=Object.fromEntries(['identity','seriesId','from','requestedFrom','through','listingDate','latestSessionPending','originReached','checkedAt','fullCheckedAt','sourceEvents','retrievalStopReason','sourceHasMore','sourceVolumeCoverage','cursorWindow','warnings','budgetLimited','retrievalLimited','failedAt','failedFrom','failureBlocksAll','error','retryAt'].filter(k=>Object.hasOwn(meta,k)).map(k=>[k,meta[k]]));
   remember(symbol,{...restored,identity:migratedIdentity,seriesId:contentHash(migratedIdentity),rows});
  }
 }
 function close(){closed=true;generation++;for(const c of controllers)c.abort(stopped());taskQueue.close();rawInflight.clear();demands.clear();failures.clear();cache.clear();bytes=0;}
 function reopen(){closed=false;taskQueue.reopen();}
 function clear(){close();reopen();}
 function invalidate(symbol){
  if(!validSymbol(symbol))return false;
  rawInflight.get(symbol)?.controller.abort(historyError('HISTORY_CANCELLED','History symbol invalidated',499));
  failures.delete(symbol);demands.delete(symbol);
  const old=cache.get(symbol);if(old){cache.delete(symbol);bytes-=old.bytes;}
  return !!old;
 }
 return {get,prepare,exportState,restore,close,reopen,clear,invalidate,cache,diagnostics:()=>({entries:cache.size,failureEntries:failures.size,bytes,byteAccounting:'raw+four-aggregate-reservation',maxBytes,aggregateBuilds,inflight:rawInflight.size,...taskQueue.diagnostics(),restoreSkipped,closed})};
}
