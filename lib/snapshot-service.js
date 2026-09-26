import { providerCapabilities, quoteDisplayName, validWeek52Range, instrumentMeta } from './instruments.js';
import {MARKET_REGISTRY,catalogInstrumentFor} from './market-registry.js';
import { publishQuote,isUsableChartFamily,isTerminalChartField as terminalField } from './quote-contract.js';
import {boundedInt} from './http-admission.js';
import {nextMarketTransitionAt,marketSessionStartedAt} from './session-policy.js';
import {intradayLiveFields,intradayObservationStatus} from './intraday-freshness.js';
import {regularChartTarget,chartPreviousClose,recentRegularSessions} from './regular-chart-service.js';
import {mergeTradingStatistics} from './trading-statistics.js';
import {MAX_ACTIVE_QUOTE_SYMBOLS} from './watchlist-limits.js';
// Fast quote snapshots and bounded, independent history enrichment.
// Maximum supported browser economy cadence is two minutes. Leave a generous
// margin for connection time/timer throttling before evicting a live subscriber.
const ACTIVE_TTL = 300000;
const MAX_SYMBOLS = MAX_ACTIVE_QUOTE_SYMBOLS;
const POLL_MS = 2000;
const ENRICH_MS = 60000;
const ENRICH_LIMIT = 2;
const GROUPS = ['us', 'kr', 'jp', 'tw', 'other', 'index'];
const groupOf = symbol => providerCapabilities(symbol).batchGroup;
function catalogIdentity(symbol){
  const catalog=catalogInstrumentFor(symbol);
  if(!catalog)return {};
  return {...instrumentMeta(symbol,{name:catalog.name,exchangeName:catalog.exchange||undefined}),
    exchangeName:catalog.exchange||MARKET_REGISTRY[catalog.market]?.exchange||null,
    currency:catalog.currency||MARKET_REGISTRY[catalog.market]?.currency||null};
}
function quoteTime(quote) {
  const value = Number(quote?.quoteAt ?? quote?.ts);
  return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0;
}
function usable(quote) { return quote && !quote.error && quote.price != null && Number.isFinite(Number(quote.price)); }
const delayOf = value => Number.isFinite(Number(value)) ? Math.max(POLL_MS, Math.min(86400000, Number(value))) : POLL_MS;

