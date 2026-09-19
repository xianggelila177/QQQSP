import {providerRetryAt} from './provider-retry.js';
import { volumeNumber, publishQuote } from '../quote-contract.js';
import { priceSessionFor } from '../sessions.js';
import { txParseLine, decodeGbkSmart } from './tx.js';
import { marketStateFor, timezoneOffsetFor, marketCalendarCoverage } from '../../mkt.mjs';
import { instrumentTypeFor, instrumentMeta, classifyMarket, tencentCodeFor, validWeek52Range } from '../instruments.js';
import {catalogInstrumentFor} from '../market-registry.js';
import {tencentFinancials,tencentTurnoverAmount} from './quote-financials.js';
import {regularTradingStatistics} from '../trading-statistics.js';

export function createBatchProvider({ now = () => Date.now(), httpsGet, indexProvider, fallbackQuote, pollMs=2000 } = {}) {
  // Public batch snapshots. Honor provider pollingInterval/Retry-After; no key rotation.
  // Naver public website quotes are best effort, not a contracted exchange feed.

  const descriptors = new Map();
  const NAVER = 'https://polling.finance.naver.com/api/realtime';
  const KNOWN_NASDAQ = new Set(['QQQ','AAPL','NVDA','MSFT','INTC','TSLA','AMD','MU','QCOM','AVGO','AMZN','GOOG','GOOGL','META','ASML','ARM','SMCI','PLTR','COST','NFLX','ADBE']);
  // SPY uses its ETF route identifier without a Reuters exchange suffix (verified on Naver).
  const knownCode = symbol => {
    const item=catalogInstrumentFor(symbol),code=item?.naverCode;
    // Exact provider identifiers are catalog evidence, not an inferred suffix.
    if(item?.market==='us'&&typeof code==='string'&&/^[A-Z][A-Z0-9-]*(?:\.[ON])?$/.test(code))return code;
    return symbol === 'SPY' ? 'SPY' : KNOWN_NASDAQ.has(symbol) ? symbol+'.O' : null;
  };
  const number = value => value == null || value === '' ? null : (Number.isFinite(Number(String(value).replaceAll(',', ''))) ? Number(String(value).replaceAll(',', '')) : null);
  const timestamp = value => { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : null; };
  const interval = value => Math.max(1000, Math.min(86400000, number(value) ?? 10000));
  async function request(url, encoding = 'utf8', signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await httpsGet(url, { Referer: 'https://m.stock.naver.com/' }, { encoding, signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,timeout:3500 });
      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = providerRetryAt(response.headers,now(),60000)-now();
        throw Object.assign(new Error('provider rate limited'), {status:response.status,retryAfterMs});
      }
      if (response.status !== 200) throw Object.assign(new Error('snapshot HTTP '+response.status),{status:response.status});
      return response;
    } finally { clearTimeout(timer); }
  }
  function common(symbol, data) {
    return publishQuote({symbol, ...data, fetchedAt:now(), sourceCheckedAt:now(), calendarCoverage:marketCalendarCoverage(symbol,now()),
      gmtoff:timezoneOffsetFor(symbol,now()), fxMap:null, fxAsOf:null, fxStale:true});
  }
  function parseNaverQuote(row, symbol, pollAfterMs) {
    if (!row || (symbol.endsWith('.KS') || symbol.endsWith('.KQ') ? row.itemCode !== symbol.slice(0,6) : row.symbolCode !== symbol)) return null;
    const exchange = row.stockExchangeType || {};
    if (symbol.endsWith('.KS') && exchange.code !== 'KS' || symbol.endsWith('.KQ') && exchange.code !== 'KQ') return null;
    const regular = number(row.closePriceRaw ?? row.closePrice);
    const regularAt = timestamp(row.localTradedAt);
    if (!(regular > 0) || !regularAt || regularAt>now()+5000) return null;
    let change = number(row.compareToPreviousClosePriceRaw ?? row.compareToPreviousClosePrice);
    if (row.compareToPreviousPrice?.name === 'FALLING' && change != null) change = -Math.abs(change);
    const prevClose = change == null ? null : regular - change;
    const over = row.overMarketPriceInfo;
    const overAt = timestamp(over?.localTradedAt), overPrice = number(over?.overPrice);
    const useOver = overAt > regularAt && overPrice > 0 && ['PRE_MARKET','AFTER_MARKET'].includes(over?.tradingSessionType);
    // An untraded new-day row can carry the website's maintenance timestamp
    // with last close and blank statistics. It is not a new regular trade.
    const regularSession=priceSessionFor(symbol,regularAt);
    if(!/\.(KS|KQ)$/.test(symbol)&&!useOver&&regularSession!=='REGULAR')return null;
    const price = useOver ? overPrice : regular, quoteAt = useOver ? overAt : regularAt;
    const priceSession = useOver ? over.tradingSessionType === 'PRE_MARKET' ? 'PRE' : 'POST' : 'REGULAR';
    const marketState = marketStateFor(symbol,null,now());
    const instrumentType = instrumentTypeFor(symbol, row.instrumentType || row.quoteType || row.stockType || row.itemType);
    const open = number(row.openPriceRaw ?? row.openPrice), dayHigh = number(row.highPriceRaw ?? row.highPrice), dayLow = number(row.lowPriceRaw ?? row.lowPrice);
    const rawVolume=row.accumulatedTradingVolumeRaw ?? row.accumulatedTradingVolume;
    const volume=volumeNumber(typeof rawVolume==='string'?rawVolume.replaceAll(',',''):rawVolume);
    const marketCap=volumeNumber(row.marketValueFullRaw),currency=row.currencyType?.code||(/\.(KS|KQ)$/.test(symbol)?'KRW':'USD');
    const financials=instrumentType==='EQUITY'&&marketCap>0?{symbol,source:'naver-realtime',fetchedAt:now(),fields:{marketCap:{value:marketCap,status:'available',currency,unit:'money',asOf:null,source:'naver-realtime'}}}:null;
    const ext = useOver ? {[priceSession === 'PRE' ? 'pre' : 'post']:{price:overPrice,t:overAt/1000,change:overPrice-regular,changePct:(overPrice/regular-1)*100}} : null;
    return common(symbol, {price, quoteAt, ts:quoteAt, regularMarketPrice:regular, regularPrice:regular, regularQuoteAt:regularSession==='REGULAR'?regularAt:null, priceSession,
      prevClose,change:prevClose == null ? null : price-prevClose,changePct:prevClose ? (price/prevClose-1)*100 : null,
      open,dayHigh,dayLow,volume,volumeUnit:'shares',turnoverAmount:volumeNumber(row.accumulatedTradingValueRaw),financials,
      name:exchange.nameEng || '',displayName:row.stockName || symbol,exchangeName:exchange.nameEng || '',
      currency:row.currencyType?.code || (symbol.endsWith('.KS') || symbol.endsWith('.KQ') ? 'KRW':'USD'), instrumentType,instrumentTypeSource:instrumentMeta(symbol,{instrumentType:row.instrumentType || row.quoteType || row.stockType || row.itemType}).instrumentTypeSource,
      market:classifyMarket(symbol, exchange.code, exchange.nameEng,instrumentType),marketState,
      ohlcSession:'REGULAR',ohlcConsistent:!useOver && dayLow != null && dayHigh != null ? dayLow<=price && price<=dayHigh : false,
      src:/\.(KS|KQ)$/.test(symbol) ? 'naver-kr':'naver-us',feedDelayMinutes:number(exchange.delayTime),pollAfterMs,
      ext,week52High:null,week52Low:null,providerMarketState:row.marketStatus});
  }
  function wallTime(raw, symbol) {
    const digits = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
    const iso = digits ? `${digits[1]}-${digits[2]}-${digits[3]} ${digits[4]}:${digits[5]}:${digits[6]}` : raw;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(iso || '');
    if (!match) return null;
    const naive = Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5],+match[6]);
    return naive-timezoneOffsetFor(symbol,naive)*1000;
  }
  const tencentCode = tencentCodeFor;
  function parseTencentBatch(body, symbols) {
    const mapping=new Map(symbols.map(s=>[tencentCode(s),s]).filter(([code])=>code));
    const quotes=[];
    for (const [,code,line] of decodeGbkSmart(body).matchAll(/v_([A-Za-z0-9.\-]+)="([^"]*)"/g)) {
      const symbol=mapping.get(code); if(!symbol)continue;
      const p=txParseLine(line,/\.(SS|SZ)$/.test(symbol)?'cnQuote':'quote');const ts=wallTime(p.time,symbol);
      if (!(p.price>0)||!ts)continue;
      const typeHint=symbol.startsWith('^')?'INDEX':p.raw.includes('GP-ETF')||p.raw.includes('ETF')?'ETF':p.raw.includes('LOF')?'MUTUALFUND':'';
      const kind=instrumentTypeFor(symbol,typeHint);
      const cn=/\.(SS|SZ)$/.test(symbol),hk=/\.HK$/.test(symbol);
      if(cn&&p.code!==symbol.slice(0,6))continue;
      if(!cn&&!hk&&p.code!==symbol&&!p.code.startsWith(symbol+'.'))continue;
      const currency=cn?'CNY':hk?'HKD':'USD';
      const priceSession=cn?'REGULAR':priceSessionFor(symbol,ts);
      const quote=common(symbol,{price:p.price,quoteAt:ts,ts,priceSession,regularPrice:priceSession==='REGULAR'?p.price:null,prevClose:p.prevClose,change:p.prevClose == null?null:p.price-p.prevClose,
        changePct:p.prevClose ? (p.price/p.prevClose-1)*100:null,open:p.open,dayHigh:p.high,dayLow:p.low,volume:cn&&p.volume!=null?p.volume*100:p.volume,volumeUnit:'shares',
        turnoverAmount:tencentTurnoverAmount(p,symbol),financials:tencentFinancials(p,{symbol,instrumentType:kind,currency,quoteAt:ts,now:now()}),
        currency:cn?'CNY':hk?'HKD':'USD', name:'',displayName:p.name || symbol,exchangeName:cn?(symbol.endsWith('.SS')?'SSE':'SZSE'):hk?'HKEX':/\.OQ$/.test(p.code)?'NASDAQ':'US',
        market:classifyMarket(symbol,cn?'':'NASDAQ','',kind),marketState:marketStateFor(symbol,null,now()),instrumentType:kind,instrumentTypeSource:instrumentMeta(symbol,{quoteType:typeHint}).instrumentTypeSource,
        src:'tx-batch',feedDelayMinutes:null,pollAfterMs:marketStateFor(symbol,null,now())==='CLOSED'?70000:pollMs,
        ohlcSession:'REGULAR',ohlcConsistent:p.low != null && p.high != null && p.low<=p.price && p.price<=p.high,
        ext:null,...validWeek52Range(p.week52High,p.week52Low)});
      if(cn){
        const bids=[10,12,14,16,18].map(i=>volumeNumber(p.raw[i])),asks=[20,22,24,26,28].map(i=>volumeNumber(p.raw[i]));
        const stats=regularTradingStatistics(quote),buy=bids.reduce((a,b)=>a+(b||0),0),sell=asks.reduce((a,b)=>a+(b||0),0);
        if(stats&&[...bids,...asks].every(v=>v!=null)&&Number.isFinite(buy+sell)&&buy+sell>0)quote.tradingStats={...stats,orderImbalance:{value:(buy-sell)/(buy+sell)*100,asOf:ts,basis:'full-displayed-book',depth:5,calculated:true,formula:'(five-level bids - asks) / (bids + asks) * 100'}};
      }
      quotes.push(quote);
      if(!cn && /^[A-Z][A-Z0-9-]*\.OQ$/.test(p.code)) descriptors.set(symbol,{code:symbol+'.O',at:now()});
      if(!cn && /^[A-Z][A-Z0-9-]*\.N$/.test(p.code)) descriptors.set(symbol,{code:symbol+'.N',at:now()});
    }
    while(descriptors.size>200)descriptors.delete(descriptors.keys().next().value);
    return quotes;
  }
  async function tencent(symbols,{signal}={}) {
    const codes=symbols.map(tencentCode).filter(Boolean);
    if(!codes.length)return [];
    const result=await request('https://qt.gtimg.cn/q='+codes.join(','),'latin1',signal);
    return parseTencentBatch(result.body,symbols);
  }
  async function fetchSnapshotBatch(symbols,{group}={}) {
    const syms=[...new Set(symbols)].filter(s=>/^[A-Z0-9^][A-Z0-9^.\-]{0,15}$/.test(s)).slice(0,200);
    if(!syms.length)return {quotes:[],pollAfterMs:70000};
    if(group==='index') {
      if(!indexProvider)throw new Error('Index provider unavailable');
      let result,error;
      try{result=await indexProvider.fetchSnapshotBatch(syms);}
      catch(e){if(e.code==='STOPPED')throw e;error=e;}
      const quotes=new Map((result?.quotes||[]).map(q=>[q.symbol,q]));
      // Recover each failed index independently; a healthy sibling must retain
      // its own source cadence. The quote cache/gateway owns Yahoo cooldowns.
      if(fallbackQuote)for(const symbol of syms){
        if(!['^N225','^SOX'].includes(symbol)||quotes.get(symbol)?.price>0&&!quotes.get(symbol)?.error)continue;
        try{
          const q=await fallbackQuote(symbol),at=Number(q?.quoteAt??q?.ts),checked=Number(q?.sourceCheckedAt??q?.fetchedAt);
          if(q?.symbol===symbol&&q.instrumentType==='INDEX'&&q.currency===(symbol==='^N225'?'JPY':'USD')&&Number.isFinite(q.price)&&q.price>0&&
             !q.error&&!q.stale&&!q.staleInfo&&!q.recovery&&!q.pending&&at>0&&at<=now()+5000&&checked>0&&checked<=now()+5000&&now()-checked<=60000)
            quotes.set(symbol,{...q,checkIntervalMs:70000,pollAfterMs:70000});
        }catch{/* The primary still retries on its own schedule. */}
      }
      if(error&&![...quotes.values()].some(q=>q.price>0&&!q.error))throw error;
      return {quotes:[...quotes.values()],pollAfterMs:result?.pollAfterMs||70000,nextPollAtBySymbol:result?.nextPollAtBySymbol};
    }
    if(group==='other') {
      const quotes=await tencent(syms);
      return {quotes,pollAfterMs:quotes.length?Math.min(...quotes.map(q=>q.pollAfterMs)):60000};
    }
    if(group==='kr') {
      const result=await request(NAVER+'/domestic/stock/'+syms.filter(s=>/^\d{6}\.(KS|KQ)$/.test(s)).map(s=>s.slice(0,6)).join(','));
      const data=JSON.parse(result.body),pollAfterMs=interval(data.pollingInterval);
      const rows=new Map((data.datas||[]).map(r=>[r.itemCode,r]));
      return {quotes:syms.map(s=>parseNaverQuote(rows.get(s.slice(0,6)),s,pollAfterMs)).filter(Boolean),pollAfterMs};
    }
    // Resolve uncached Reuters identities from an existing batch quote source; never invent a security.
    const unknown=syms.filter(s=>!knownCode(s) && (!descriptors.has(s)||now()-descriptors.get(s).at>86400000));
    let fallback=[];
    if(unknown.length) {try{fallback=await tencent(unknown);}catch{/* Naver-known siblings can still refresh */}}
    const mapped=syms.map(s=>({symbol:s,code:knownCode(s)||descriptors.get(s)?.code})).filter(x=>x.code);
    let primary=[],pollAfterMs=2000,primaryError=null;
    if(mapped.length) {
      try {
        const response=await request(NAVER+'/worldstock/stock/'+mapped.map(x=>x.code).join(','));
        const data=JSON.parse(response.body);pollAfterMs=interval(data.pollingInterval);
        const rows=new Map((data.datas||[]).map(r=>[r.reutersCode,r]));
        primary=mapped.map(x=>parseNaverQuote(rows.get(x.code),x.symbol,pollAfterMs)).filter(Boolean);
      }catch(error){primaryError=error;pollAfterMs=Math.max(10000,error.retryAfterMs||0);}
    }
    const got=new Set([...primary,...fallback].map(q=>q.symbol));
    const missing=syms.filter(s=>!got.has(s));
    if(missing.length) {try{fallback.push(...await tencent(missing));}catch(error){if(!primary.length&&!fallback.length)throw primaryError||error;}}
    const quotes=new Map(fallback.map(q=>[q.symbol,q]));
    for(const q of primary) if(!quotes.has(q.symbol) || q.quoteAt >= quotes.get(q.symbol).quoteAt) quotes.set(q.symbol,q);
    if(!quotes.size && primaryError)throw primaryError;
    return {quotes:[...quotes.values()],pollAfterMs:Math.max(pollAfterMs,...[...quotes.values()].filter(q=>q.src==='tx-batch').map(q=>q.pollAfterMs))};
  }
  async function resolveNaverCode(symbol,{signal}={}){
    let code=knownCode(symbol)||descriptors.get(symbol)?.code;
    if(!code&&/^[A-Z][A-Z0-9-]{0,15}$/.test(symbol)){await tencent([symbol],{signal});code=descriptors.get(symbol)?.code;}
    return code||null;
  }
  return { parseNaverQuote, parseTencentBatch, fetchSnapshotBatch, tencent,resolveNaverCode };
}
