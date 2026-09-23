import {createAdvancedMarketData} from './lib/providers/advanced-market-data.js';
import {createMarketContextService} from './lib/market-context-service.js';
import {createFinancialSources} from './lib/providers/financial-sources.js';
import {createFundamentalsService} from './lib/fundamentals-service.js';
import {streamAvailability} from './lib/stream-policy.js';
import {refreshIndexSession} from './lib/session-policy.js';
import {createMacroMonitor} from './lib/macro-monitor.js';
import {createMacroNotifier} from './lib/macro-notify.js';
import {createMacroQuoteReader} from './lib/providers/macro-quotes.js';
import {createPublicMacroSources} from './lib/providers/macro-public-quotes.js';
import {createFuturesProvider} from './lib/providers/futures.js';
import {isFutureSymbol} from './lib/futures-instruments.js';
// Composition root. Every application owns its transport, queues, caches,
// breaker and background lifecycle; construction does not start network work.
import {createTelemetry,createLogger} from './log.mjs';
import {createTransport,UA} from './lib/transport.js';
import {cacheSet} from './lib/cache.js';
import {extSessions} from './lib/sessions.js';
import {createTencentProvider,txParseLine,TX_FIELDS,decodeGbkSmart} from './lib/providers/tx.js';
import {createNasdaqProvider} from './lib/providers/nasdaq.js';
import {createSinaProvider} from './lib/providers/sina.js';
import {createEastmoneyProvider} from './lib/providers/em.js';
import {createFastPolling} from './lib/providers/fast-polling.js';
import {createNaverIndexProvider} from './lib/providers/naver-index.js';
import {createNaverHistory} from './lib/providers/naver-history.js';
import {createKoreanSearch} from './lib/providers/korean-search.js';
import {createChartEnricher} from './lib/chart-enricher.js';
import {createBatchProvider} from './lib/providers/batch-snapshot.js';
import {createYahooService} from './lib/yahoo.js';
import {createYahooAuth} from './lib/yahoo-auth.js';
import {createHostGate} from './lib/host-gate.js';
import {createQuoteEngine} from './lib/quote-engine.js';
import {loadConfig} from './config.js';
import {createYahooNews} from './lib/yahoo-news.js';
import {createQuoteService} from './lib/quote.js';
import {createQuoteCache,failCooldownMs} from './lib/quote-cache.js';
import {createSnapshotService} from './lib/snapshot-service.js';
import {createNewsService,NEWS_TTL,parseGoogleRss} from './lib/news.js';
import {createMacroCalendar} from './lib/providers/macro-calendar.js';
import {createMacroContext} from './lib/macro-context.js';
import {createMacroService} from './lib/macro.js';
import {createSearchService,ALIAS,ALIAS_SYM,IDX_NAME} from './lib/search.js';
import {classifyMarket} from './lib/instruments.js';
import {calendarCoverageStatus,marketStateFor} from './mkt.mjs';
import {createHttp} from './lib/http.js';
import {createTradeTape} from './lib/trade-tape.js';
import {createChartDetailService} from './lib/chart-detail-service.js';
import {createReferenceFx} from './lib/providers/reference-fx.js';
import {createOfficialFeeds,MACRO_OFFICIAL_FEEDS} from './lib/providers/official-feeds.js';
import {createFxService} from './lib/fx-service.js';
import {createRecoveryStore} from './lib/recovery-store.js';
import {createRedundancy} from './lib/redundancy.js';
import {createPublicHistory} from './lib/providers/public-history.js';
import {createHistorySource} from './lib/history-source.js';
import {createHistoryService} from './lib/history-service.js';
import {createHistoryPrewarm} from './lib/history-prewarm.js';
import {createAlpacaProvider} from './lib/providers/alpaca-stream.js';
import {createFinnhubProvider} from './lib/providers/finnhub-stream.js';
import {createFinnhubRestPool,parseFinnhubTokens} from './lib/providers/finnhub-rest.js';
import {createFinnhubHistory} from './lib/providers/finnhub-history.js';
import {createNaverWorldHistory} from './lib/providers/naver-world-history.js';
import {createFinnhubQuotes} from './lib/providers/finnhub-quotes.js';
import {createStreamPair} from './lib/stream-pair.js';
import {createRealtimeQuoteService} from './lib/realtime-quote-service.js';
import {createQuoteSamples} from './lib/quote-samples.js';