// Slow fields succeed independently. Retain the previous successful value and
// its timestamp when a refresh has an unavailable field, and mark it stale.
function mergeEnrichment(previous,next,attemptAt) {
  const out={...next,slowFields:{...next.slowFields}};
  const info=(quote,key)=>quote?.slowFields?.[key] || {source:quote?.src || 'unknown',updatedAt:quote?.fetchedAt || null,stale:!!quote?.stale};
  const range=validWeek52Range(next.week52High,next.week52Low),oldRange=validWeek52Range(previous?.week52High,previous?.week52Low);
  if(range.week52High!=null){Object.assign(out,range);out.slowFields.week52Range=info(next,'week52Range');}
  else if(oldRange.week52High!=null){Object.assign(out,oldRange);out.slowFields.week52Range={...info(previous,'week52Range'),stale:true};}
  const charts={};let retained=false;
  const keys=new Set([...Object.keys(previous?.charts || {}),...Object.keys(next.charts || {})]);
  for(const key of ['intraday','daily30'])if(next.slowFields?.[key])keys.add(key);
  for(const key of keys) {
    const current=info(next,key),terminal=terminalField(current);
    const supplied=isUsableChartFamily(next.charts?.[key]);
    const malformed=Array.isArray(next.charts?.[key])&&next.charts[key].length>0&&!supplied;
    const old=previous?.charts?.[key];
    const explicitFailure=!!current.error || current.failedAt!=null || ['failed','missing','degraded'].includes(current.status);
    // Empty primary data can be legitimate on closed/new/unsupported markets.
    // The US snapshot fallback explicitly has no intraday provider; it cannot
    // complete the primary intraday request even when its price is healthy.
    const expectedMissing=!supplied&&!terminal&&(malformed||explicitFailure||old?.length||
      key==='intraday'&&next.src==='tx-us'&&Object.hasOwn(next.charts || {},key));
    if(supplied){charts[key]=next.charts[key];out.slowFields[key]={...current};}
    else if(old?.length){charts[key]=old;out.slowFields[key]={...info(previous,key),...(terminal?{status:current.status,unsupported:current.unsupported}:{}),stale:true};retained=true;}
    else {charts[key]=[];if(next.slowFields?.[key])out.slowFields[key]={...current};}
    if(expectedMissing || supplied&&!terminal&&(explicitFailure||current.stale)) {
      const retainedInfo=out.slowFields[key] || {source:current.source,updatedAt:null};
      const absolute=Number(current.retryAt),relative=Number(current.retryAfterMs);
      const retryAt=Math.max(Number(retainedInfo.retryAt)||0,Number.isFinite(absolute)?absolute:0,Number.isFinite(relative)&&relative>0?attemptAt+relative:0);
      out.slowFields[key]={...retainedInfo,retryAt:retryAt || undefined,retryAfterMs:undefined,status:charts[key].length?'degraded':'missing',stale:true,retryable:true,
        error:current.error || (expectedMissing?'requested chart unavailable':'chart refresh incomplete'),failedAt:attemptAt};
    } else if(terminal&&out.slowFields[key]) {
      // Explicit absence is not a failed refresh and must not cause minute retries.
      out.slowFields[key]={...out.slowFields[key],retryable:false,error:undefined,failedAt:undefined,retryAt:undefined};
    }
  }
  if(Object.keys(charts).length){
    out.charts=charts;
    const incomplete=[...keys].filter(key=>out.slowFields[key]?.retryable);
    out.slowFields.charts=incomplete.length?{...info(next,'charts'),updatedAt:previous?.slowFields?.charts?.updatedAt??null,
      status:'degraded',stale:true,retryable:true,missingFields:incomplete,error:'requested charts incomplete',failedAt:attemptAt}:
      retained?{...info(previous,'charts'),stale:true,retryable:false,error:undefined,failedAt:undefined,retryAt:undefined,missingFields:undefined}:info(next,'charts');
  }
  return publishQuote(out);
}

