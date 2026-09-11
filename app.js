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
import {createMacroContext,macroIndexQuote} from './lib/macro-context.js';
import {createMacroService} from './lib/macro.js';
import {createSearchService,ALIAS,ALIAS_SYM,IDX_NAME} from './lib/search.js';
import {classifyMarket} from './lib/instruments.js';
import {calendarCoverageStatus,marketStateFor} from './mkt.mjs';
import {createHttp} from './lib/http.js';
import {createReferenceFx} from './lib/providers/reference-fx.js';
import {createOfficialFeeds,MACRO_OFFICIAL_FEEDS} from './lib/providers/official-feeds.js';
import {createFxService} from './lib/fx-service.js';
import {createRecoveryStore} from './lib/recovery-store.js';
import {createRedundancy} from './lib/redundancy.js';
import {createPublicHistory} from './lib/providers/public-history.js';
import {createHistorySource} from './lib/history-source.js';
import {createHistoryService} from './lib/history-service.js';
import {createAlpacaProvider} from './lib/providers/alpaca-stream.js';
import {createFinnhubProvider} from './lib/providers/finnhub-stream.js';
import {createStreamPair} from './lib/stream-pair.js';
import {createRealtimeQuoteService} from './lib/realtime-quote-service.js';

export function createApplication({env={},now=()=>Date.now(),telemetry:providedTelemetry,transport:providedTransport,upstream=null,providerOverrides={}}={}) {
  const config=loadConfig(env);env=config;
  const gate=createHostGate({now,baseMs:config.Y429_BASE,capMs:config.Y429_CAP});
  const telemetry=providedTelemetry || createTelemetry({now,logger:createLogger({env,now})});
  const transport=providedTransport || createTransport({env:{...env,...config},now,upstream,gate,log:telemetry.log,countUpstream:telemetry.countUpstream});
  const {httpsGet}=transport,slowMap=new Map();
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
  const fetchHistory=createHistorySource({primary:providerOverrides.fetchChart || yahoo.fetchChart,sina:sina.getSinaDaily,naver:providerOverrides.fetchChart?null:naverHistory,alternative:providerOverrides.fetchChart?null:createPublicHistory({httpsGet,now}),now});
  const history=createHistoryService({fetchChart:fetchHistory,now,cacheTtl:60000,maxConcurrent:2,deadlineMs:25000});
  const futures=createFuturesProvider({httpsGet,fetchChart:providerOverrides.fetchChart||yahoo.fetchChart,now});
  const koreanSearch=createKoreanSearch({httpsGet,now});
  const search=createSearchService({httpsGet,now,yGated:yahoo.yGated});
  const news=createNewsService({httpsGet,yahooNews,eastmoneyNews:em.eastmoneyNews,now,log:telemetry.log,ttl:config.NEWS_TTL,failureCooldown:config.NEWS_FAILURE_COOLDOWN,maxEntries:config.NEWS_MAX_ENTRIES,maxActive:config.NEWS_MAX_ACTIVE});
  const redundancyEnabled=env.PUBLIC_SOURCE_REDUNDANCY==='1';
  const referenceFx=redundancyEnabled?createReferenceFx({httpsGet,now}):null;
  const fx=referenceFx?createFxService({getPrimary:yahoo.getFxRates,primaryMetadata:yahoo.fxMetadata,getReference:referenceFx.getRates,canUsePrimary:()=>env.FX_MODE==='market'&&!breaker.state().blocked,referenceOnly:env.FX_MODE!=='market',now}):null;
  const officialNews=redundancyEnabled?createOfficialFeeds({httpsGet,now,log:telemetry.log,feeds:MACRO_OFFICIAL_FEEDS}):undefined;
  const macroCalendar=createMacroCalendar({httpsGet,key:config.TE_API_KEY,now});
  const macroContext=createMacroContext({now,readQuote:providerOverrides.macroQuote||(async symbol=>isFutureSymbol(symbol)?futures.getQuote(symbol):macroIndexQuote(await yahoo.fetchChart(symbol,'?interval=5m&range=1d'),symbol,now()))});
  const macro=createMacroService({httpsGet,yahooNews,googleNewsTopic:news.googleNewsTopic,officialNews,allowYahooFallback:false,now,log:telemetry.log});
  const providerFns={...yahoo,...tx,...nasdaq,...fx,...providerOverrides};
  let quote;
  const providers=Object.freeze({...providerFns,cnSnapshot:(...args)=>quote.cnSnapshot(...args)});
  quote=createQuoteService({now,log:telemetry.log,...yahoo,...tx,...nasdaq,...em,...fx,extSessions,providers});
  const cacheMs=config.CACHE_MS,upstreamTimeout=config.UPSTREAM_TIMEOUT;
  const quoteCache=createQuoteCache({...quote,now,cacheSet,fetchQuote:providerOverrides.fetchQuote || quote.fetchQuote,breaker,cacheMs,quoteMaxAge:config.QUOTE_MAX_AGE,stats:telemetry.stats,log:telemetry.log});
  const batch=createBatchProvider({httpsGet,now,pollMs:config.POLL_MS});
  const polling=createFastPolling({httpsGet,legacy:batch,now,pollMs:config.POLL_MS,preferred:config.POLL_PRIMARY});
  const enrichCharts=createChartEnricher({fetchChart:fetchHistory,fallback:quoteCache.getCachedQuote,tx,now,includeDaily:false});
  let realtimeProvider,engine;
  const snapshots=env.REALTIME_SNAPSHOTS==='1'?createSnapshotService({env,streamAvailable:symbol=>{const d=realtimeProvider?.read(symbol);return d?.state==='streaming'&&!!d.trade;},sessionFor:(symbol,q)=>marketStateFor(symbol,null,now(),q||''),fetchBatch:providerOverrides.fetchSnapshotBatch || polling.fetchSnapshotBatch,enrich:enrichCharts,onUpdate:symbol=>engine?.poke(symbol),now}):null;
  const baseGetQuote=snapshots?snapshots.getCachedQuote:quoteCache.getCachedQuote;
  const recovery=redundancyEnabled?createRecoveryStore({filePath:env.RECOVERY_PATH,now,log:telemetry.log}):null;
  const redundancy=fx?createRedundancy({getQuote:baseGetQuote,fx,recovery,now}):null;
  let accepting=true;
  const selectedGetQuote=redundancy?redundancy.getCachedQuote:baseGetQuote;
  const alpaca=env.ALPACA_ENABLED==='1'?(providerOverrides.alpacaProvider||createAlpacaProvider({env,now,httpsGet})):null;
  const finnhub=env.FINNHUB_TOKEN?(providerOverrides.finnhubProvider||createFinnhubProvider({token:env.FINNHUB_TOKEN,now})):null;
  realtimeProvider=alpaca&&finnhub?createStreamPair(alpaca,finnhub):alpaca||finnhub;
  const realtime=realtimeProvider?createRealtimeQuoteService({provider:realtimeProvider,fallback:selectedGetQuote,now}):null;
  const servingGetQuote=realtime?realtime.getCachedQuote:selectedGetQuote;
  const readSourceQuote=(...args)=>accepting?(isFutureSymbol(args[0])?futures.getQuote(args[0]):servingGetQuote(...args)):Promise.reject(Object.assign(new Error('Application stopped'),{code:'STOPPED'}));
  engine=createQuoteEngine({readQuote:readSourceQuote,now,onMembership:list=>{snapshots?.retain(list.filter(s=>!isFutureSymbol(s)));realtimeProvider?.retain?.(list.filter(s=>!isFutureSymbol(s)));}});
  realtimeProvider?.subscribe?.(symbol=>engine.poke(symbol));
  const getCachedQuote=symbol=>engine.read([symbol])[0];
  function cacheSizes(){return {macroContext:macroContext.snapshot(),futures:futures.diagnostics(),hosts:gate.diagnostics(),engine:engine.diagnostics(),quote:quote.cacheMap.size,slow:slowMap.size,news:news.newsCache.size,search:search.searchCache.size,sina:sina.sinaCache.size,macro:macro.macroCache.size,cnSnap:quote.cnSnapCache.size,activeSyms:news.activeSyms.size,static:httpLayer.staticCache.size,failAt:quote.failAt.size,sinaFailAt:sina.sinaFailAt.size,yahoo429Ms:Math.max(0,breaker.state().until-now()),usSnap:tx.usSnapCache.size,realtime:snapshots?.diagnostics(),alpaca:realtime?.diagnostics(),redundancy:redundancy?.diagnostics(),referenceFx:referenceFx?.diagnostics(),officialNews:officialNews?.diagnostics(),calendar:calendarCoverageStatus(now())};}
  const httpLayer=createHttp({getCachedQuote,getMacro:macro.getMacro,getMacroContext:()=>({...macroContext.requestContext(),calendar:macroCalendar.requestCalendar()}),cacheSizes,requestNews:news.requestNews,activateNews:news.activateNews,yahooSearch:search.yahooSearch,tencentSuggest:search.tencentSuggest,koreanSearch,futuresSearch:futures.search,classifyMarket,ALIAS,ALIAS_SYM,IDX_NAME,cacheMs,upstreamTimeout,history,engine,sourceHealth:()=>({polling:polling.diagnostics(),hosts:gate.diagnostics(),stream:realtime?.diagnostics()||{enabled:false,status:'website-polling'}})},{env,telemetry,now,monitorCore:false});
  let started=false,reporterTimer=null,stopping=null;
  function start(){if(stopping)throw new Error('Application stop in progress');if(started)return httpLayer.httpServer;accepting=true;transport.reopen?.();yahoo.reopen();auth.reopen();history.reopen();futures.reopen();macroContext.reopen();macroCalendar.reopen();quoteCache.reopen();for(const service of [tx,nasdaq,sina,quote])service.reopen();started=true;news.startNews();redundancy?.start();snapshots?.start();realtime?.start();engine.start();httpLayer.startListen();telemetry.log.info('[topology]',{mode:'single-user',delivery:'sse',snapshots:!!snapshots,alpaca:!!alpaca,finnhub:!!finnhub,fx:config.FX_MODE,recovery:!!recovery});reporterTimer=telemetry.startStatsReporter(cacheSizes);return httpLayer.httpServer;}
  function stop(){
    if(stopping)return stopping;
    const wasStarted=started;started=false;accepting=false;
    engine.stop();news.stopNews();realtime?.stop();snapshots?.stop();auth.close();history.close();futures.close();macroContext.close();macroCalendar.close();quoteCache.close();for(const service of [tx,nasdaq,sina,quote])service.close();
    clearInterval(reporterTimer);reporterTimer=null;
    // Reject/cancel upstream work before waiting for HTTP handlers to finish.
    const gatewayClosed=yahoo.close(),transportClosed=transport.close();
    stopping=(async()=>{await Promise.all([gatewayClosed,transportClosed]);if(wasStarted)await httpLayer.stop();await redundancy?.stop();})().finally(()=>{stopping=null;});
    return stopping;
  }

  function resetState(){yahoo.resetYahooState();tx.resetTxState();macro.resetMacro();macroContext.clear();macroCalendar.clear();sina.resetSina();auth.reset();breaker.reset();for(const map of [quote.cacheMap,quote.inflight,quoteCache.fallbackInflight,quote.failAt,slowMap,news.newsCache,search.searchCache,quote.cnSnapCache,news.activeSyms,tx.usSnapCache])map.clear();}
  const services={macroCalendar,macroContext,futures,engine,gate,transport,yahoo,history,auth,breaker,quote,quoteCache,news,macro,search,tx,nasdaq,sina,em,batch,polling,snapshots,fx,referenceFx,officialNews,recovery,redundancy,realtime,http:httpLayer};
  const test={rawHttpsGet:transport.rawHttpsGet,activeSyms:news.activeSyms,newsCache:news.newsCache,UA,txParseLine,TX_FIELDS,decodeGbkSmart,resetState,seedCrumb:auth.seed,
    yahoo429:{state:()=>({...breaker.state(),crumbFailUntil:auth.state().crumbFailUntil}),expire:()=>{breaker.expire();auth.resetFailure();quote.failAt.clear();},backoffMs:failCooldownMs}};
  return {start,stop,httpServer:httpLayer.httpServer,services,telemetry,cacheSizes,getCachedQuote,__test:test};
}