export function createApplication({env={},now=()=>Date.now(),telemetry:providedTelemetry,transport:providedTransport,upstream=null,providerOverrides={}}={}) {
  const config=loadConfig(env);env=config;
  const gate=createHostGate({now,baseMs:config.Y429_BASE,capMs:config.Y429_CAP,maxQueued:config.HOST_QUEUE_MAX,deadlineMs:config.HOST_DEADLINE_MS});
  const telemetry=providedTelemetry || createTelemetry({now,logger:createLogger({env,now})});
  const transport=providedTransport || createTransport({env:{...env,...config},now,upstream,gate,log:telemetry.log,countUpstream:telemetry.countUpstream});
  const {httpsGet}=transport,slowMap=new Map();
  const finnhubTokens=parseFinnhubTokens(config.FINNHUB_TOKEN,config.FINNHUB_TOKENS);
  const finnhubRest=finnhubTokens.length?createFinnhubRestPool({httpsGet,tokens:finnhubTokens,now}):null;
  const finnhubHistory=finnhubRest?createFinnhubHistory({request:finnhubRest.request,now}):null;
  const finnhubQuotes=finnhubRest?createFinnhubQuotes({request:finnhubRest.request,now}):null;
  let batch;
  const providerOptions={httpsGet,slowMap,now,log:telemetry.log,slowTtl:config.SLOW_TTL};
  const tx=createTencentProvider(providerOptions),nasdaq=createNasdaqProvider(providerOptions),sina=createSinaProvider(providerOptions),em=createEastmoneyProvider(providerOptions);
  const breaker=gate.yahooPolicy;
  // Auth and the Yahoo gateway have a narrow mutual relationship. Credential
  // callbacks close over this instance, never a module registry.
  let auth;
  const yahoo=createYahooService({...providerOptions,env:{Y_TASK_DEADLINE:config.Y_TASK_DEADLINE},breaker,fxFailureCooldown:config.FX_FAILURE_COOLDOWN,getCrumb:()=>auth.getCrumb(),clearCrumb:()=>auth.clearCrumb(),yahoo429Hit:breaker.hit,clear429Streak:breaker.clearStreak,getSinaDaily:sina.getSinaDaily});
  auth=createYahooAuth({httpsGet,now,ttl:config.AUTH_TTL,failureCooldown:config.AUTH_FAILURE_COOLDOWN,yGated:yahoo.yGated,onRateLimit:breaker.hit});
  const yahooNews=createYahooNews({httpsGet,yGated:yahoo.yGated,getCrumb:auth.getCrumb,onRateLimit:breaker.hit});
  const naverHistory=createNaverHistory({httpsGet,now});
  const indexProvider=createNaverIndexProvider({httpsGet,now});
  const worldHistory=providerOverrides.fetchChart?null:createNaverWorldHistory({httpsGet,resolveCode:(...args)=>batch.resolveNaverCode(...args),now});
  const fetchHistory=createHistorySource({index:providerOverrides.fetchChart?null:indexProvider.fetchChart,
    primary:providerOverrides.fetchChart || yahoo.fetchChart,sina:sina.getSinaDaily,
    naver:providerOverrides.fetchChart?null:naverHistory,
    alternative:providerOverrides.fetchChart?null:createPublicHistory({httpsGet,now}),
    finnhub:providerOverrides.fetchChart?null:finnhubHistory,world:worldHistory,now});
  const history=createHistoryService({fetchChart:fetchHistory,now,cacheTtl:60000,maxEntries:config.HISTORY_MAX_SYMBOLS,maxConcurrent:config.HISTORY_MAX_ACTIVE,maxQueued:config.HISTORY_MAX_QUEUE,deadlineMs:config.HISTORY_EXECUTION_DEADLINE_MS,totalDeadlineMs:config.HISTORY_TOTAL_DEADLINE_MS,maxBytes:config.HISTORY_MAX_BYTES});
  const historyPrewarm=createHistoryPrewarm({history,now,enabled:config.HISTORY_BACKGROUND_ENABLED==='1',statePath:config.HISTORY_STATE_PATH,refreshMs:config.HISTORY_REFRESH_MS,maxSymbols:config.HISTORY_MAX_SYMBOLS,expandAfterMs:config.HISTORY_EXPAND_AFTER_MS,canExpand:()=>Object.values(gate.diagnostics()).every(s=>!s.queued),log:telemetry.log});
  const futures=createFuturesProvider({httpsGet,fetchChart:providerOverrides.fetchChart||yahoo.fetchChart,now});
  const koreanSearch=createKoreanSearch({httpsGet,now});
  const search=createSearchService({httpsGet,now,yGated:yahoo.yGated,finnhubRequest:finnhubRest?.request});
  const news=createNewsService({httpsGet,yahooNews,eastmoneyNews:em.eastmoneyNews,newsLoader:providerOverrides.newsLoader,now,log:telemetry.log,ttl:config.NEWS_TTL,failureCooldown:config.NEWS_FAILURE_COOLDOWN,maxEntries:config.NEWS_MAX_ENTRIES,maxActive:config.NEWS_MAX_ACTIVE});
  const redundancyEnabled=env.PUBLIC_SOURCE_REDUNDANCY==='1';
  const referenceFx=redundancyEnabled?createReferenceFx({httpsGet,now}):null;
  const fx=referenceFx?createFxService({getPrimary:yahoo.getFxRates,primaryMetadata:yahoo.fxMetadata,getReference:referenceFx.getRates,canUsePrimary:()=>env.FX_MODE==='market'&&!breaker.state().blocked,referenceOnly:env.FX_MODE!=='market',now}):null;
  const officialNews=redundancyEnabled?createOfficialFeeds({httpsGet,now,log:telemetry.log,feeds:MACRO_OFFICIAL_FEEDS}):undefined;
  const macroCalendar=createMacroCalendar({httpsGet,key:config.TE_API_KEY,now});
  const macroQuotes=createMacroQuoteReader({httpsGet,futures,fetchChart:yahoo.fetchChart,now,publicSources:createPublicMacroSources({httpsGet,now})});
  const macroContext=createMacroContext({now,pollMs:config.MACRO_CONTEXT_MS,readQuote:providerOverrides.macroQuote||macroQuotes.readQuote});
  const macro=createMacroService({httpsGet,yahooNews,googleNewsTopic:news.googleNewsTopic,officialNews,allowYahooFallback:false,now,log:telemetry.log});
  const macroMonitor=createMacroMonitor({macro,context:macroContext,calendar:macroCalendar,now,enabled:config.MACRO_BACKGROUND_ENABLED==='1',statePath:config.MACRO_STATE_PATH,contextMs:config.MACRO_CONTEXT_MS,newsMs:config.MACRO_NEWS_MS,notify:providerOverrides.macroNotify||createMacroNotifier({url:config.MACRO_WEBHOOK_URL,token:config.MACRO_WEBHOOK_TOKEN,now}),log:telemetry.log});
  const providerFns={...yahoo,...tx,...nasdaq,...fx,...providerOverrides};
  let quote;
  const providers=Object.freeze({...providerFns,cnSnapshot:(...args)=>quote.cnSnapshot(...args)});
  quote=createQuoteService({now,log:telemetry.log,...yahoo,...tx,...nasdaq,...em,...fx,extSessions,providers});
  const cacheMs=config.CACHE_MS,upstreamTimeout=config.UPSTREAM_TIMEOUT;
  const quoteCache=createQuoteCache({...quote,now,cacheSet,fetchQuote:providerOverrides.fetchQuote || quote.fetchQuote,breaker,cacheMs,quoteMaxAge:config.QUOTE_MAX_AGE,stats:telemetry.stats,log:telemetry.log});
  batch=createBatchProvider({httpsGet,now,indexProvider,fallbackQuote:quoteCache.getCachedQuote,pollMs:config.POLL_MS});
  const polling=createFastPolling({httpsGet,legacy:batch,finnhubQuotes:providerOverrides.fetchSnapshotBatch?null:finnhubQuotes,
    now,pollMs:config.POLL_MS,preferred:config.POLL_PRIMARY});
  const enrichCharts=createChartEnricher({fetchChart:fetchHistory,fetchHistoricalChart:fetchHistory,
    fallback:quoteCache.getCachedQuote,tx,now,includeDaily:false});
  let realtimeProvider,engine;
  const fundamentals=createFundamentalsService({...(providerOverrides.fetchFundamentals?{fetchFundamentals:providerOverrides.fetchFundamentals}:{sources:createFinancialSources({httpsGet,batch,fetchYahooSummary:yahoo.fetchQuoteSummary,finnhubRequest:finnhubRest?.request,now,statementTtlMs:config.FUNDAMENTALS_TTL_MS})}),now,
    enabled:config.FUNDAMENTALS_ENABLED==='1',ttlMs:config.FUNDAMENTALS_TTL_MS,retryMs:config.FUNDAMENTALS_RETRY_MS,maxAgeMs:config.FUNDAMENTALS_MAX_AGE_MS,onUpdate:symbol=>engine?.poke(symbol)});
  const snapshots=env.REALTIME_SNAPSHOTS==='1'?createSnapshotService({env,streamAvailable:symbol=>{const d=realtimeProvider?.read(symbol);return !streamAvailability(symbol,d,now()).needsBackup;},sessionFor:(symbol,q)=>marketStateFor(symbol,null,now(),q||''),fetchBatch:providerOverrides.fetchSnapshotBatch || polling.fetchSnapshotBatch,enrich:enrichCharts,onUpdate:symbol=>engine?.poke(symbol),now}):null;
  const baseGetQuote=snapshots?snapshots.getCachedQuote:quoteCache.getCachedQuote;
  const recovery=redundancyEnabled?createRecoveryStore({filePath:env.RECOVERY_PATH,maxBytes:config.RECOVERY_MAX_BYTES,now,log:telemetry.log}):null;
  const redundancy=fx?createRedundancy({getQuote:baseGetQuote,fx,recovery,now}):null;
  let accepting=true;
  const selectedGetQuote=redundancy?redundancy.getCachedQuote:baseGetQuote;
  const tradeTape=createTradeTape({now});
  const alpaca=env.ALPACA_ENABLED==='1'?(providerOverrides.alpacaProvider||createAlpacaProvider({env,now,httpsGet,
    onTrade:event=>tradeTape.record(event),onTradeInvalidation:event=>tradeTape.invalidate(event)})):null;
  const finnhubToken=env.FINNHUB_TOKEN||finnhubTokens[0]||'';
  const finnhub=finnhubToken?(providerOverrides.finnhubProvider||createFinnhubProvider({token:finnhubToken,maxSymbols:config.FINNHUB_MAX_SYMBOLS,now,onTrade:event=>tradeTape.record(event)})):null;
  realtimeProvider=alpaca&&finnhub?createStreamPair(alpaca,finnhub,{now}):alpaca||finnhub;
  const realtime=realtimeProvider?createRealtimeQuoteService({provider:realtimeProvider,fallback:selectedGetQuote,now,onUpdate:symbol=>engine?.poke(symbol)}):null;
  const servingGetQuote=realtime?realtime.getCachedQuote:selectedGetQuote;
  const readSourceQuote=async (...args)=>{
    if(!accepting)throw Object.assign(new Error('Application stopped'),{code:'STOPPED'});
    const value=await (isFutureSymbol(args[0])?futures.getQuote(args[0]):servingGetQuote(...args));
    return refreshIndexSession(value,now());
  };
  engine=createQuoteEngine({readQuote:readSourceQuote,decorateQuote:fundamentals.decorate,now,onMembership:list=>{fundamentals.retain(list);tradeTape.retain(list.filter(s=>!isFutureSymbol(s)));snapshots?.retain(list.filter(s=>!isFutureSymbol(s)));realtimeProvider?.retain?.(list.filter(s=>!isFutureSymbol(s)));}});
  realtimeProvider?.subscribe?.(symbol=>engine.poke(symbol));
  const getCachedQuote=symbol=>engine.read([symbol])[0];
  async function forceRefreshQuotes(symbols){
    if(!snapshots)throw Object.assign(new Error('Source refresh unavailable'),{code:'SOURCE_REFRESH_UNAVAILABLE'});
    const checked=await snapshots.forceRefresh(symbols);
    await realtime?.refreshFallback(symbols);
    return {...checked,quotes:await engine.refreshNow(symbols)};
  }
  const samples=createQuoteSamples({engine,getWatchlist:()=>historyPrewarm.status().persistentWatchlist,now,directory:config.SAMPLES_STATE_PATH,enabled:config.SAMPLES_BACKGROUND_ENABLED==='1',maxBytes:config.SAMPLES_MAX_BYTES});
  const advancedMarketData=providerOverrides.advancedMarketData||createAdvancedMarketData({httpsGet,fetchChart:fetchHistory,
    fetchActionsChart:yahoo.fetchChart,apiKey:config.APCA_API_KEY_ID,apiSecret:config.APCA_API_SECRET_KEY,feed:config.ALPACA_FEED,now});
  const chartDetail=createChartDetailService({readQuote:symbol=>engine.read([symbol],{lease:false})[0],
    fetchChart:fetchHistory,advanced:advancedMarketData,tape:realtimeProvider?tradeTape:null,
    streamState:symbol=>{const state=realtimeProvider?.read(symbol);return {state:state?.state||'unavailable',
      healthy:state?.connectionHealthy===true,source:state?.source||null,
      checkedAt:state?.connectionCheckedAt||null,errorCode:state?.errorCode||null};},now});
  const marketContext=createMarketContextService({engine,history,samples,news,macro:macroMonitor,advanced:advancedMarketData,now});
  function cacheSizes(){return {advancedMarketData:advancedMarketData.diagnostics?.()||null,marketContext:marketContext.diagnostics(),fundamentals:fundamentals.diagnostics(),finnhubRest:finnhubRest?.diagnostics()||{enabled:false,tokenCount:0},samples:samples.diagnostics(),budget:{cacheBytes:config.CACHE_BUDGET_BYTES,historyBytes:config.HISTORY_MAX_BYTES,recoveryBytes:config.RECOVERY_MAX_BYTES,sseBytes:config.SSE_MAX_BUFFER_BYTES,sampleBytes:config.SAMPLES_MAX_BYTES,totalReservedBytes:config.CACHE_BUDGET_BYTES+config.SAMPLES_MAX_BYTES,scope:"cache reservations plus independent sample store, not a process heap limit"},history:history.diagnostics(),historyPrewarm:historyPrewarm.status(),macroMonitor:macroMonitor.status(),macroSources:macroQuotes.diagnostics(),macroContext:macroContext.snapshot(),futures:futures.diagnostics(),hosts:gate.diagnostics(),engine:engine.diagnostics(),quote:quote.cacheMap.size,slow:slowMap.size,news:news.newsCache.size,search:search.searchCache.size,sina:sina.sinaCache.size,macro:macro.macroCache.size,cnSnap:quote.cnSnapCache.size,activeSyms:news.activeSyms.size,static:httpLayer.staticCache.size,failAt:quote.failAt.size,sinaFailAt:sina.sinaFailAt.size,yahoo429Ms:Math.max(0,breaker.state().until-now()),usSnap:tx.usSnapCache.size,realtime:snapshots?.diagnostics(),alpaca:realtime?.diagnostics(),redundancy:redundancy?.diagnostics(),referenceFx:referenceFx?.diagnostics(),officialNews:officialNews?.diagnostics(),calendar:calendarCoverageStatus(now())};}
  const httpLayer=createHttp({advancedMarketData,marketContext,chartDetail,samples,getCachedQuote,forceRefreshQuotes,macroMonitor,getMacro:()=>config.MACRO_BACKGROUND_ENABLED==='1'?macroMonitor.snapshot().news:macro.getMacro(),getMacroContext:()=>config.MACRO_BACKGROUND_ENABLED==='1'?macroMonitor.snapshot().context:({...macroContext.requestContext(),calendar:macroCalendar.requestCalendar()}),cacheSizes,requestNews:news.requestNews,activateNews:news.activateNews,finnhubSearch:search.finnhubSearch,yahooSearch:search.yahooSearch,tencentSuggest:search.tencentSuggest,koreanSearch,futuresSearch:futures.search,classifyMarket,ALIAS,ALIAS_SYM,IDX_NAME,cacheMs,upstreamTimeout,history,historyPrewarm,engine,sourceHealth:()=>({fundamentals:fundamentals.diagnostics(),finnhubRest:finnhubRest?.diagnostics()||{enabled:false,tokenCount:0},polling:polling.diagnostics(),hosts:gate.diagnostics(),stream:realtime?.diagnostics()||{enabled:false,status:'website-polling'}})},{env,telemetry,now,monitorCore:false});
  let started=false,reporterTimer=null,stopping=null,samplesInit=null;
  function start(){if(stopping)throw new Error('Application stop in progress');if(started)return httpLayer.httpServer;accepting=true;advancedMarketData.reopen?.();marketContext.reopen();transport.reopen?.();batch.reopen();indexProvider.reopen();yahoo.reopen();auth.reopen();fetchHistory.reopen?.();history.reopen();futures.reopen();macroQuotes.reopen();macroContext.reopen();macroCalendar.reopen();quoteCache.reopen();for(const service of [tx,nasdaq,sina,quote])service.reopen();started=true;fundamentals.start();news.startNews();redundancy?.start();snapshots?.start();realtime?.start();engine.start();samplesInit=historyPrewarm.start().then(()=>{if(accepting)return samples.start();});void macroMonitor.start();httpLayer.startListen();telemetry.log.info('[topology]',{mode:'single-user',delivery:'sse',macroBackground:config.MACRO_BACKGROUND_ENABLED==='1',snapshots:!!snapshots,alpaca:!!alpaca,finnhub:!!finnhub,fx:config.FX_MODE,recovery:!!recovery});reporterTimer=telemetry.startStatsReporter(cacheSizes);return httpLayer.httpServer;}
  function stop(){
    if(stopping)return stopping;
    const wasStarted=started;started=false;accepting=false;
    advancedMarketData.close?.();marketContext.close();
    const samplesStopped=samples.stop();
    const macroStopped=macroMonitor.stop();
    const historyStopped=historyPrewarm.stop();
    batch.close();indexProvider.close();fundamentals.stop();engine.stop();polling.reset();news.stopNews();realtime?.stop();snapshots?.stop();auth.close();fetchHistory.close?.();history.close();futures.close();macroQuotes.close();macroContext.close();macroCalendar.close();quoteCache.close();for(const service of [tx,nasdaq,sina,quote])service.close();
    clearInterval(reporterTimer);reporterTimer=null;telemetry.stopStatsReporter?.();
    // Reject/cancel upstream work before waiting for HTTP handlers to finish.
    const gatewayClosed=yahoo.close(),transportClosed=transport.close();
    stopping=(async()=>{await Promise.all([gatewayClosed,transportClosed,macroStopped,historyStopped,samplesInit,samplesStopped]);if(wasStarted)await httpLayer.stop();await redundancy?.stop();await telemetry.log.flush?.();})().finally(()=>{stopping=null;});
    return stopping;
  }

  function resetState(){fundamentals.clear();yahoo.resetYahooState();tx.resetTxState();macro.resetMacro();macroMonitor.clear();macroContext.clear();macroCalendar.clear();sina.resetSina();auth.reset();breaker.reset();for(const map of [quote.cacheMap,quote.inflight,quoteCache.fallbackInflight,quote.failAt,slowMap,news.newsCache,search.searchCache,quote.cnSnapCache,news.activeSyms,tx.usSnapCache])map.clear();}
  const services={advancedMarketData,marketContext,indexProvider,fundamentals,samples,historyPrewarm,macroMonitor,macroQuotes,macroCalendar,macroContext,futures,engine,gate,transport,yahoo,history,auth,breaker,quote,quoteCache,news,macro,search,tx,nasdaq,sina,em,batch,polling,snapshots,fx,referenceFx,officialNews,recovery,redundancy,realtime,http:httpLayer};
  const test={rawHttpsGet:transport.rawHttpsGet,activeSyms:news.activeSyms,newsCache:news.newsCache,UA,txParseLine,TX_FIELDS,decodeGbkSmart,resetState,seedCrumb:auth.seed,
    yahoo429:{state:()=>({...breaker.state(),crumbFailUntil:auth.state().crumbFailUntil}),expire:()=>{breaker.expire();auth.resetFailure();quote.failAt.clear();},backoffMs:failCooldownMs}};
  return {start,stop,httpServer:httpLayer.httpServer,services,telemetry,cacheSizes,getCachedQuote,__test:test};
}