export function createSnapshotService({ fetchBatch, enrich, now = Date.now, env = {}, sessionFor, streamAvailable = () => false, onUpdate=()=>{} } = {}) {
  const pollMs=boundedInt(env.POLL_MS,POLL_MS,1000,60000);
  const delayOf=value=>Math.max(pollMs,Math.min(86400000,Number(value)||pollMs));
  const openMs=boundedInt(env.ENRICH_OPEN_MS,ENRICH_MS,10000,300000);
  const closedMs=boundedInt(env.ENRICH_CLOSED_MS,900000,openMs,3600000);
  const breakMs=boundedInt(env.ENRICH_BREAK_MS,300000,openMs,900000);
  const active = new Map(), registeredAt = new Map(), snapshots = new Map(), rich = new Map(), enrichAt = new Map();
  const priceFallback = new Map();
  const initialFailures = new Map();
  const fallbackSnapshots = new WeakMap();
  const enriching = new Set();
  const enrichedSession=new Map(), enrichRetry=new Map();
  const closingRefresh=new Map(), lastSession=new Map();
  const groups = new Map(GROUPS.map(group => [group, { busy: false, nextAt: 0, failures: 0, calls: 0, blockedUntil: 0, attempted: new Set(), dueAt: new Map() }]));
  let running = false, generation = 0, timer = null, coldTimer = null;
  function drop(symbol) {
      active.delete(symbol); registeredAt.delete(symbol); snapshots.delete(symbol); rich.delete(symbol); enrichAt.delete(symbol);
      priceFallback.delete(symbol);
      initialFailures.delete(symbol);
      enrichedSession.delete(symbol);enrichRetry.delete(symbol);
      closingRefresh.delete(symbol);lastSession.delete(symbol);
      const state = groups.get(groupOf(symbol)); state?.attempted.delete(symbol); state?.dueAt.delete(symbol);
  }
  function prune() {for(const [symbol, at] of active)if(now()-at>=ACTIVE_TTL)drop(symbol);}
  function session(symbol) {
    const quote=snapshots.get(symbol) || rich.get(symbol);
    const current=sessionFor?.(symbol,quote);
    return current && current!=='UNKNOWN' ? current : quote?.marketState || 'UNKNOWN';
  }
  function cadence(symbol) {
    const state=session(symbol);
    return ['CLOSED','HOLIDAY'].includes(state)?closedMs:state==='BREAK'?breakMs:openMs;
  }
  function retryEnrichment(symbol,hint) {
    const failures=Math.min((enrichRetry.get(symbol)?.failures || 0)+1,30);
    const delay=Math.min(cadence(symbol),ENRICH_MS*2**(failures-1));
    const absolute=Number(hint?.retryAt),relative=Number(hint?.retryAfterMs);
    const notBefore=Math.max(Number.isFinite(absolute)?absolute:0,Number.isFinite(relative)&&relative>0?now()+relative:0);
    enrichRetry.set(symbol,{failures,retryAt:Math.max(now()+delay,notBefore),notBefore});
  }
  function enrichmentDueAt(symbol) {
    return enrichRetry.get(symbol)?.retryAt ?? (enrichAt.has(symbol)?enrichAt.get(symbol)+cadence(symbol):0);
  }
  function slowStatus(symbol,key,info) {
    const ageMs=Number.isFinite(Number(info.updatedAt))&&Number(info.updatedAt)>0?Math.max(0,now()-Number(info.updatedAt)):null;
    const maxAgeMs=key==='fx'?Math.max(120000,openMs*2):Math.max(cadence(symbol)*2,['daily30','week52Range'].includes(key)?600000:0);
    const expired=ageMs==null || ageMs>maxAgeMs;
    const refreshState=enriching.has(symbol)?'refreshing':now()>=enrichmentDueAt(symbol)?'queued':'idle';
    return {...info,ageMs,maxAgeMs,expired:terminalField(info)?false:expired,refreshState,...(info.retryable&&enrichRetry.has(symbol)?{retryAt:enrichRetry.get(symbol).retryAt}:{}),stale:!!info.stale||(!terminalField(info)&&expired)};
  }
  function stale(symbol, reason) {
    const old = snapshots.get(symbol);
    const fallback=priceFallback.get(symbol);
    // Failed batch attempts never renew this successful source-check window.
    if(fallback && now()-fallback.checkedAt<cadence(symbol) && quoteTime(fallback.quote)>=quoteTime(old)) {
      const snapshot=publishQuote(fallback.quote);
      fallbackSnapshots.set(snapshot,fallback.checkedAt);
      snapshots.set(symbol,snapshot);
    }
    else if (old) snapshots.set(symbol, { ...old, stale: true, staleInfo: { reason } });
  }
  function enrichmentFailed(symbol, epoch, error, hint) {
    if (!running || epoch !== generation || !active.has(symbol)) return;
    priceFallback.delete(symbol);
    retryEnrichment(symbol,hint);
    if(!groupOf(symbol))coldFailure(symbol,hint,enrichRetry.get(symbol)?.retryAt);
    const previous = rich.get(symbol);
    if (previous) {
      const fields = new Set(Object.keys(previous.slowFields || {}));
      if (previous.charts) {
        fields.add('charts');
        for (const key of Object.keys(previous.charts)) fields.add(key);
      }
      if (validWeek52Range(previous.week52High, previous.week52Low).week52High != null) fields.add('week52Range');
      if (previous.fxMap || previous.fxAsOf != null || previous.currency2cny != null) fields.add('fx');
      const slowFields = Object.fromEntries([...fields].map(key => {
        const info = previous.slowFields?.[key] || {
          source: previous.src || 'unknown',
          updatedAt: key === 'fx' ? previous.fxAsOf ?? null : previous.fetchedAt ?? null,
        };
        return [key, { ...info, stale: true, error, failedAt: now(),retryable:!terminalField(info) }];
      }));
      // Retain data and successful timestamps. Only the failed enrichment's
      // metadata changes; a separate batch provider can still be healthy.
      rich.set(symbol, { ...previous, slowFields, ...(fields.has('fx') ? { fxStale: true } : {}) });
    }
    if (!groupOf(symbol)) stale(symbol, 'quote unavailable');
  }
  function coldFailure(symbol,error,retryAt) {
    if(!active.has(symbol)||snapshots.has(symbol))return;
    const limited=Number(error?.status||error?.statusCode)===429||error?.code==='RATE_LIMITED';
    const identityIssue=['NAVER_NO_DATA','NAVER_IDENTITY_CONFLICT','NAVER_QUOTE_UNUSABLE'].includes(error?.code)?error.code:null;
    initialFailures.set(symbol,{symbol,pending:false,...catalogIdentity(symbol),price:null,code:limited?'RATE_LIMITED':identityIssue||'SOURCE_UNAVAILABLE',
      error:limited?'行情来源限流，等待重试':identityIssue?'Naver 行情身份或数据暂不可用，等待重试':'行情来源暂不可用，等待重试',failedAt:now(),retryAt:Math.max(now()+pollMs,Number(retryAt)||now()+60000)});
    onUpdate(symbol);
  }
  // Every price writer shares membership, identity and ordering checks. A
  // manual request never owns a subscription after its caller removes it.
  function commitSnapshot(symbol,quote,epoch,{manual=false}={}) {
    if(!running||epoch!==generation||!active.has(symbol))return 'removed';
    if(quote?.symbol!==symbol||!usable(quote)||manual&&(quote.stale||quote.staleInfo||quote.recovery))return 'unavailable';
    const old=snapshots.get(symbol),currentAt=quoteTime(old),nextAt=quoteTime(quote);
    if(nextAt<currentAt||nextAt===currentAt&&Number(quote.sourceCheckedAt||0)<Number(old?.sourceCheckedAt||0))return 'older';
    const snapshot=publishQuote(mergeTradingStatistics(quote,old,{now:now()}));
    snapshots.set(symbol,snapshot);initialFailures.delete(symbol);
    if(manual)priceFallback.set(symbol,{quote:snapshot,checkedAt:now()});
    onUpdate(symbol);return nextAt>currentAt?'updated':'unchanged';
  }
  async function refreshGroup(group, symbols, epoch) {
    const state = groups.get(group);
    const startedAt=now();
    state.busy = true; state.calls++;
    for (const symbol of symbols) state.attempted.add(symbol);
    try {
      const result = await fetchBatch(symbols, { group });
      if (!running || epoch !== generation) return;
      const quotes = new Map((result?.quotes || []).filter(q => q?.symbol && symbols.includes(q.symbol)).map(q => [q.symbol, q]));
      let successes = 0;
      for (const symbol of symbols) {
        if (!active.has(symbol)) continue;
        const quote = quotes.get(symbol);
        if (!usable(quote)) { stale(symbol, quote?.code || 'snapshot unavailable'); continue; }
        const outcome=commitSnapshot(symbol,quote,epoch);
        if(outcome==='updated'||outcome==='unchanged')successes++;
      }
      state.failures = successes ? 0 : Math.min(state.failures + 1, 7);
      const backoff = successes ? pollMs : Math.min(120000, pollMs * 2 ** state.failures);
      const due = startedAt + Math.max(backoff, delayOf(result?.pollAfterMs));
      for (const symbol of symbols) if (active.has(symbol)) {
        const quote=quotes.get(symbol);
        // A per-symbol provider interval must not inherit the slowest sibling.
        const hint=quote?.pollAfterMs ?? result?.pollAfterMs;
        // Batch adapters with their own TTL provide the actual next deadline.
        // A cached read must not add another full poll interval to that deadline.
        const sourceDue=result?.nextPollAtBySymbol?.[symbol];
        const nextDue=usable(quote)&&Number.isFinite(sourceDue)&&sourceDue>=startedAt?
          sourceDue:startedAt+Math.max(backoff,delayOf(hint));
        const sessionDelay=['CLOSED','HOLIDAY'].includes(session(symbol))?60000:session(symbol)==='BREAK'?30000:0;
        state.dueAt.set(symbol,Math.max(nextDue,startedAt+sessionDelay));
        if(!usable(quote)){
          const issue=result?.identityIssues?.[symbol];
          coldFailure(symbol,issue?{code:typeof issue==='string'?issue:issue.code}:quote,state.dueAt.get(symbol));
        }
      }
      state.blockedUntil = successes ? 0 : due;
      state.nextAt = state.dueAt.size ? Math.min(...state.dueAt.values()) : due;
    } catch (error) {
      if (!running || epoch !== generation) return;
      state.failures = Math.min(state.failures + 1, 7);
      state.blockedUntil = Math.max(Number(error?.retryAt)||0,now() + Math.max(Math.min(120000, pollMs * 2 ** state.failures), delayOf(error?.retryAfterMs)));
      for (const symbol of symbols) if (active.has(symbol)) state.dueAt.set(symbol, state.blockedUntil);
      state.nextAt = state.blockedUntil;
      for (const symbol of symbols) stale(symbol, Number(error?.status || error?.statusCode) === 429 ? 'rate-limited' : 'snapshot unavailable');
      for (const symbol of symbols)coldFailure(symbol,error,state.blockedUntil);
    } finally { state.busy = false; }
  }
  function enrichAvailable(epoch) {
    if (typeof enrich !== 'function') return;
    for (const symbol of [...active.keys()].sort((a,b) => (enrichAt.get(a) ?? -Infinity) - (enrichAt.get(b) ?? -Infinity))) {
      if (enriching.size >= ENRICH_LIMIT) break;
      if(env.POLL_MS&&!snapshots.has(symbol)&&groups.get(groupOf(symbol))?.busy)continue;
      const currentSession=session(symbol);
      const resumed=['CLOSED','HOLIDAY','BREAK'].includes(enrichedSession.get(symbol)) && !['CLOSED','HOLIDAY','BREAK'].includes(currentSession);
      const justClosed=['REGULAR','PRE','POST','AUCTION'].includes(enrichedSession.get(symbol))&&currentSession==='CLOSED';
      if (enriching.has(symbol) || now()<(enrichRetry.get(symbol)?.notBefore || 0) || (!resumed && !justClosed && now()<enrichmentDueAt(symbol))) continue;
      if(justClosed)closingRefresh.set(symbol,now());
      else if(currentSession!=='CLOSED')closingRefresh.delete(symbol);
      enriching.add(symbol); enrichAt.set(symbol, now());
      enrichedSession.set(symbol,currentSession);
      // Keep a slot until the actual work settles, even across stop/restart.
      // A hung legacy request cannot cause an ever-growing replacement queue.
      Promise.resolve().then(() => enrich(symbol,snapshots.get(symbol))).then(quote => {
        if (!running || epoch !== generation || !active.has(symbol)) return;
        if (!usable(quote)) { enrichmentFailed(symbol, epoch, 'enrichment unavailable',quote); return; }
        if (quote.symbol !== symbol) { enrichmentFailed(symbol, epoch, 'enrichment identity mismatch'); return; }
        if (quote.stale || quote.staleInfo || quote.pending || quote.recovery) {
          // A provider may resolve with its last good cache after failure. It is
          // useful on a cold start, but cannot count as successful enrichment.
          if (!rich.has(symbol)) rich.set(symbol, mergeEnrichment(null, quote,now()));
          if (!snapshots.has(symbol)) snapshots.set(symbol, publishQuote(quote));
          enrichmentFailed(symbol, epoch, 'enrichment returned stale data',quote);
          return;
        }
        let merged=mergeEnrichment(rich.get(symbol),quote,now());
        const closingAt=closingRefresh.get(symbol),checkedAt=Number(quote.sourceCheckedAt??quote.fetchedAt);
        const closingPending=closingAt!=null && (quote.marketState!=='CLOSED'||!Number.isFinite(checkedAt)||checkedAt<closingAt);
        if(closingAt!=null&&!closingPending)closingRefresh.delete(symbol);
        const observation=intradayObservationStatus({...merged,quoteAt:Math.max(quoteTime(quote),quoteTime(snapshots.get(symbol)))},{now:now(),feedDelayMinutes:quote.feedDelayMinutes,cadenceMs:openMs});
        if((observation.dataStale||closingPending) && merged.slowFields?.intraday&&!terminalField(merged.slowFields.intraday)){
          merged={...merged,slowFields:{...merged.slowFields,intraday:{...merged.slowFields.intraday,...observation,stale:true,retryable:true,error:closingPending?'closing refresh awaiting source check':'intraday observation behind latest quote'}}};
        }
        rich.set(symbol,merged);onUpdate(symbol);
        initialFailures.delete(symbol);
        priceFallback.set(symbol,{quote,checkedAt:now()});
        const incomplete=['charts','intraday','daily30'].map(key=>merged.slowFields?.[key]).filter(field=>field?.retryable);
        if(incomplete.length){
          const retryAt=Math.max(Number(quote.retryAt)||0,...incomplete.map(field=>Number(field.retryAt)||0));
          retryEnrichment(symbol,{retryAt,retryAfterMs:quote.retryAfterMs});
        }else enrichRetry.delete(symbol);
        const current=snapshots.get(symbol);
        if (!current || ((groupOf(symbol) === null || current.stale || current.staleInfo || fallbackSnapshots.has(current)) && quoteTime(quote) >= quoteTime(current))) {
          const snapshot=publishQuote(quote);
          if(groupOf(symbol)!==null)fallbackSnapshots.set(snapshot,now());
          snapshots.set(symbol,snapshot);
        }
      }).catch(error => { enrichmentFailed(symbol, epoch, 'enrichment failed',error); }).finally(() => { enriching.delete(symbol); });
    }
  }
  function tick() {
    if (!running) return;
    prune();
    const epoch = generation, tickAt=now();
    for(const symbol of active.keys()){
      const current=session(symbol),previous=lastSession.get(symbol);
      if(['CLOSED','HOLIDAY','BREAK'].includes(previous)&&['REGULAR','PRE','POST','AUCTION'].includes(current)){
        // Resume immediately at the opening bell; source/429 gates still apply.
        const state=groups.get(groupOf(symbol));state?.dueAt.set(symbol,tickAt);
      }
      lastSession.set(symbol,current);
    }
    for (const group of GROUPS) {
      const state = groups.get(group);
      if (state.busy || tickAt < state.blockedUntil) continue;
      const symbols = [...active.keys()].filter(symbol => groupOf(symbol) === group && !streamAvailable(symbol) &&
        (!state.attempted.has(symbol) || tickAt >= (state.dueAt.get(symbol) || 0)));
      if (symbols.length) void refreshGroup(group, symbols, epoch);
    }
    enrichAvailable(epoch);
  }
  function getCachedQuote(value) {
    const symbol = String(value || '').trim().toUpperCase();
    prune();
    if (!active.has(symbol) && active.size >= MAX_SYMBOLS) return { symbol, error: '活跃证券数量达到上限', code: 'CAPACITY_EXCEEDED' };
    const isNew = !active.has(symbol);
    if (isNew) registeredAt.set(symbol,now());
    active.set(symbol, now());
    if (running && isNew && !coldTimer) coldTimer = setTimeout(() => { coldTimer = null; tick(); }, 100);
    const quote = snapshots.get(symbol);
    if (!quote) return initialFailures.get(symbol) || { symbol,...catalogIdentity(symbol),price:null,error: '等待首次报价', code: 'PENDING', pending: true };
    const extra = rich.get(symbol);
    const out = { ...quote };
    // Provider cooldowns can outlast Yahoo's check cadence: expire on reads,
    // without touching a newer successful batch snapshot.
    if(fallbackSnapshots.has(quote) && (!priceFallback.has(symbol) || now()-fallbackSnapshots.get(quote)>=cadence(symbol))) {
      out.stale=true;out.staleInfo={reason:'enrichment price expired or unavailable'};
    }
    out.nextMarketTransitionAt=nextMarketTransitionAt(symbol,now(),out);
    out.sessionStartedAt=marketSessionStartedAt(symbol,now(),out);
    // Application cadence differs from a provider's polling hint. This does
    // not advance any successful-check timestamp when work is due or blocked.
    if (groupOf(symbol) === null) out.checkIntervalMs = cadence(symbol);
    // Enrichment may supply only slow fields, never its old price/session/time.
    for (const key of ['charts', 'regularChart', 'fxMap', 'fxAsOf', 'fxStale', 'currency2cny']) {
      if (extra?.[key] != null) out[key] = extra[key];
    }
    for (const key of ['displayName', 'exchangeName', 'instrumentType', 'market', 'calendarCoverage']) {
      if ((!out[key] || out[key] === '其他' || out[key] === 'UNKNOWN') && extra?.[key]) out[key] = extra[key];
    }
    out.displayName=quoteDisplayName(symbol,out.displayName);
    const typeRank={inferred:0,symbol:1,provider:2,catalog:3};
    if((typeRank[extra?.instrumentTypeSource]||0)>(typeRank[out.instrumentTypeSource]||0)) {
      out.instrumentType=extra.instrumentType;out.instrumentTypeSource=extra.instrumentTypeSource;
    }
    const range = validWeek52Range(out.week52High,out.week52Low);
    out.week52High=range.week52High;out.week52Low=range.week52Low;
    // Non-batch snapshots originate in enrichment itself: a valid retained
    // numeric range must still age. Do not override a fresh batch provider's
    // own range/metadata with the slower enrichment source.
    if(groupOf(symbol)===null && out.slowFields?.week52Range) out.slowFields={...out.slowFields,week52Range:slowStatus(symbol,'week52Range',out.slowFields.week52Range)};
    if (extra?.symbol === symbol) {
      const extraRange=validWeek52Range(extra.week52High,extra.week52Low);
      if (range.week52High == null && extraRange.week52High != null) {
        Object.assign(out,extraRange);
        const info=extra.slowFields?.week52Range || {source:extra.src || 'unknown',updatedAt:extra.fetchedAt || null};
        out.slowFields={...out.slowFields,week52Range:slowStatus(symbol,'week52Range',{...info,stale:!!extra.stale || !!info.stale})};
      }
      for (const key of ['charts','daily30','intraday','fx']) if (extra.slowFields?.[key]) out.slowFields={...out.slowFields,[key]:slowStatus(symbol,key,extra.slowFields[key])};
      if(out.slowFields?.fx?.stale) out.fxStale=true;
    }
    if(out.slowFields?.intraday&&!terminalField(out.slowFields.intraday)){
      const observation=intradayObservationStatus(out,{now:now(),feedDelayMinutes:extra?.feedDelayMinutes,cadenceMs:openMs});
      out.slowFields={...out.slowFields,intraday:{...out.slowFields.intraday,...observation,stale:out.slowFields.intraday.stale||!!observation.dataStale}};
    }
    const families=['intraday','daily30'].map(key=>out.slowFields?.[key]);
    if(out.slowFields?.charts && families.every(Boolean)){
      out.slowFields={...out.slowFields,charts:{...out.slowFields.charts,stale:families.some(meta=>meta.stale),expired:families.some(meta=>meta.expired)}};
    }
    if(out.regularChart){
      const target=regularChartTarget(symbol,now()),changed=target.targetDate&&target.targetDate!==out.regularChart.targetDate;
      // Alternate chart providers own their confirmation clock. Expiring the
      // primary intraday feed must not expire a newer alternate chart.
      const checked=out.regularChart.sourceCheckedAt;
      const chartStale=!!out.regularChart.stale||!Number.isFinite(checked)||checked<=0||now()-checked>Math.max(60000,cadence(symbol)*2);
      out.regularChart={...out.regularChart,
        ...(chartStale?{stale:true,status:out.regularChart.bars?.length?'partial':'unavailable',missingReason:'CHART_SOURCE_STALE'}:{}),
        ...(changed?{status:'partial',targetDate:target.targetDate,missingReason:'TARGET_DAY_HISTORY_PENDING',
          recentSessions:recentRegularSessions(symbol,target.targetDate,5)}:{}),
        previousCloseReference:chartPreviousClose(out,out.regularChart.tradeDate)};
    }
    Object.assign(out,intradayLiveFields(out,{now:now(),historyCurrency:extra?.currency}));
    return out;
  }
  function start() {
    if (running) return;
    running = true; generation++;
    timer = setInterval(tick, env.POLL_MS?Math.min(100,pollMs):POLL_MS);
    coldTimer = setTimeout(() => { coldTimer = null; tick(); }, 100);
  }
  function stop() {
    running = false; generation++;
    clearInterval(timer); clearTimeout(coldTimer); timer = null; coldTimer = null;
    for(const symbol of active.keys())drop(symbol);
    snapshots.clear();priceFallback.clear();rich.clear();
    for(const state of groups.values()){state.attempted.clear();state.dueAt.clear();}
  }
  async function forceRefresh(symbols) {
    if(!running)throw Object.assign(new Error('Snapshot service stopped'),{code:'STOPPED'});
    const requested=[...new Set(symbols)];
    const epoch=generation,outcomes={};
    for(const symbol of requested){const value=getCachedQuote(symbol);if(value?.code==='CAPACITY_EXCEEDED')outcomes[symbol]='capacity-exceeded';}
    const batches=GROUPS.map(group=>[group,requested.filter(symbol=>active.has(symbol)&&groupOf(symbol)===group)]).filter(([,list])=>list.length);
    for(const symbol of requested)if(groupOf(symbol)===null)outcomes[symbol]='unsupported';
    await Promise.all(batches.map(async ([group,list])=>{
      try {
        const result=await fetchBatch(list,{group,force:true});
        if(!running||epoch!==generation)return;
        const rows=new Map((result?.quotes||[]).filter(q=>q?.symbol&&list.includes(q.symbol)).map(q=>[q.symbol,q]));
        for(const symbol of list){
          const outcome=commitSnapshot(symbol,rows.get(symbol),epoch,{manual:true});outcomes[symbol]=outcome;
          if(outcome!=='updated'&&outcome!=='unchanged')continue;
          const due=Number(result?.nextPollAtBySymbol?.[symbol]);
          if(Number.isFinite(due)&&due>now())groups.get(group)?.dueAt.set(symbol,due);
        }
      }catch{for(const symbol of list)outcomes[symbol]='unavailable';}
    }));
    return {checkedAt:now(),outcomes};
  }
  function diagnostics() {
    const waiting=[...active.keys()].filter(s=>!enriching.has(s)).map(s=>({symbol:s,waitMs:Math.max(0,now()-(enrichAt.get(s) ?? registeredAt.get(s)))}));
    return { enrichmentPolicy:{openMs,closedMs,breakMs},enrichmentRetries:Object.fromEntries(enrichRetry), oldestEnrichmentWaitMs:Math.max(0,...waiting.map(x=>x.waitMs)), pendingEnrichment:waiting.filter(x=>!enrichAt.has(x.symbol)).length, providerCapabilities:Object.fromEntries([...active.keys()].map(s=>[s,providerCapabilities(s)])), running, active: active.size, snapshots: snapshots.size, enriching: enriching.size,
      groups: Object.fromEntries([...groups].map(([key, value]) => [key, { busy: value.busy, nextAt: value.nextAt, failures: value.failures, calls: value.calls, blockedUntil: value.blockedUntil, attempted: value.attempted.size }])) };
  }
  function retain(symbols){const keep=new Set(symbols);for(const s of active.keys())if(!keep.has(s))drop(s);}
  return { getCachedQuote, forceRefresh, start, stop, diagnostics, retain };
}
