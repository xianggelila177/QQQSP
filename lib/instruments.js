// Canonical security identity and provider capability rules. Provider adapters
// supply exchange/type evidence; presentation consumes these normalized values.
import {isFutureSymbol,futureInstrumentFor} from './futures-instruments.js';
import { MARKET_REGISTRY, MARKET_TIMEZONES, registryMarketFor, catalogInstrumentFor } from './market-registry.js';
const US_INDEX = new Set(['^IXIC','^NDX','^GSPC','^DJI','^SOX','^RUT','^VIX']);
const CN_INDEX = new Set(['000001.SS','399001.SZ','399006.SZ','000688.SS','000300.SS']);
const ETF = new Set(['QQQ','SPY','VOO','IVV','DIA','IWM']);
const MARKET = Object.fromEntries(Object.values(MARKET_REGISTRY).map(m=>[m.key,m.label]));
export { MARKET_TIMEZONES };
export function marketKeyFor(symbol, exchange = '') {
  const s = String(symbol || '').toUpperCase();
  if(isFutureSymbol(s))return 'futures';
  const registry=registryMarketFor(s);
  if(registry)return registry;
  if (/\.(SS|SZ|BJ)$/.test(s)) return 'cn';
  if (/\.HK$/.test(s) || /^\^(HSI|HSCE)$/.test(s)) return 'hk';
  if (/\.(T|JP)$/.test(s) || /^\^(N225|TOPIX)$/.test(s)) return 'jp';
  if (/\.(KS|KQ)$/.test(s) || s === '^KS11') return 'kr';
  // Unknown exchange suffixes and non-equity Yahoo instruments never inherit US hours.
  if (/\.[A-Z]{1,4}$/.test(s) && !/\.(AM|OQ|N)$/.test(s)) return null;
  if (s.startsWith('^')) return US_INDEX.has(s) ? 'us' : null;
  if (/=|-USD$|-USDT$/.test(s)) return null;
  const exchangeMarket=registryMarketFor('',exchange);
  if(exchangeMarket)return exchangeMarket;
  const e=String(exchange).toUpperCase();
  if (/HKEX|HKSE|HKG/.test(e)) return 'hk';
  if (/JPX|TOKYO/.test(e)) return 'jp';
  if (/KRX|KSE|KOSDAQ|KOSPI/.test(e)) return 'kr';
  if (/NASDAQ|NMS|NYSE|NYQ|ARCA|AMEX|AMERICAN STOCK EXCHANGE|AMX|PCX|ASE|OTC|PNK|NCM|NGM|NSQ/.test(e)) return 'us';
  return /^[A-Z][A-Z0-9-]*(?:\.(?:AM|OQ|N))?$/.test(s) ? 'us' : null;
}
export function instrumentTypeFor(symbol, quoteType = '') {
  const s=String(symbol || '').toUpperCase();
  if(isFutureSymbol(s))return 'FUTURE';
  const raw=typeof quoteType === 'object' ? quoteType?.code || quoteType?.name || '' : quoteType;
  const type=String(raw || '').toUpperCase();
  const catalog=catalogInstrumentFor(s);
  if(catalog?.typeSource==='catalog'&&catalog.sources?.length)return catalog.type;
  if(!type&&catalog&&catalog.type===catalog.providerType)return catalog.type;
  if (type === 'INDEX' || s.startsWith('^') || CN_INDEX.has(s)) return 'INDEX';
  if (/ETF|EXCHANGE TRADED FUND/.test(type) || ETF.has(s)) return 'ETF';
  if (['MUTUALFUND','FUTURE','CURRENCY','CRYPTOCURRENCY','EQUITY'].includes(type)) return type;
  return 'EQUITY';
}
export function classifyMarket(symbol, exch='', exchDisp='', quoteType='') {
  const s=String(symbol || '').toUpperCase(),key=marketKeyFor(s,exch+' '+exchDisp);
  if(isFutureSymbol(s))return '国际期货';
  if (instrumentTypeFor(s,quoteType)==='INDEX') return key ? MARKET[key]+'指数' : '指数';
  if (key==='cn') return s.endsWith('.BJ') ? '北交所' : s.endsWith('.SS') ? (/^688/.test(s)?'科创板':'沪A') : (/^30/.test(s)?'创业板':'深A');
  if (key==='kr' && s.endsWith('.KQ')) return '韩股(KOSDAQ)';
  return MARKET[key] || '其他';
}
export function instrumentMeta(symbol, meta={}) {
  const s=String(symbol || '').toUpperCase();
  const instrumentType=instrumentTypeFor(s,meta.instrumentType || meta.quoteType || meta.stockType || meta.itemType);
  const exchangeName=meta.fullExchangeName || meta.exchangeName || futureInstrumentFor(s)?.exchange || (/\.SS$/.test(s)?'SSE':/\.SZ$/.test(s)?'SZSE':/\.BJ$/.test(s)?'BSE':/\.HK$/.test(s)?'HKEX':/\.(T|JP)$/.test(s)?'JPX':/\.(KS|KQ)$/.test(s)?'KRX':MARKET_REGISTRY[marketKeyFor(s)]?.exchange||'');
  const supplied=meta.instrumentType || meta.quoteType || meta.stockType || meta.itemType;
  const catalog=catalogInstrumentFor(s);
  const instrumentTypeSource=catalog?.typeSource==='catalog'&&catalog.sources?.length?'catalog':supplied?'provider':(s.startsWith('^')||CN_INDEX.has(s)||ETF.has(s)||catalog)?'symbol':'inferred';
  return {instrumentType,instrumentTypeSource,exchangeName,displayName:meta.shortName || meta.longName || meta.name || meta.symbol || s,market:classifyMarket(s,meta.exchangeName,exchangeName,instrumentType)};
}
export function tencentCodeFor(symbol) {
  const s=String(symbol || '').toUpperCase();
  const cn=/^(\d{6})\.(SS|SZ)$/.exec(s);
  if (cn) return (cn[2]==='SS'?'sh':'sz')+cn[1];
  const hk=/^(\d{4,5})\.HK$/.exec(s);
  if(hk)return 'hk'+hk[1].padStart(5,'0');
  // Yahoo caret indexes have no verified generic Tencent symbol mapping.
  if (marketKeyFor(s)!=='us' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(s)) return null;
  return 'us'+s.replace(/^\^/,'');
}
export function providerCapabilities(symbol) {
  const s=String(symbol || '').toUpperCase(),key=marketKeyFor(s),tx=tencentCodeFor(s);
  const group=['^N225','^SOX','^GSPC'].includes(s)?'index':/^\d[A-Z0-9]{3}\.T$/.test(s)?'jp':/^\d{6}\.(KS|KQ)$/.test(s)?'kr':tx?(key==='cn'||key==='hk'||s.startsWith('^')?'other':'us'):null;
  return {marketKey:key,batchGroup:group,batchProviders:group==='index'?['naver-index']:group==='jp'?['naver-jp']:group==='kr'?['naver']:group==='us'?['naver','tencent']:tx?['tencent']:[],tencentCode:tx,legacyQuote:true};
}
export function validWeek52Range(high,low) {
  const h=high==null||high===''?null:Number(high),l=low==null||low===''?null:Number(low);
  return Number.isFinite(h)&&Number.isFinite(l)&&h>0&&l>0&&h>=l ? {week52High:h,week52Low:l} : {week52High:null,week52Low:null};
}
