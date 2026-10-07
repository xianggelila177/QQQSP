import {createTaskQueue} from './task-queue.js';
import {futureInstrumentFor} from './futures-instruments.js';
import {aggregateHistory,periodBounds,periodTiming} from './history-aggregate.js';
import {normalizeDailyBar,historyQuery,validSymbol,validDate,contentHash,localDateAt,dateMs,addDays,historyError} from './history-contract.js';
import {timezoneForSymbol,calendarRegistry} from '../mkt.mjs';
import {marketKeyFor,instrumentTypeFor,instrumentClassification} from './instruments.js';
import {currencyUnitInfo} from './currency.js';
import {normalizeVolume,volumeCapability} from './volume-normalizer.js';
import {historyCloseConflict} from './history-close-consistency.js';
import {validPrice} from './price-values.js';
import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {failureAppliesToRange,sourceTiming,historyExtent} from './history-state-contract.js';
import {createPriorityHandle} from './request-priority.js';
const RECENT_DAILY_COUNT=79,RECENT_ROW_LIMIT=RECENT_DAILY_COUNT+16;
function mergedInvalidDates(previous,next){
 const accepted=new Set(next.rows.map(row=>row.sessionDate));
 return [...new Set([...(previous.sourceInvalidDates||[]).filter(date=>!accepted.has(date)),...(next.sourceInvalidDates||[])])].sort();
}
function lowerBound(rows,date,key='sessionDate'){
 let left=0,right=rows.length;
 while(left<right){const middle=(left+right)>>>1;if(rows[middle][key]<date)left=middle+1;else right=middle;}
 return left;
}
function rowAt(rows,date){
 const index=lowerBound(rows,date);return rows[index]?.sessionDate===date?rows[index]:null;
}
function mergeRows(previous,next){
 const rows=[];let i=0,j=0;
 while(i<previous.length&&j<next.length){
  if(previous[i].sessionDate<next[j].sessionDate)rows.push(previous[i++]);
  else{if(previous[i].sessionDate===next[j].sessionDate)i++;rows.push(next[j++]);}
 }
 while(i<previous.length)rows.push(previous[i++]);while(j<next.length)rows.push(next[j++]);
 return rows;
}

