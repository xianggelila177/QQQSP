import {aggregateHistory,periodBounds} from './history-aggregate.js';
import {normalizeDailyBar,historyQuery,validSymbol,contentHash,localDateAt,dateMs,addDays,historyError} from './history-contract.js';
import {timezoneForSymbol,calendarRegistry} from '../mkt.mjs';
import {marketKeyFor,instrumentTypeFor} from './instruments.js';
import {currencyUnitInfo} from './currency.js';

export function createHistoryService({fetchChart,now=()=>Date.now(),cacheTtl=60000,fullTtl=86400000,maxDaily=20000,maxEntries=24,maxBytes=48*1024*1024,maxConcurrent=1,maxQueued=16,deadlineMs=18000,maxYears=45,failureCooldown=60000,maxFailureEntries=128}={}){
 const failures=new Map(),aggregated=new WeakMap();
 let aggregateBuilds=0;
 const cache=new Map(),rawInflight=new Map(),demands=new Map(),queue=[],controllers=new Set();
 let generation=0,closed=false,active=0,bytes=0;
 const stopped=()=>historyError('STOPPED','History service stopped',503);
 function remember(symbol,raw){
  const previous=cache.get(symbol);if(previous)bytes-=previous.bytes;
  // Budget is a conservative estimate, not serialized payload size.
  raw.bytes=4096+raw.rows.length*384+Object.values(raw.sourceEvents||{}).reduce((n,group)=>n+Object.keys(group||{}).length*192,0);cache.delete(symbol);cache.set(symbol,raw);bytes+=raw.bytes;
  while(cache.size>maxEntries||bytes>maxBytes){const [key,value]=cache.entries().next().value;cache.delete(key);bytes-=value.bytes;}
 }
 function drain(){
  while(!closed&&active<maxConcurrent&&queue.length){
   const job=queue.shift();if(job.signal.aborted){job.reject(job.signal.reason);continue;}active++;
   let abort;
   const cancellation=new Promise((_,reject)=>{abort=()=>reject(job.signal.reason||stopped());job.signal.addEventListener('abort',abort,{once:true});});
   Promise.race([Promise.resolve().then(job.fn),cancellation]).then(job.resolve,job.reject).finally(()=>{job.signal.removeEventListener('abort',abort);active--;drain();});
  }
 }
 function enqueue(fn,signal){
  if(closed)return Promise.reject(stopped());
  if(queue.length>=maxQueued)return Promise.reject(historyError('HISTORY_BUSY','History queue is full',503));
  return new Promise((resolve,reject)=>{const job={fn,signal,resolve,reject};queue.push(job);queueMicrotask(drain);});
 }
 function parse(symbol,data,from,through){
  if(!data||!Array.isArray(data.timestamp)||!data.indicators?.quote?.[0])throw historyError('HISTORY_BAD_RESPONSE','Invalid source history response',502);
  const meta=data.meta||{},market=marketKeyFor(symbol,meta.exchangeName),zone=meta.exchangeTimezoneName||timezoneForSymbol(symbol);
  if(meta.dataGranularity!=='1d')throw historyError('HISTORY_GRANULARITY','Source did not deliver daily bars',422);
  if(!market||!zone)throw historyError('HISTORY_UNSUPPORTED','Unsupported market or unknown time zone',422);
  const type=instrumentTypeFor(symbol,meta.instrumentType);
  if(!['EQUITY','ETF','INDEX'].includes(type))throw historyError('HISTORY_UNSUPPORTED','Only cash equities, ETFs and indexes are supported',422);
  if(meta.symbol&&String(meta.symbol).toUpperCase()!==symbol)throw historyError('HISTORY_IDENTITY_CONFLICT','Source returned another symbol',422);
  const unit=currencyUnitInfo(meta.currency||'');
  if(!meta.currency&&type!=='INDEX')throw historyError('HISTORY_CURRENCY','Source currency is missing',422);
  const currency=type==='INDEX'?'POINTS':unit.currency,scale=type==='INDEX'?1:unit.scale;
  // Yahoo OHLC is kept as delivered, with denomination normalization only.
  // No adjustment is inferred from adjclose and no total-return claim is made.
  const source=data.source||'yahoo';
  const identity={schemaVersion:1,symbol,source,market,exchangeTimeZone:zone,sessionScope:'regular',currency,sourceCurrency:meta.currency||null,priceScale:scale,instrumentType:type,exchange:meta.exchangeName||null,adjustmentBasis:source+'-source-default-unverified',adjustmentRevision:'normalization-v1',volumeUnit:type==='INDEX'?'unknown':'source-unit-unverified',weekStartsOn:1,calendarVersion:calendarRegistry.version};
  const rows=[],seen=new Map(),warnings=[],today=localDateAt(now(),zone),q=data.indicators.quote[0];
  const rawCount=data.timestamp.length;
  for(let i=0;i<rawCount;i++){
   const t=data.timestamp[i];if(!Number.isFinite(t)){warnings.push('invalid-source-timestamp');continue;}
   const sessionDate=localDateAt(t*1000,zone);
   if(sessionDate>today){warnings.push('future-source-record-rejected');continue;}
   if(sessionDate<from||sessionDate>through)continue;
   const candidate={sessionDate,o:q.open?.[i],h:q.high?.[i],l:q.low?.[i],c:q.close?.[i],v:null,sourceVolume:q.volume?.[i]??null,source,currency,adjustmentBasis:identity.adjustmentBasis,volumeUnit:identity.volumeUnit,quality:'source-unverified'};
   if(!normalizeDailyBar(candidate)){warnings.push('invalid-source-ohlcv');continue;}
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
  return {rows,identity,retrievalLimited:!!data.retrievalLimited,seriesId:contentHash(identity),from,through,listingDate,originReached:!!listingDate&&from<=listingDate&&rows[0]?.sessionDate===listingDate&&!budgetLimited,checkedAt:now(),fullCheckedAt:now(),sourceEvents:data.events||{},warnings:[...new Set(warnings)],budgetLimited};
 }
 async function readRange(symbol,from,through,signal){
  const start=Math.floor(dateMs(addDays(from,-2))/1000),end=Math.floor(dateMs(addDays(through,2))/1000);
  const query='?interval=1d&period1='+start+'&period2='+end+'&events=div%2Csplits&includeAdjustedClose=true&includePrePost=false';
  return parse(symbol,await fetchChart(symbol,query,{signal,priority:'history',deadlineMs:Math.min(deadlineMs,12000)}),from,through);
 }
 async function ensureRaw(symbol,start){
  const failure=failures.get(symbol);
  if(failure && failure.retryAt>now())throw Object.assign(historyError(failure.code,'History source is cooling down',failure.statusCode),{retryAt:failure.retryAt});
  demands.set(symbol,demands.has(symbol)&&demands.get(symbol)<start?demands.get(symbol):start);
  if(rawInflight.has(symbol)){
   const raw=await rawInflight.get(symbol).promise;
   if(raw.from>start)return ensureRaw(symbol,start);
   return raw;
  }
  const existing=cache.get(symbol);
  if(existing&&existing.from<=start&&now()-existing.checkedAt<cacheTtl&&!existing.failedAt){demands.delete(symbol);return existing;}
  const owner=generation,controller=new AbortController();controllers.add(controller);
  let timer;
  const record={controller,subscribers:0,promise:null};
  record.promise=enqueue(async()=>{
   timer=setTimeout(()=>controller.abort(historyError('HISTORY_TIMEOUT','History source deadline exceeded',504)),deadlineMs);
   if(controller.signal.aborted)throw controller.signal.reason;
   const prior=cache.get(symbol),needed=demands.get(symbol)||start;demands.delete(symbol);
   const zone=prior?.identity.exchangeTimeZone||timezoneForSymbol(symbol);
   const today=localDateAt(now(),zone);
   let raw;
   const full=!prior||needed<prior.from||now()-prior.fullCheckedAt>=fullTtl;
   if(full)raw=await readRange(symbol,prior&&prior.from<needed?prior.from:needed,today,controller.signal);
   else{
    const tailFrom=addDays(prior.rows.at(-1)?.sessionDate||today,-14);
    const tail=await readRange(symbol,tailFrom,today,controller.signal);
    if(tail.seriesId!==prior.seriesId)raw=await readRange(symbol,prior.from,today,controller.signal);
    else{
     const overlap=new Map(prior.rows.map(b=>[b.sessionDate,b]));
     const corrected=tail.rows.some(b=>b.sessionDate<prior.rows.at(-1)?.sessionDate&&overlap.has(b.sessionDate)&&contentHash(overlap.get(b.sessionDate))!==contentHash(b));
     if(corrected||Object.keys(tail.sourceEvents.splits||{}).some(k=>!prior.sourceEvents.splits?.[k]))raw=await readRange(symbol,prior.from,today,controller.signal);
     else{
      for(const b of tail.rows)overlap.set(b.sessionDate,b);
      raw={...prior,rows:[...overlap.values()].sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate)),checkedAt:tail.checkedAt,through:today,warnings:[...new Set([...prior.warnings,...tail.warnings])],failedAt:null,error:null};
     }
    }
   }
   if(controller.signal.aborted)throw controller.signal.reason;
   if(closed||owner!==generation)throw stopped();
   failures.delete(symbol);remember(symbol,raw);return raw;
  },controller.signal).catch(error=>{
   if(owner===generation&&!closed&&!['HISTORY_CANCELLED','STOPPED'].includes(error.code)) {
    const count=Math.min((failures.get(symbol)?.count||0)+1,8);
    const retryAt=Math.max(now()+Math.min(300000,failureCooldown*2**(count-1)),Number(error.retryAt)||0);
    error.retryAt=retryAt;
    failures.delete(symbol);failures.set(symbol,{count,retryAt,code:error.code||'HISTORY_SOURCE_UNAVAILABLE',statusCode:error.statusCode||503});
    while(failures.size>maxFailureEntries)failures.delete(failures.keys().next().value);
   }
   demands.delete(symbol);
   if(owner===generation&&!closed&&error.code!=='HISTORY_CANCELLED'&&cache.has(symbol)){const old=cache.get(symbol);old.failedAt=now();old.error=error.code||'HISTORY_SOURCE_UNAVAILABLE';old.retryAt=Math.max(now()+60000,Number(error.retryAt)||0);}
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
  if(options.force&&raw)raw.checkedAt=0;
  try{
   if(raw?.retryAt>now()){error=raw.error||'HISTORY_SOURCE_UNAVAILABLE';}
   else{
    const promise=ensureRaw(symbol,start),job=rawInflight.get(symbol);
    if(job)job.subscribers++;
    let abort;
    const cancelled=new Promise((_,reject)=>{
     abort=()=>{if(job&&--job.subscribers<=0)job.controller.abort(historyError('HISTORY_CANCELLED','No history subscribers remain',499));reject(options.signal?.reason||historyError('HISTORY_CANCELLED','History request cancelled',499));};
     if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
    });
    try{raw=await (options.signal?Promise.race([promise,cancelled]):promise);}
    finally{options.signal?.removeEventListener('abort',abort);if(job&&!options.signal?.aborted)job.subscribers--;}
   }
  }catch(e){if(options.signal?.aborted||closed||owner!==generation)throw e;raw=cache.get(symbol);if(!raw)throw e;error=e.code||'HISTORY_SOURCE_UNAVAILABLE';}
  if(!raw)throw historyError('HISTORY_SOURCE_UNAVAILABLE','No source history available',503);
  if(closed||owner!==generation)throw stopped();
  if(query.seriesId&&query.seriesId!==raw.seriesId)throw historyError('HISTORY_SERIES_CHANGED','History identity changed; reload the series',409);
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
  const hasMore=availableMore?true:raw.retrievalLimited?null:raw.originReached?false:reachedBudget?null:true;
  const nextBefore=bars[0]?.periodStart||(hasMore===true?raw.from:null);
  const stale=!!error||now()-raw.checkedAt>=cacheTtl;
  const warnings=[...new Set(['source-adjustment-unverified','source-volume-unit-unverified','historical-calendar-coverage-limited',...raw.warnings,...(stale?['history-source-stale']:[]),...(reachedBudget&&!raw.originReached?['history-retrieval-budget']:[])])];
  const coverage={status:bars.some(b=>b.coverageStatus==='partial')?'partial':bars.every(b=>b.coverageStatus==='complete-to-asof')&&bars.length?'complete-to-asof':'unknown',requestedFrom:raw.from,firstTradingDate:raw.rows[0]?.sessionDate||null,lastTradingDate:asOf,sourceFirstTradeDate:raw.listingDate,originProven:raw.originReached,stopReason:raw.retrievalLimited?'fallback-window':reachedBudget?'retrieval-budget':raw.originReached?'source-first-trade-date':null};
  const status=stale?'stale':bars.length?'ready':'empty';
  const revision=contentHash([raw.seriesId,period,bars,coverage,status,warnings]);
  return {...raw.identity,symbol,period,seriesId:raw.seriesId,revision,historyAsOf:asOf,sourceCheckedAt:raw.checkedAt,stale,status,warnings,coverage,coverageStatus:coverage.status,priceBasis:raw.identity.adjustmentBasis,requestedCount:query.count,returnedCount:bars.length,nextBefore,hasMore,bars,...(error?{errorCode:error,retryAt:raw.retryAt||null}:{})};
 }
 function close(){closed=true;generation++;for(const c of controllers)c.abort(stopped());for(const job of queue.splice(0))job.reject(stopped());rawInflight.clear();demands.clear();failures.clear();cache.clear();bytes=0;}
 function reopen(){closed=false;}
 function clear(){close();reopen();}
 return {get,close,reopen,clear,cache,diagnostics:()=>({entries:cache.size,failureEntries:failures.size,bytes,byteAccounting:'estimated',aggregateBuilds,inflight:rawInflight.size,active,queued:queue.length,closed})};
}
