import {barsFrom as parseChartBars} from './chart-bars.js';
import { volumeNumber, publishQuote } from './quote-contract.js';
import { currencyToCny } from './currency.js';
import { yahooDelayInfo } from './providers/yahoo-delay.js';
import { priceSessionFor } from './sessions.js';
import {previousCloseFromDailyBars} from './previous-close-reference.js';
import { classifyMarket, instrumentTypeFor, instrumentMeta, validWeek52Range } from './instruments.js';
export { classifyMarket, instrumentTypeFor } from './instruments.js';
import { marketStateFor, timezoneOffsetFor, marketCalendarCoverage } from '../mkt.mjs';
import { log as defaultLog } from '../log.mjs';
import { cacheSet as boundedCacheSet } from './cache.js';
export function createQuoteService({ log = defaultLog, now = () => Date.now(), barsFrom = parseChartBars, fxFallbackRates = () => ({}), fxMetadata = () => ({fxAsOf:null,fxStale:true}), txDailyBarsCn, txMinuteBarsCn, txQuoteSnapshot, usSnapshot, emQuoteSnapshot, getNasdaqDaily, cacheSet = boundedCacheSet, extSessions, providers = {} } = {}) {
  let closed=false,generation=0;
  const ensure=owner=>{if(closed||owner!==generation)throw Object.assign(new Error('Quote service stopped'),{code:'STOPPED'});};
  // lib/quote.js — 报价组装: Yahoo 富数据 fetchQuote + 腾讯备源降级 fallbackQuote + 市场分类

  // A股实时快照: 主源腾讯行情(qt.gtimg.cn, 秒级实时), 备源东财push2(部分出口IP被302反爬)
  // 成功30s缓存 / 失败60s负缓存。此前仅push2单源且被墙 → A股指数全天冻结在Yahoo滞后价(ts落后17h+)
  const cnSnapCache = new Map();
  const finiteOrNull = x => x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null);

  async function cnSnapshot(symbol) {
    const owner=generation;ensure(owner);
    const s = String(symbol || '').toUpperCase();
    if (!/^(\d{6})\.(SS|SZ)$/.test(s)) return null;
    const c = cnSnapCache.get(s);
    if (c && now() - c.ts < (c.data ? 30000 : 60000)) return c.data;
    let out = null;
    try { const data = await txQuoteSnapshot(s); out = data ? { ...data, src: 'tx-cn' } : null; } catch (e) { log.debug('[tx snap fail]', { symbol: s, err: String(e && e.message || e) }); }
    ensure(owner);
    if (!out) { const data = await emQuoteSnapshot(s); out = data ? { ...data, src: 'em-cn' } : null; }
    ensure(owner);
    cacheSet(cnSnapCache, s, { data: out, ts: now() }, 100);
    if (!out) log.warn('[cn snap unavailable]', { symbol: s });
    return out;
  }

  // Yahoo 不可用时的降级报价(桥接: 不写 quote 主缓存, Yahoo 恢复即被富数据覆盖)
  async function usFallbackQuote(symbol) {
    return fallbackQuote(symbol);
  }
  // Yahoo 不可用时的降级报价(桥接: 不写 quote 主缓存, Yahoo 恢复即被富数据覆盖)
  // 按市场选快照源: A股→cnSnapshot(腾讯/东财), 美股→usSnapshot(腾讯), 其他→null(照旧 stale)
  async function fallbackQuote(symbol) {
    const owner=generation;ensure(owner);
    const symU = String(symbol || '').toUpperCase();
    if (/^\d{6}\.(SS|SZ)$/.test(symU)) {
      const cn = await cnSnapshot(symU);
      ensure(owner);
      if (!cn || cn.price == null) return null;
      const baseC = cn.prevClose != null ? cn.prevClose : null;
      const changeC = baseC != null ? cn.price - baseC : null;
      const intraCn = await txMinuteBarsCn(symU);                    // 分时: 腾讯全天分钟线
      ensure(owner);
      const dailyCn = await txDailyBarsCn(symU, 130);                // 日K: 腾讯取近130根, 全量下发(客户端按版本去重, v56 拉满)
      ensure(owner);
      log.info('[cn fallback]', { symbol: symU, price: cn.price });
      const cnType = instrumentTypeFor(symU);
      const cnMeta = instrumentMeta(symU);
      return publishQuote({
        symbol: symU, market: cnMeta.market, name: '', displayName: cnMeta.displayName, exchangeName: cnMeta.exchangeName, currency: 'CNY', gmtoff: 28800,
        ts: cn.ts || null, price: cn.price, prevClose: baseC, open: cn.open ?? null, dayHigh: cn.high ?? null, dayLow: cn.low ?? null,
        week52High: null, week52Low: null, volume: null,
        marketState: marketStateFor(symU,28800,now()), calendarCoverage: marketCalendarCoverage(symU,now()), change: changeC, changePct: baseC ? (changeC / baseC) * 100 : null, instrumentType: cnType,instrumentTypeSource:cnMeta.instrumentTypeSource,priceSession:'REGULAR',regularPrice:cn.price,ext: null,
        currency2cny: cnType === 'INDEX' ? null : 1, fxMap: null,
        charts: { intraday: intraCn, daily30: dailyCn.slice(-126) },
        daily30Version: dailyCn.length ? dailyCn[dailyCn.length - 1].t : 0,
        quoteAt: cn.ts || null, fetchedAt: now(), src: cn.src || 'tx-cn', fxAsOf: null, fxStale: false,
      });
    }
    const snap = await usSnapshot(symU);
    ensure(owner);
    if (!snap) return null;
    const code = snap.code || '';
    // 腾讯美股代码后缀: .OQ=纳交 .N=纽交 .AM=NYSE Arca .AQ/.PR/.WS 等; ^开头为指数
    const isUsCode = /\.(OQ|N|AM|AQ|PR|WS|GS|GJ|BG)$/.test(code);
    const market = /^\^/.test(symU) ? classifyMarket(symU, '', '', 'INDEX')
      : classifyMarket(symU, isUsCode ? 'NASDAQ' : '', '', '');
    const usMeta = instrumentMeta(symU, { name: snap.name || '', quoteType: snap.instrumentType || (/^\^/.test(symU) ? 'INDEX' : '') });
    const dailyUs = await getNasdaqDaily(symU);                      // 日K: Nasdaq historical(etf/stocks 自适应; 指数→空)
    const dailyBars = dailyUs.slice(-126);                           // v56: 30→126 拉满(客户端按版本去重)
    const dailyReference=previousCloseFromDailyBars(symU,snap.ts,dailyBars,'nasdaq-history');
    const base = dailyReference?.prevClose??null;
    const change = base != null ? snap.price - base : null;
    const changePct = base ? (change / base) * 100 : null;
    ensure(owner);
    log.info('[us fallback]', { symbol: symU, price: snap.price });
    return publishQuote({
      symbol: symU, market, name: snap.name || '', displayName: usMeta.displayName, exchangeName: usMeta.exchangeName, currency: snap.currency || 'USD', gmtoff: timezoneOffsetFor(symU),
      ts: snap.ts, price: snap.price, prevClose: base, ...dailyReference,open: snap.open, dayHigh: snap.dayHigh, dayLow: snap.dayLow,
      week52High: snap.week52High, week52Low: snap.week52Low, volume: snap.volume,
      marketState: marketStateFor(symU,null,now()), calendarCoverage: marketCalendarCoverage(symU,now()), change, changePct,instrumentType:usMeta.instrumentType,instrumentTypeSource:usMeta.instrumentTypeSource,priceSession:snap.priceSession ?? priceSessionFor(symU,snap.ts),regularPrice:(snap.priceSession ?? priceSessionFor(symU,snap.ts))==='REGULAR'?snap.price:null,ext:null,
      currency2cny: null, fxMap: null,
      charts: { intraday: [], daily30: dailyBars },                  // 美股分时暂无可用备源(腾讯仅当前1分钟)
      daily30Version: dailyBars.length ? dailyBars[dailyBars.length - 1].t : 0,
      fetchedAt: now(), src: 'tx-us', fxAsOf: null, fxStale: true,
    });
  }

  async function fetchQuote(symbol) {
    const owner=generation;ensure(owner);
    const _t0 = now();
    log.debug('[quote in]', { symbol });
    let intra = await providers.fetchChart(symbol, '?interval=5m&range=1d&includePrePost=true');   // Yahoo: 分时含盘前/盘后, 实时到当前分钟 + meta
    ensure(owner);
    const meta = intra.meta;
    if(meta?.symbol&&String(meta.symbol).toUpperCase()!==String(symbol).toUpperCase())throw new Error('Yahoo quote identity mismatch');
    const identity = instrumentMeta(meta.symbol || symbol, meta);
    const sessionContext={venue:identity.exchangeName,instrumentType:identity.instrumentType};
    let recoveredIntraday=false;
    const validPoint=(chart,i)=>Number.isFinite(chart.timestamp?.[i])&&chart.timestamp[i]>0&&chart.timestamp[i]*1000<=now()&&Number.isFinite(chart.indicators?.quote?.[0]?.close?.[i])&&chart.indicators.quote[0].close[i]>0;
    // Yahoo can roll its 1d window forward before the exchange opens. Make one
    // bounded request for genuine intraday history, retaining only its latest
    // populated exchange-local date. The original quote metadata stays intact.
    if(!(intra.timestamp||[]).some((_,i)=>validPoint(intra,i))){
      intra={...intra,timestamp:[],indicators:{...intra.indicators,quote:[{}]}};
      try{
        const history=await providers.fetchChart(symbol,'?interval=5m&range=5d&includePrePost=true');
        ensure(owner);
        if(!history.meta?.symbol||String(history.meta.symbol).toUpperCase()!==String(symbol).toUpperCase())throw new Error('Intraday history identity mismatch');
        const indices=(history.timestamp||[]).map((_,i)=>i).filter(i=>validPoint(history,i)).sort((a,b)=>history.timestamp[a]-history.timestamp[b]);
        const dateOf=i=>{
          const t=history.timestamp[i]*1000,offset=timezoneOffsetFor(symbol,t);
          return offset==null?null:new Date(t+offset*1000).toISOString().slice(0,10);
        };
        const latest=indices.length?dateOf(indices.at(-1)):null;
        const selected=latest?indices.filter(i=>dateOf(i)===latest):[];
        if(selected.length){
          const fields=Object.fromEntries(Object.entries(history.indicators.quote[0]).map(([key,value])=>[key,Array.isArray(value)?selected.map(i=>value[i]):value]));
          intra={...history,meta,timestamp:selected.map(i=>history.timestamp[i]),indicators:{...history.indicators,quote:[fields]}};
          recoveredIntraday=true;
        }
      }catch{ensure(owner);}
    }
    const tArr = intra.timestamp || [];
    const lastT = tArr.length ? tArr[tArr.length - 1] : null;
    const off0 = timezoneOffsetFor(symbol,lastT!=null?lastT*1000:now()) ?? meta.gmtoffset ?? 0;
    const dk = lastT != null ? new Date((lastT + off0) * 1000) : null;
    const todayKey = dk ? dk.getUTCFullYear() + '-' + dk.getUTCMonth() + '-' + dk.getUTCDate() : null;   // 最新bar的ET日期=今日
    // P1-P2: Yahoo日线也并入 allSettled 并行(此前在allSettled之后串行await, 白白多等一整段上游延迟)
    const [ohlc, fxs, ndDaily, ydSettled] = await Promise.allSettled([providers.getDayOhlc(symbol, todayKey), providers.getFxSnapshot?providers.getFxSnapshot(meta.currency):providers.getFxRates(meta.currency), providers.getNasdaqDaily(symbol), providers.getYahooDaily(symbol)]);
    ensure(owner);
    const o = ohlc.status === 'fulfilled' ? ohlc.value : { open: null, high: null, low: null, prevClose: null };
    const atomicFx=fxs.status==='fulfilled'&&providers.getFxSnapshot?fxs.value:null;
    const fxMap = atomicFx?atomicFx.rates:fxs.status === 'fulfilled' ? fxs.value : fxFallbackRates(meta.currency);
    const {rates:_rates,...fxInfo}=atomicFx||fxMetadata(meta.currency);
    const daily = ndDaily.status === 'fulfilled' ? ndDaily.value : [];
    // 分时: Yahoo 5m, 实时; 转成 {t,c,v} 供画价格线
    const tq = intra.timestamp || [], q = intra.indicators?.quote?.[0] || {};
    const line = [];
    for (let i = 0; i < tq.length; i++) if (q.close?.[i] != null) line.push({ t: tq[i], c: q.close[i], v: volumeNumber(q.volume?.[i]) });
    // 日K(近~5个月)
    const obars = barsFrom(intra);                     // 全量OHLC柱(含盘前/盘后)
    // 日K双源择新: Nasdaq历史接口常滞后一个交易日, 按最后一根日期取较新源; 同日取Yahoo(盘中实时更新当日柱)
    const ydDaily = (ydSettled.status === 'fulfilled' ? ydSettled.value : []).slice(-126);   // P1-P2: 取自allSettled结果(失败回空数组, 与原catch语义一致)
    const lastDateKey = (bars) => bars.length ? new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10) : '';
    let dailyBars, dailyInfo;
    const yahooNewer=!daily.length || (ydDaily.length && lastDateKey(ydDaily)>=lastDateKey(daily));
    if(yahooNewer){dailyBars=ydDaily;dailyInfo=providers.yahooDailyMetadata?.(symbol) || {source:'yahoo',updatedAt:now(),stale:ydSettled.status!=='fulfilled'};}
    else{dailyBars=daily;dailyInfo=providers.nasdaqDailyMetadata?.(symbol) || {source:'nasdaq',updatedAt:now(),stale:ndDaily.status!=='fulfilled'};}
    if (!dailyBars.length && /^\d{6}\.(SS|SZ)$/.test(symbol)) {dailyBars=await providers.txDailyBarsCn(symbol);dailyInfo={source:'tencent',updatedAt:now(),stale:!dailyBars.length};}
    dailyBars = dailyBars.slice(-126);   // A股: Nasdaq/Yahoo 皆空时腾讯兜底

    const open = o.open, high = o.high, low = o.low;
    const st = marketStateFor(symbol, null, now(), sessionContext);
    ensure(owner);
    const cnSnap = /^\d{6}\.(SS|SZ)$/.test(String(symbol).toUpperCase()) ? await providers.cnSnapshot(String(symbol).toUpperCase()) : null;   // A股实时快照(腾讯主源/东财备)
    const regular = meta.regularMarketPrice;
    const lastC = line.length ? line[line.length - 1].c : null;
    // 盘中用 meta 实时 tick; 盘前/盘后/休市用最新 bar 收盘价; A股竞价/午休优先东财快照
    const preferRegularMeta=st==='REGULAR'||(recoveredIntraday&&Number.isFinite(meta.regularMarketTime)&&meta.regularMarketTime>lastT);
    let price = preferRegularMeta ? (regular ?? lastC) : (lastC ?? regular);
    ensure(owner);
    if (cnSnap && cnSnap.price != null) {
      price = cnSnap.price;
    }
    // 昨收: 日期感知的日线值优先(Yahoo meta 的 previousClose/regularMarketTime 在盘前会冻结在昨日之前, 是陈旧值)
    let prevClose = o.prevClose ?? meta.previousClose ?? meta.chartPreviousClose ?? null;
    if (cnSnap && cnSnap.prevClose != null) prevClose = cnSnap.prevClose;   // A股: 快照昨收权威(Yahoo冻结)
    const prev = finiteOrNull(prevClose);
    price = finiteOrNull(price);
    const change = price != null && prev != null ? price - prev : null;
    const changePct = change != null && prev ? (change / prev) * 100 : null;
    // 盘前/盘后分段统计
    const ext = extSessions(obars, {...meta,gmtoffset:off0,instrumentType:identity.instrumentType}, prevClose);
    // 今日OHLC: 常规时段=日线值与盘中段合并(防日线滞后); 盘前=盘前实时值
    let openOut = open, highOut = high, lowOut = low, volOut = meta.regularMarketVolume ?? null;
    if (cnSnap && cnSnap.price != null) {
      openOut = cnSnap.open ?? null;
      highOut = cnSnap.high ?? null;
      lowOut = cnSnap.low ?? null;
      volOut = cnSnap.volume ?? null;
    } else if (st === 'REGULAR' && ext.reg && ext.reg.n > 0) {
      openOut = open ?? ext.reg.open;
      highOut = Math.max(high ?? -Infinity, ext.reg.high);
      lowOut = Math.min(low ?? Infinity, ext.reg.low);
    } else if (st === 'PRE' && ext.pre) {
      openOut = ext.preOpen ?? ext.pre.low;
      highOut = ext.pre.high; lowOut = ext.pre.low; volOut = ext.pre.volume;
    } else if (st === 'POST' && ext.post) {
      openOut = ext.post.open ?? openOut;
      highOut = ext.post.high; lowOut = ext.post.low; volOut = ext.post.volume;
    }
    if (st === 'UNKNOWN') { openOut = null; highOut = null; lowOut = null; volOut = null; }
    const ohlcConsistent = price == null || highOut == null || lowOut == null
      ? null : lowOut <= price && price <= highOut && (openOut == null || (lowOut <= openOut && openOut <= highOut));
    log.debug('[quote out]', { symbol, ms: now() - _t0, price, state: st });

    const instrumentType = identity.instrumentType;
    const quoteAtMeta = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null;
    const usingRegularMeta=(preferRegularMeta&&regular!=null)||lastC==null;
    const quoteAt=cnSnap?.ts || (usingRegularMeta?quoteAtMeta:lastT!=null?lastT*1000:null);
    const priceSession=cnSnap?'REGULAR':usingRegularMeta&&quoteAtMeta?'REGULAR':priceSessionFor(symbol,quoteAt,null,sessionContext);
    const dailyReference=previousCloseFromDailyBars(symbol,quoteAt,
      cnSnap?.price!=null?dailyBars:ydDaily.length?ydDaily:dailyBars,
      cnSnap?.price!=null?dailyInfo.source:ydDaily.length?'yahoo-daily':dailyInfo.source);
    return publishQuote({
      symbol: meta.symbol || symbol,
      market: identity.market,   // P1-Q1: 市场分类随行情返回(前端标签不再依赖搜索接口)
      name: identity.exchangeName,
      displayName: identity.displayName,
      exchangeName: identity.exchangeName,
      currency: meta.currency || 'USD',
      gmtoff: timezoneOffsetFor(meta.symbol || symbol,now()) ?? meta.gmtoffset ?? null,
      ts: quoteAt,
      quoteAt,priceSession,regularPrice:cnSnap?.price ?? finiteOrNull(meta.regularMarketPrice ?? ext.regClose),
      price, prevClose: dailyReference?.prevClose??prev, ...dailyReference,
      open: finiteOrNull(openOut), dayHigh: finiteOrNull(highOut), dayLow: finiteOrNull(lowOut),
      ...validWeek52Range(meta.fiftyTwoWeekHigh, meta.fiftyTwoWeekLow),
      volume: volOut,
      ohlcSession: cnSnap?.price != null ? 'CN_SNAPSHOT' : (st === 'PRE' || st === 'POST' || st === 'UNKNOWN' ? st : st === 'CLOSED' ? 'CACHED_REGULAR' : 'REGULAR'),
      ohlcConsistent,
      marketState: st, change, changePct,
      instrumentType,instrumentTypeSource:identity.instrumentTypeSource,
      calendarCoverage: marketCalendarCoverage(meta.symbol || symbol, now(),null,sessionContext),
      ...(cnSnap?.price!=null?{feedDelayMinutes:null,feedDelaySource:null}:yahooDelayInfo(symbol,meta,instrumentType)),
      ext,                                                // 盘前/盘后分段报价
      currency2cny: currencyToCny(meta.currency,fxMap,{index:instrumentType==='INDEX',fxStale:fxInfo.fxStale||fxs.status!=='fulfilled'}),
      fxMap,
      ...fxInfo,
      fxStale: fxInfo.fxStale || fxs.status !== 'fulfilled',
      charts: { intraday: line, daily30: dailyBars },    // 分时(Yahoo实时) + 日K(Nasdaq)
      daily30Version: dailyBars.length ? dailyBars[dailyBars.length - 1].t : 0,   // P1-P1: 日K版本(最新bar秒级ts), SLOW_TTL内不变 → 客户端据此复用daily30, 不必每2s重传/重处理
      slowFields: {week52Range:{source:'yahoo',updatedAt:now(),stale:false},intraday:{source:'yahoo',updatedAt:now(),stale:!line.length},daily30:dailyInfo,charts:{source:'yahoo/'+dailyInfo.source,updatedAt:dailyInfo.updatedAt,stale:dailyInfo.stale},fx:{source:'yahoo',updatedAt:fxInfo.fxAsOf,stale:fxInfo.fxStale || fxs.status!=='fulfilled'}},
      fetchedAt: now(), src: cnSnap?.price != null ? (cnSnap.src || 'tx-cn') : 'yahoo',
    });
  }

  // 报价主缓存/单飞/失败冷却(可变模块态唯一归属地; 组合根 getCachedQuote 经导入绑定读写)
  const cacheMap = new Map();
  const inflight = new Map();
  const failAt = new Map();                                 // 失败冷却: 上游故障时防每2s打爆(值: {at, n}, 冷却时长指数退避)
  return { close:()=>{closed=true;generation++;},reopen:()=>{closed=false;}, cnSnapCache, cnSnapshot, usFallbackQuote, fallbackQuote, fetchQuote, cacheMap, inflight, failAt };
}