export function createHistoryService({fetchChart,getQuote=()=>null,now=()=>Date.now(),cacheTtl=60000,fullTtl=86400000,maxDaily=20000,maxEntries=MAX_WATCHLIST_SYMBOLS,maxBytes=48*1024*1024,maxConcurrent=1,maxQueued=16,deadlineMs=18000,totalDeadlineMs=20000,maxYears=45,failureCooldown=60000,maxFailureEntries=128}={}){
 const failures=new Map(),aggregated=new WeakMap(),quarantined=new WeakMap(),contents=new WeakMap();
 const taskQueue=createTaskQueue({maxActive:maxConcurrent,maxQueued,now});
 const restoreSkipped={total:0,reasons:{}};
 let aggregateBuilds=0,aggregateStateUpdates=0,aggregateIncrementalBuilds=0,aggregateInputRows=0;
 const cache=new Map(),longCache=new Map(),rawInflight=new Map(),controllers=new Set();
 const nearBudget=Math.floor(maxBytes/2),longBudget=maxBytes-nearBudget;
 let nearBytes=0,longBytes=0,cacheHits=0,evictions=0,tailMerges=0,crossTierInvalidations=0,admissionRejections=0,admissionProjections=0;
 let generation=0,closed=false,bytes=0;
 const stopped=()=>historyError('STOPPED','History service stopped',503);
 // Only data/identity/quality belong to the aggregate owner. Check clocks and
 // retry state stay on each raw response, so an unchanged tail can refresh its
 // freshness without discarding thousands of stable candles. Never hash rows.
 const contentMetadata=raw=>contentHash([raw.seriesId,raw.from,raw.requestedFrom,raw.listingDate,raw.sourceInvalidDates,
  raw.sourceEvents,raw.warnings,raw.latestSessionPending,raw.originReached,raw.budgetLimited,raw.retrievalLimited,
  raw.retrievalStopReason,raw.sourceHasMore,raw.sourceVolumeCoverage,raw.cursorWindow]);
 function contentFor(raw){
  let content=contents.get(raw);
  if(!content){content=Object.freeze({rows:raw.rows,metadata:contentMetadata(raw)});contents.set(raw,content);}
  return content;
 }
 function reuseContent(previous,next,tailDate=null){
  const prior=contentFor(previous),metadata=contentMetadata(next);
  if(prior.metadata!==metadata)return next;
  if(previous.rows===next.rows)contents.set(next,prior);
  else if(tailDate&&previous.rows.length===next.rows.length&&previous.rows.at(-1)?.sessionDate===tailDate&&next.rows.at(-1)?.sessionDate===tailDate){
   // Callers prove that only the final row changed. Inherit aggregate values,
   // never an owner chain: an unread period keeps one bounded dirty suffix even
   // after many tail updates. Identity/quality/events/coverage changes fall back.
   const periods=aggregated.get(prior);
   if(periods){
    const owner=Object.freeze({rows:next.rows,metadata});contents.set(next,owner);
    aggregated.set(owner,new Map([...periods].map(([period,entry])=>[period,{...entry,dirtyFrom:entry.dirtyFrom&&entry.dirtyFrom<tailDate?entry.dirtyFrom:tailDate}])));
   }
  }
  return next;
 }
 function remove(store,symbol){const old=store.get(symbol);if(!old)return;store.delete(symbol);bytes-=old.bytes;if(store===cache)nearBytes-=old.bytes;else longBytes-=old.bytes;}
 function lookup(symbol,tier){
  const store=tier==='near'?cache:longCache,other=tier==='near'?longCache:cache;
  const raw=store.get(symbol)||other.get(symbol);
  if(raw){const owner=store.has(symbol)?store:other;owner.delete(symbol);owner.set(symbol,raw);}
  return raw;
 }
 function remember(symbol,raw,tier='near'){
  const store=tier==='near'?cache:longCache;
  // Budget is a conservative estimate, not serialized payload size.
  const estimate=value=>4096+value.rows.length*(384+4*512)+(value.sourceInvalidDates?.length||0)*24+Object.values(value.sourceEvents||{}).reduce((n,group)=>n+Object.keys(group||{}).length*192,0);
  const budget=tier==='near'?nearBudget:longBudget;
  raw.bytes=estimate(raw);
  // An entry that cannot fit must not flush other admitted histories first.
  if(raw.bytes>budget){
   admissionRejections++;
   const previous=store.get(symbol);
   // Preserve a useful same-symbol window using NEW source facts, not the old
   // prices/identity/events. An expansion may revise an adjusted series. Keep
   // its truthful queried boundary so a later wider read still fetches older
   // data; this is a cache projection, not source exhaustion or a merged gap.
   if(tier==='long'&&previous&&raw.from<=previous.from&&raw.through>=previous.through){
    const rows=raw.rows.slice(lowerBound(raw.rows,previous.from));
    const projection={...raw,rows,from:previous.from,requestedFrom:previous.from,
     sourceInvalidDates:(raw.sourceInvalidDates||[]).filter(date=>date>=previous.from),
     originReached:raw.originReached&&rows.length===raw.rows.length};
    projection.bytes=estimate(projection);
    if(projection.bytes<=budget-longBytes+previous.bytes){raw=projection;admissionProjections++;}
    else{remove(store,symbol);return;}
   }else{remove(store,symbol);return;}
  }
  remove(store,symbol);
  store.set(symbol,raw);bytes+=raw.bytes;if(tier==='near')nearBytes+=raw.bytes;else longBytes+=raw.bytes;
  while(store.size>maxEntries||(tier==='near'?nearBytes>nearBudget:longBytes>longBudget)){remove(store,store.keys().next().value);evictions++;}
 }
 function retainRaw(symbol,raw,tier){
  // Long history cannot spend the recent watchlist's reservation. Shared tails
  // are copied only when content/identity changed; WeakMap aggregates die with
  // their evicted raw owners, and prewarm retains only bounded response slices.
  const previous=(tier==='near'?cache:longCache).get(symbol),other=tier==='near'?longCache.get(symbol):cache.get(symbol);
  const unchanged=previous&&contentFor(previous)===contentFor(raw);
  const confirmsOther=other&&raw.rows.at(-1)?.sessionDate>=other.rows.at(-1)?.sessionDate&&raw.through>=other.through;
  if(other&&unchanged){
   if(tier==='long'&&confirmsOther&&raw.checkedAt>other.checkedAt){other.checkedAt=raw.checkedAt;other.sourceCheckedAt=raw.sourceCheckedAt;other.sourceTimeBasis=raw.sourceTimeBasis;other.sourceFreshUntil=raw.sourceFreshUntil;other.through=raw.through;}
  }else if(other){
   const incoming=new Map(raw.rows.map(row=>[row.sessionDate,row]));
   const changedRows=other.rows.filter(row=>incoming.has(row.sessionDate)&&contentHash(incoming.get(row.sessionDate))!==contentHash(row));
   const eventChange=Object.entries(raw.sourceEvents||{}).some(([kind,events])=>Object.entries(events).some(([key,event])=>contentHash(other.sourceEvents?.[kind]?.[key]??null)!==contentHash(event)));
   const unsafe=other.seriesId!==raw.seriesId||eventChange||changedRows.some(row=>row.sessionDate<other.rows.at(-1)?.sessionDate);
   const qualityChanged=(raw.sourceInvalidDates||[]).some(date=>date>=other.from&&date<=other.through&&!(other.sourceInvalidDates||[]).includes(date))||
    (other.sourceInvalidDates||[]).some(date=>incoming.has(date));
   const changed=changedRows.length||raw.rows.at(-1)?.sessionDate>other.rows.at(-1)?.sessionDate||qualityChanged;
   if(unsafe){remove(tier==='near'?longCache:cache,symbol);crossTierInvalidations++;}
   else if(changed){
    const rows=new Map(other.rows.map(row=>[row.sessionDate,row]));for(const row of raw.rows)rows.set(row.sessionDate,row);
    const ordered=[...rows.values()].sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate));
    const limit=tier==='near'?maxDaily:RECENT_ROW_LIMIT,trimmed=ordered.length>limit,retained=ordered.slice(-limit);
    const next={...other,rows:retained,sourceInvalidDates:mergedInvalidDates(other,raw).filter(date=>date>=retained[0].sessionDate),checkedAt:raw.checkedAt,sourceCheckedAt:raw.sourceCheckedAt,sourceTimeBasis:raw.sourceTimeBasis,sourceFreshUntil:raw.sourceFreshUntil,
     through:raw.through,latestSessionPending:raw.latestSessionPending,
     warnings:[...new Set([...other.warnings.filter(w=>w!=='latest-session-pending'),...raw.warnings])],
     ...(trimmed?{from:retained[0].sessionDate,originReached:false,budgetLimited:tier==='near'?true:other.budgetLimited}:{}),
    };
    const tailDate=changedRows.length===1&&changedRows[0].sessionDate===other.rows.at(-1)?.sessionDate&&!qualityChanged?changedRows[0].sessionDate:null;
    remember(symbol,reuseContent(other,next,tailDate),tier==='near'?'long':'near');tailMerges++;
   }else if(tier==='long'&&confirmsOther&&raw.checkedAt>other.checkedAt){other.checkedAt=raw.checkedAt;other.sourceCheckedAt=raw.sourceCheckedAt;other.sourceTimeBasis=raw.sourceTimeBasis;other.sourceFreshUntil=raw.sourceFreshUntil;other.through=raw.through;}
  }
  if(tier==='long')remember(symbol,raw,'long');
  if(tier==='near'||!cache.has(symbol)){
   const rows=raw.rows.slice(-RECENT_ROW_LIMIT),trimmed=rows.length<raw.rows.length;
   // A bounded recent projection may be refetched/expanded by a sparse query.
   const recent=trimmed?{...raw,rows,sourceInvalidDates:(raw.sourceInvalidDates||[]).filter(date=>date>=rows[0].sessionDate),from:rows[0].sessionDate,requestedFrom:rows[0].sessionDate,originReached:false,cursorWindow:null}:raw;
   remember(symbol,recent,'near');
  }
 }
 function enqueue(fn,signal,priority){
  return taskQueue.run(fn,{signal,priority}).catch(error=>{
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
  if(!['EQUITY','ETF','MUTUALFUND','INDEX','FUTURE'].includes(type))throw historyError('HISTORY_UNSUPPORTED','Unsupported history instrument type',422);
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
  const quality=data.historyQuality;
  if(quality!=null&&(!Array.isArray(quality.missingTradingDates)||quality.missingTradingDates.length>maxDaily||
    quality.missingTradingDates.some(date=>!validDate(date)||date>today)||quality.reason!=='source-invalid-ohlc'))
   throw historyError('HISTORY_BAD_RESPONSE','Invalid source history quality metadata',502);
  const sourceInvalidDates=[...new Set((quality?.missingTradingDates||[]).filter(date=>date>=from&&date<=through))].sort();
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
  return {rows,sourceInvalidDates,identity,latestSessionPending,retrievalLimited:!!data.retrievalLimited,sourceHasMore:data.hasMore===true?true:data.hasMore===false?false:null,
   seriesId:contentHash(identity),from,requestedFrom,through,listingDate,originReached:!!listingDate&&from<=listingDate&&rows[0]?.sessionDate===listingDate&&!budgetLimited,checkedAt:now(),fullCheckedAt:now(),...sourceTiming(data,now()),sourceEvents:data.events||{},
   retrievalStopReason:typeof data.coverage?.stopReason==='string'?data.coverage.stopReason:null,
   sourceVolumeCoverage:typeof meta.sourceVolumeCoverage==='string'?meta.sourceVolumeCoverage:null,
   warnings:[...new Set(warnings)],budgetLimited};
 }
 async function readRange(symbol,from,through,signal,hint={}){
  const start=Math.floor(dateMs(addDays(from,-2))/1000),end=Math.floor(dateMs(addDays(through,2))/1000);
  const query='?interval=1d&period1='+start+'&period2='+end+'&events=div%2Csplits&includeAdjustedClose=true&includePrePost=false';
  const result=parse(symbol,await fetchChart(symbol,query,{signal,priority:hint.priority??'foreground',deadlineMs:Math.min(deadlineMs,12000),
   requestedPeriod:hint.period||null,requestedCount:hint.count||null,pageBefore:hint.pageBefore||null}),from,through);
  result.cursorWindow=hint.pageBefore||null;
  return result;
 }
 function pagedNeedsOlder(raw,hint){
  if(raw?.sourceHasMore!==true||!hint.period||!hint.count)return false;
  const available=new Set(raw.rows.filter(row=>!hint.pageBefore||periodBounds(row.sessionDate,hint.period).periodStart<hint.pageBefore)
   .map(row=>periodBounds(row.sessionDate,hint.period).periodStart));
  return available.size<hint.count;
 }
 function separateWindow(raw,hint){
  return !!(raw&&hint.pageBefore&&hint.period&&hint.pageBefore<periodBounds(raw.from,hint.period).periodStart);
 }
 function coversFreshRequest(raw,start,through,hint){
  return raw&&raw.through>=through&&!separateWindow(raw,hint)&&!pagedNeedsOlder(raw,hint)&&!(raw.cursorWindow&&!hint.pageBefore)&&
   (raw.from<=start||raw.retrievalLimited&&raw.requestedFrom<=start)&&now()-raw.checkedAt<cacheTtl&&(!raw.failedAt||start>raw.failedFrom);
 }
 function sourceCooldown(symbol,start,through){
  const failure=failures.get(symbol);
  if(failure&&failure.retryAt>now()&&(failure.blocksAll||failure.instrumentType===instrumentClassification(symbol,getQuote(symbol)||{}).type&&
   (!failure.through||start<=failure.through&&through>=failure.from)&&(failure.emptyRange?start>=failure.from:start<=failure.from)))
   return Object.assign(historyError(failure.code,'History source is cooling down',failure.statusCode),{retryAt:failure.retryAt,emptyRange:failure.emptyRange});
  return null;
 }
 const failedRangeApplies=(raw,start,through)=>failureAppliesToRange(raw,start)&&
  (raw.failureBlocksAll||!raw.failedThrough||start<=raw.failedThrough&&through>=raw.failedFrom);
 function ensureRaw(symbol,start,hint={}){
  const through=hint.pageBefore?addDays(hint.pageBefore,-1):localDateAt(now(),timezoneForSymbol(symbol));
  const existing=lookup(symbol,hint.tier);
  if(coversFreshRequest(existing,start,through,hint)){cacheHits++;return {promise:Promise.resolve(existing),record:null};}
  const failure=sourceCooldown(symbol,start,through);if(failure)throw failure;
  // Provider hints can change a bounded source's result, even for overlapping
  // dates. Share only the same request contract; other windows use the same
  // bounded queue and are rechecked against cache after they reach its head.
  const key=JSON.stringify([symbol,start,through,hint.period,hint.count,hint.pageBefore||null,hint.tier]);
  const pending=rawInflight.get(key);
  if(pending&&!pending.controller.signal.aborted){pending.priority.promote(hint.priority??'foreground');return {promise:pending.promise,record:pending};}
  const owner=generation,controller=new AbortController();controllers.add(controller);
  let timer;
  const record={symbol,controller,subscribers:0,promise:null,from:start,through,priority:createPriorityHandle(hint.priority??'foreground')};
  record.promise=enqueue(async()=>{
   timer=setTimeout(()=>controller.abort(historyError('HISTORY_TIMEOUT','History source deadline exceeded',504)),deadlineMs);
   if(controller.signal.aborted)throw controller.signal.reason;
   const needed=start,requested={...hint,priority:record.priority};
   const prior=lookup(symbol,requested.tier);
   // Another contract may have completed or established a host/symbol cooldown
   // while this one waited. Neither a cache hit nor a suppressed retry fetches.
   if(coversFreshRequest(prior,needed,through,requested)){cacheHits++;return prior;}
   const cooldown=sourceCooldown(symbol,needed,through);if(cooldown){record.suppressed=true;throw cooldown;}
   // Different request contracts may run concurrently. Retention is optimistic:
   // a result may publish only while no other result has replaced/confirmed this
   // symbol's cache owners. A late reader still receives its own result, but it
   // cannot replace a newer published window or advance an unrelated clock.
   const owners=[cache,longCache].map(store=>{const entry=store.get(symbol);return {store,entry,checkedAt:entry?.sourceCheckedAt};});
   record.from=needed;
   const zone=prior?.identity.exchangeTimeZone||timezoneForSymbol(symbol);
   const today=localDateAt(now(),zone);
   let raw;const detached=separateWindow(prior,requested);
   const pagedBackfill=!(prior?.cursorWindow&&!requested.pageBefore)&&pagedNeedsOlder(prior,requested);
   const full=!prior||needed<prior.from&&!prior.retrievalLimited||prior.identity.source!=='twse-stock-day'&&
    (needed<prior.from||now()-prior.fullCheckedAt>=fullTtl)||prior.cursorWindow&&!requested.pageBefore;
   if(detached){
    // An explicit jump farther than the retained boundary is a separate source
    // window. Do not spend each request walking from today toward its cursor,
    // and do not join two ranges across an unqueried gap or evict the latest one.
    raw=await readRange(symbol,needed,addDays(requested.pageBefore,-1),controller.signal,requested);
   }
   else if(pagedBackfill){
    const older=await readRange(symbol,needed,addDays(prior.from,-1),controller.signal,{...requested,pageBefore:prior.from});
    if(older.seriesId!==prior.seriesId){
     // Commit the independently validated new source without splicing. The
     // caller's seriesId check below returns 409 and its reload gets a fresh
     // recent window, instead of repeatedly retaining the incompatible source.
     raw=older;
    }else{
    if(!older.rows.length||older.rows.at(-1).sessionDate>=prior.from)throw historyError('HISTORY_CONFLICT','History backfill overlaps existing history',422);
    const rows=[...older.rows,...prior.rows],budgetLimited=rows.length>maxDaily;
    if(budgetLimited)rows.splice(0,rows.length-maxDaily);
    const retrievalLimited=budgetLimited||older.retrievalLimited;
    raw={...prior,rows,sourceInvalidDates:mergedInvalidDates(prior,older).filter(date=>date>=rows[0].sessionDate),from:budgetLimited?rows[0].sessionDate:older.from,
     requestedFrom:prior.requestedFrom&&prior.requestedFrom<needed?prior.requestedFrom:needed,
     retrievalLimited,sourceHasMore:budgetLimited?null:older.sourceHasMore,
     retrievalStopReason:older.retrievalStopReason,originReached:!budgetLimited&&older.originReached,
     checkedAt:now(),sourceCheckedAt:Math.min(prior.sourceCheckedAt??prior.checkedAt,older.sourceCheckedAt??older.checkedAt),budgetLimited,cursorWindow:null,
     warnings:[...new Set([...prior.warnings.filter(w=>w!=='fallback-history-window-limited'),...older.warnings,
      ...(retrievalLimited?['fallback-history-window-limited']:[]),...(budgetLimited?['history-memory-row-budget']:[])])],
     failedAt:null,failedFrom:null,failedThrough:null,failureBlocksAll:null,error:null,retryAt:null};
    }
   }
   // A first cursor read has no current window to refresh. Fetch only its
   // exclusive end, like a detached page; a later current read rechecks through.
   else if(full)raw=await readRange(symbol,prior&&prior.from<needed?prior.from:needed,!prior&&requested.pageBefore?through:today,controller.signal,requested);
   else{
    const tailFrom=addDays(prior.rows.at(-1)?.sessionDate||today,-14);
    const tail=await readRange(symbol,tailFrom,today,controller.signal,requested);
    if(tail.seriesId!==prior.seriesId)raw=await readRange(symbol,prior.from,today,controller.signal,requested);
    else{
     const changes=tail.rows.filter(row=>{const old=rowAt(prior.rows,row.sessionDate);return !old||contentHash(old)!==contentHash(row);});
     const corrected=changes.some(row=>row.sessionDate<prior.rows.at(-1)?.sessionDate&&rowAt(prior.rows,row.sessionDate));
     const eventChange=Object.entries(tail.sourceEvents).some(([kind,events])=>Object.entries(events).some(([key,event])=>contentHash(prior.sourceEvents[kind]?.[key]??null)!==contentHash(event)));
     if((corrected||eventChange)&&
      prior.identity.source!=='twse-stock-day')raw=await readRange(symbol,prior.from,today,controller.signal,requested);
     else{
      const sourceEvents={...prior.sourceEvents};for(const [kind,events] of Object.entries(tail.sourceEvents))sourceEvents[kind]={...sourceEvents[kind],...events};
       const tailDate=changes.length===1&&changes[0].sessionDate===prior.rows.at(-1)?.sessionDate?changes[0].sessionDate:null;
       raw=reuseContent(prior,{...prior,rows:changes.length?mergeRows(prior.rows,tail.rows):prior.rows,sourceEvents,sourceInvalidDates:mergedInvalidDates(prior,tail),checkedAt:tail.checkedAt,sourceCheckedAt:tail.sourceCheckedAt,sourceTimeBasis:tail.sourceTimeBasis,sourceFreshUntil:tail.sourceFreshUntil,through:today,
        latestSessionPending:tail.latestSessionPending,warnings:[...new Set([...prior.warnings.filter(w=>w!=='latest-session-pending'),...tail.warnings])],failedAt:null,failedFrom:null,failedThrough:null,failureBlocksAll:null,error:null,retryAt:null},tailDate);
     }
    }
   }
   if(controller.signal.aborted)throw controller.signal.reason;
   if(closed||owner!==generation)throw stopped();
   const superseded=owners.some(({store,entry,checkedAt})=>{const current=store.get(symbol);return current&&(current!==entry||current.sourceCheckedAt!==checkedAt);});
   const detachedAtCommit=separateWindow(lookup(symbol,requested.tier),requested);
   failures.delete(symbol);if(!detached&&!detachedAtCommit&&!superseded)retainRaw(symbol,raw,requested.tier);return raw;
  },controller.signal,record.priority).catch(error=>{
   if(!record.suppressed&&owner===generation&&!closed&&!['HISTORY_CANCELLED','STOPPED','HISTORY_BUSY','REQUEST_CANCELLED'].includes(error.code)) {
    const count=Math.min((failures.get(symbol)?.count||0)+1,8);
    const retryAt=Math.max(now()+Math.min(300000,failureCooldown*2**(count-1)),Number(error.retryAt)||0);
    error.retryAt=retryAt;
    const blocksAll=error.status===429||error.statusCode===429||['HISTORY_RATE_LIMITED','SOURCE_COOLDOWN','RATE_LIMITED'].includes(error.code);
    failures.delete(symbol);failures.set(symbol,{count,retryAt,code:error.code||'HISTORY_SOURCE_UNAVAILABLE',statusCode:error.statusCode||503,from:record.from,through:record.through,blocksAll,emptyRange:!!error.emptyRange||error.code==='HISTORY_EMPTY',instrumentType:instrumentClassification(symbol,getQuote(symbol)||{}).type});
    while(failures.size>maxFailureEntries)failures.delete(failures.keys().next().value);
   }
   if(!record.suppressed&&owner===generation&&!closed&&!['HISTORY_CANCELLED','HISTORY_BUSY','REQUEST_CANCELLED'].includes(error.code))for(const store of [cache,longCache]){
    const old=store.get(symbol);if(!old)continue;
    if(old.identity.source==='twse-stock-day'&&error.code==='HISTORY_EMPTY')old.sourceHasMore=null;
    old.failedAt=now();old.failedFrom=record.from;old.failedThrough=record.through;
    old.failureBlocksAll=error.status===429||error.statusCode===429||['HISTORY_RATE_LIMITED','SOURCE_COOLDOWN','RATE_LIMITED'].includes(error.code);
    old.error=error.code||'HISTORY_SOURCE_UNAVAILABLE';old.retryAt=Math.max(now()+60000,Number(error.retryAt)||0);
   }
   throw error;
  }).finally(()=>{clearTimeout(timer);controllers.delete(controller);if(rawInflight.get(key)===record)rawInflight.delete(key);});
  rawInflight.set(key,record);return {promise:record.promise,record};
 }
 async function get(symbol,period,options={}){
  if(closed)throw stopped();
  const query=historyQuery(symbol,period,options);symbol=query.symbol;
  if(!validSymbol(symbol)||!marketKeyFor(symbol))throw historyError('BAD_HISTORY_QUERY','Invalid or unsupported symbol');
  const owner=generation,zone=timezoneForSymbol(symbol),today=localDateAt(now(),zone),endDate=query.before||today,through=query.before?addDays(query.before,-1):today;
  const requestedYears=period==='yearly'?query.count+1:period==='monthly'?Math.ceil(query.count/12)+1:period==='weekly'?Math.ceil(query.count/52)+1:Math.ceil(query.count/252)+1;
  const year=Math.max(1900,Number(endDate.slice(0,4))-Math.min(maxYears,requestedYears));
  const tier=period==='daily'&&!query.before&&query.count<=RECENT_DAILY_COUNT?'near':'long';
  const boundedDaily=period==='daily';
  let span=Math.ceil(query.count*7/5)+14;
  const minimumStart=year+'-01-01';
  let start=boundedDaily?addDays(endDate,-span):minimumStart,raw=lookup(symbol,tier),error=null;
  if(options.cacheOnly&&!raw)throw historyError('HISTORY_WARMING','历史后台准备中',503);
  if(options.force&&raw)raw.checkedAt=0;
  try{
   if(raw?.retryAt>now()&&failedRangeApplies(raw,start,through)){error=raw.error||'HISTORY_SOURCE_UNAVAILABLE';}
   else if(options.cacheOnly){error=failedRangeApplies(raw,start,through)?raw.error:null;}
   else{
    const timeout=new AbortController();
    const timer=setTimeout(()=>timeout.abort(historyError('HISTORY_TIMEOUT','History total deadline exceeded',504)),Math.max(1,Math.min(totalDeadlineMs,(options.deadlineAt??now()+totalDeadlineMs)-now())));
    const signal=options.signal?AbortSignal.any([options.signal,timeout.signal]):timeout.signal;
    try{
     let expansions=0,rangeRetries=0,previousOldest=null;
     do {
      signal.throwIfAborted();
      const {promise,record:job}=ensureRaw(symbol,start,{period,count:query.count,pageBefore:query.before,tier,priority:options.priority});
      if(job)job.subscribers++;
      let abort;
      const cancelled=new Promise((_,reject)=>{
       abort=()=>reject(signal.reason);
       signal.addEventListener('abort',abort,{once:true});
       if(signal.aborted)abort();
      });
      try{raw=await Promise.race([promise,cancelled]);}
      catch(e){
       if(!signal.aborted&&boundedDaily&&(e.emptyRange||e.code==='HISTORY_EMPTY')&&expansions<3&&start>minimumStart){
        expansions++;span*=2;start=addDays(endDate,-span);if(start<minimumStart)start=minimumStart;continue;
       }
       throw e;
      }
      finally{
       signal.removeEventListener('abort',abort);
       if(job&&--job.subscribers===0&&signal.aborted)job.controller.abort(historyError('HISTORY_CANCELLED','No history subscribers remain',499));
      }
      if(query.seriesId&&query.seriesId!==raw.seriesId)throw historyError('HISTORY_SERIES_CHANGED','History identity changed; reload the series',409);
      if(raw.through<(query.before?addDays(query.before,-1):today)||raw.from>start&&!raw.budgetLimited&&!raw.retrievalLimited){
       if(++rangeRetries>2)throw historyError('HISTORY_RANGE_UNAVAILABLE','History source did not cover the requested window',503);
       continue;
      }
      if(!boundedDaily||raw.rows.filter(row=>!query.before||row.sessionDate<query.before).length>=query.count||raw.originReached||raw.budgetLimited||raw.retrievalLimited)break;
      const oldest=raw.rows[0]?.sessionDate||null;
      if(expansions>=3||start<=minimumStart||expansions&&oldest===previousOldest){
       raw={...raw,sourceHasMore:null,retrievalLimited:true,retrievalStopReason:'recent-expansion-budget',warnings:[...new Set([...raw.warnings,'history-count-budget'])]};retainRaw(symbol,raw,tier);break;
      }
      previousOldest=oldest;expansions++;span*=2;start=addDays(endDate,-span);if(start<minimumStart)start=minimumStart;
     }while(true);
    }finally{clearTimeout(timer);}

   }
  }catch(e){if(e.code==='HISTORY_SERIES_CHANGED'||options.signal?.aborted||closed||owner!==generation)throw e;raw=lookup(symbol,tier);if(!raw)throw e;error=e.code||'HISTORY_SOURCE_UNAVAILABLE';}
  if(!raw)throw historyError('HISTORY_SOURCE_UNAVAILABLE','No source history available',503);
  if(closed||owner!==generation)throw stopped();
  if(raw.identity.calendarVersion!==calendarRegistry.version){
   const identity={...raw.identity,calendarVersion:calendarRegistry.version};raw={...raw,identity,seriesId:contentHash(identity)};retainRaw(symbol,raw,tier);
  }
  if(query.seriesId&&query.seriesId!==raw.seriesId)throw historyError('HISTORY_SERIES_CHANGED','History identity changed; reload the series',409);
  if(raw.latestSessionPending&&(!query.before||query.before>raw.latestSessionPending)&&
   raw.rows.at(-1)?.sessionDate<raw.latestSessionPending)error ||= 'HISTORY_LATEST_SESSION_PENDING';
  const closeConsistency=historyCloseConflict(symbol,raw.identity.currency,raw.rows,getQuote(symbol),now());
  if(closeConsistency){
   const content=contentFor(raw);let held=quarantined.get(content);
   if(held?.date!==closeConsistency.tradeDate){held={date:closeConsistency.tradeDate,rows:raw.rows.filter(row=>row.sessionDate!==closeConsistency.tradeDate)};quarantined.set(content,held);}
   raw={...raw,rows:held.rows,warnings:[...new Set([...raw.warnings,'daily-close-conflict'])],aggregateOwner:held};
   error='HISTORY_CLOSE_CONFLICT';
  }
  const asOf=raw.rows.at(-1)?.sessionDate||null;
  const aggregateOwner=raw.aggregateOwner||contentFor(raw);
  let periods=aggregated.get(aggregateOwner);if(!periods){periods=new Map();aggregated.set(aggregateOwner,periods);}
  let entry=periods.get(period);
  const at=now(),timingOptions={symbol,zone:raw.identity.exchangeTimeZone,asOf:at};
  if(!entry||entry.dirtyFrom||entry.calendarVersion!==calendarRegistry.version||at<entry.asOf){
   const incremental=entry?.dirtyFrom&&entry.calendarVersion===calendarRegistry.version&&at>=entry.asOf;
   const boundary=incremental?periodBounds(entry.dirtyFrom,period).periodStart:null;
   const rows=incremental?raw.rows.slice(lowerBound(raw.rows,boundary)):raw.rows;
   const invalidPeriods=new Map();
   for(const date of raw.sourceInvalidDates||[]){const key=periodBounds(date,period).periodStart;const dates=invalidPeriods.get(key)||[];dates.push(date);invalidPeriods.set(key,dates);}
   const rebuilt=aggregateHistory(rows,period,{...timingOptions,requestedFrom:raw.from,listingDate:raw.listingDate,historyAsOf:asOf}).map(bar=>invalidPeriods.has(bar.periodStart)?
    {...bar,coverageStatus:'partial',missingTradingDates:invalidPeriods.get(bar.periodStart),qualityFlags:[...new Set([...bar.qualityFlags,'source-invalid-ohlc'])]}:bar);
   const bars=incremental?[...entry.bars.slice(0,lowerBound(entry.bars,boundary,'periodStart')),...rebuilt]:rebuilt;
   aggregateInputRows+=rows.length;if(incremental)aggregateIncrementalBuilds++;
   const dynamic=[];
   bars.forEach((bar,index)=>{if(bar.periodState!=='closed')dynamic.push({index,...periodTiming(bar,timingOptions)});});
   entry={bars,dynamic,asOf:at,calendarVersion:calendarRegistry.version};periods.set(period,entry);aggregateBuilds++;
  }else if(entry.dynamic.some(item=>at>=item.nextAt)){
   const bars=entry.bars.slice(),dynamic=[];
   for(const item of entry.dynamic){
    const timing=at>=item.nextAt?periodTiming(bars[item.index],timingOptions):item;
    if(timing.state!==bars[item.index].periodState){bars[item.index]={...bars[item.index],periodState:timing.state};aggregateStateUpdates++;}
    if(timing.state!=='closed')dynamic.push({index:item.index,...timing});
   }
   entry={...entry,bars,dynamic,asOf:at};periods.set(period,entry);
  }
  let bars=entry.bars;
  // Older raw pages can complete the previously truncated first month/year.
  // Keep before exclusive, and publish only its revised boundary candle as a
  // separate point replacement; clients must not delete a range around it.
  const overlapBars=query.before?entry.bars.filter(bar=>bar.periodStart===query.before):[];
  const filtered=bars.filter(b=>!query.before||b.periodStart<query.before);bars=filtered.slice(-query.count);
  if(raw.warnings.length)bars=bars.map(b=>({...b,coverageStatus:b.coverageStatus==='complete-to-asof'?'unknown':b.coverageStatus,qualityFlags:[...new Set([...b.qualityFlags,...raw.warnings])]}));
  const availableMore=filtered.length>bars.length;
  const reachedBudget=Number(raw.from.slice(0,4))<=1900||raw.budgetLimited;
  const hasMore=availableMore?true:raw.sourceHasMore===true?true:raw.retrievalLimited?null:raw.originReached?false:reachedBudget?null:true;
  const olderCursor=periodBounds(raw.from,period).periodStart;
  const nextBefore=bars[0]?.periodStart||(hasMore===true&&(!query.before||olderCursor<query.before)?olderCursor:null);
  const sourceCheckedAt=raw.sourceCheckedAt??raw.checkedAt,sourceTimeBasis=raw.sourceTimeBasis||'adapter-return-unverified';
  const sourceFreshUntil=Number.isFinite(raw.sourceFreshUntil)?raw.sourceFreshUntil:sourceCheckedAt+cacheTtl;
  const stale=!!error||now()>=sourceFreshUntil;
  const qualityRange=[...bars,...overlapBars],qualityStart=qualityRange[0]?.periodStart,qualityEnd=qualityRange.at(-1)?.periodEndExclusive;
  const missingTradingDates=(raw.sourceInvalidDates||[]).filter(date=>qualityStart&&date>=qualityStart&&date<qualityEnd);
  const historyQuality=missingTradingDates.length?{status:'partial',missingTradingDates,reason:'source-invalid-ohlc'}:null;
  const warnings=[...new Set(['source-adjustment-unverified',...(historyQuality?['source-invalid-ohlc']:[]),...(sourceTimeBasis==='adapter-return-unverified'?['source-check-time-unverified']:[]),...(raw.identity.volumeUnit==='source-unit-unverified'?['source-volume-unit-unverified']:[]),'historical-calendar-coverage-limited',...raw.warnings,...(stale?['history-source-stale']:[]),...(reachedBudget&&!raw.originReached?['history-retrieval-budget']:[])])];
  const coverage={status:bars.some(b=>b.coverageStatus==='partial')?'partial':bars.every(b=>b.coverageStatus==='complete-to-asof')&&bars.length?'complete-to-asof':'unknown',requestedFrom:raw.requestedFrom||raw.from,firstTradingDate:raw.rows[0]?.sessionDate||null,lastTradingDate:asOf,sourceFirstTradeDate:raw.listingDate,originProven:raw.originReached,stopReason:raw.retrievalLimited?'fallback-window':reachedBudget?'retrieval-budget':raw.originReached?'source-first-trade-date':null,
   sourceStopReason:raw.retrievalStopReason||null,sourceHasMore:raw.sourceHasMore??null,sourceVolumeCoverage:raw.sourceVolumeCoverage||null,...(historyQuality?{missingTradingDates}: {})};
  const status=stale?'stale':bars.length?'ready':'empty';
  const revision=contentHash([raw.seriesId,period,bars,overlapBars,coverage,status,warnings]);
  return {...raw.identity,symbol,period,seriesId:raw.seriesId,revision,historyAsOf:asOf,sourceCheckedAt,sourceTimeBasis,sourceFreshUntil,cacheServedAt:now(),
   extent:historyExtent({...query,period},bars,{scope:options.cacheOnly&&!longCache.has(symbol)?'near':'requested',hasMore}),
   stale,status,warnings,coverage,coverageStatus:coverage.status,priceBasis:raw.identity.adjustmentBasis,requestedCount:query.count,returnedCount:bars.length,nextBefore,hasMore,bars,...(historyQuality?{historyQuality}:{}),...(query.before?{overlapBars}:{}),...(closeConsistency?{closeConsistency}:{}),...(error?{errorCode:error,retryAt:raw.retryAt||null}:{})};
 }
 // A single wide daily read feeds all four tabs. Callers share the same raw job.
 async function prepare(symbol,{tier='near',signal,priority='background'}={}){
  await get(symbol,tier==='long'?'yearly':'daily',{count:tier==='long'?39:79,signal,priority});
  return Object.fromEntries(await Promise.all(['daily','weekly','monthly','yearly'].map(async period=>{
   const value=await get(symbol,period,{count:period==='yearly'?39:79,cacheOnly:true});
   return [period,{...value,extent:{...value.extent,scope:tier==='near'?'near':'requested',satisfied:tier==='near'&&period!=='daily'?false:value.extent.satisfied}}];
  })));
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
     if(!date(meta.from)||!date(meta.through)||meta.from>meta.through||meta.requestedFrom!=null&&(!date(meta.requestedFrom)||meta.requestedFrom>meta.from)||meta.failedFrom!=null&&!date(meta.failedFrom)||meta.failedThrough!=null&&!date(meta.failedThrough)||meta.cursorWindow!=null&&!date(meta.cursorWindow)||meta.listingDate!=null&&!date(meta.listingDate)||meta.latestSessionPending!=null&&!date(meta.latestSessionPending)||!timestamp(meta.checkedAt)||!timestamp(meta.fullCheckedAt)){skip('dates');continue;}
   if(meta.sourceInvalidDates!=null&&(!Array.isArray(meta.sourceInvalidDates)||meta.sourceInvalidDates.length>maxDaily||meta.sourceInvalidDates.some(value=>!date(value)||value<(meta.requestedFrom||meta.from)||value>meta.through))){skip('quality');continue;}
   if(!Array.isArray(meta.warnings)||meta.warnings.length>64||meta.warnings.some(v=>typeof v!=='string'||v.length>256)||!events(meta.sourceEvents)||
    meta.retrievalStopReason!=null&&(typeof meta.retrievalStopReason!=='string'||meta.retrievalStopReason.length>128)||
    meta.sourceVolumeCoverage!=null&&(typeof meta.sourceVolumeCoverage!=='string'||meta.sourceVolumeCoverage.length>256)){skip('metadata');continue;}
   if(['originReached','budgetLimited','retrievalLimited'].some(k=>typeof meta[k]!=='boolean')||meta.sourceCheckedAt!=null&&!timestamp(meta.sourceCheckedAt)||meta.sourceFreshUntil!=null&&(!Number.isFinite(meta.sourceFreshUntil)||meta.sourceFreshUntil<(meta.sourceCheckedAt??meta.checkedAt)||meta.sourceFreshUntil>(meta.sourceCheckedAt??meta.checkedAt)+7*86400000)||meta.sourceTimeBasis!=null&&(typeof meta.sourceTimeBasis!=='string'||meta.sourceTimeBasis.length>80)||meta.sourceHasMore!=null&&typeof meta.sourceHasMore!=='boolean'||meta.failureBlocksAll!=null&&typeof meta.failureBlocksAll!=='boolean'||meta.failedAt!=null&&!timestamp(meta.failedAt)||meta.retryAt!=null&&(!Number.isFinite(meta.retryAt)||meta.retryAt<0)||meta.error!=null&&typeof meta.error!=='string'){skip('metadata');continue;}
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
    const restored=Object.fromEntries(['identity','seriesId','from','requestedFrom','through','listingDate','latestSessionPending','originReached','checkedAt','sourceCheckedAt','sourceTimeBasis','sourceFreshUntil','fullCheckedAt','sourceEvents','sourceInvalidDates','retrievalStopReason','sourceHasMore','sourceVolumeCoverage','cursorWindow','warnings','budgetLimited','retrievalLimited','failedAt','failedFrom','failedThrough','failureBlocksAll','error','retryAt'].filter(k=>Object.hasOwn(meta,k)).map(k=>[k,meta[k]]));
   retainRaw(symbol,{...restored,identity:migratedIdentity,seriesId:contentHash(migratedIdentity),rows},rows.length>RECENT_ROW_LIMIT?'long':'near');
  }
 }
 function close(){closed=true;generation++;for(const c of controllers)c.abort(stopped());taskQueue.close();rawInflight.clear();failures.clear();cache.clear();longCache.clear();bytes=0;nearBytes=0;longBytes=0;}
 function reopen(){closed=false;taskQueue.reopen();}
 function clear(){close();reopen();}
 function invalidate(symbol){
  if(!validSymbol(symbol))return false;
  for(const record of rawInflight.values())if(record.symbol===symbol)record.controller.abort(historyError('HISTORY_CANCELLED','History symbol invalidated',499));
  failures.delete(symbol);
  const old=cache.get(symbol)||longCache.get(symbol);remove(cache,symbol);remove(longCache,symbol);
  return !!old;
 }
 return {get,prepare,exportState,restore,close,reopen,clear,invalidate,cache,longCache,diagnostics:()=>({entries:cache.size,longEntries:longCache.size,nearBytes,longBytes,nearBudget,longBudget,cacheHits,evictions,admissionRejections,admissionProjections,tailMerges,crossTierInvalidations,failureEntries:failures.size,bytes,byteAccounting:'raw+four-aggregate-reservation',maxBytes,aggregateBuilds,aggregateIncrementalBuilds,aggregateInputRows,aggregateStateUpdates,inflight:rawInflight.size,...taskQueue.diagnostics(),restoreSkipped,closed})};
}
