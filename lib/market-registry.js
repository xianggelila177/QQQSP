import { readFileSync } from 'node:fs';
import {futureInstruments, futureInstrumentFor, futuresDirectory} from './futures-instruments.js';

// Primary cash-equity venues only. Secondary suffixes require their own
// verified trading calendar before they can be added to this registry.
const definitions = [
  ['us','美国','美股','美洲','NASDAQ / NYSE','America/New_York','USD',['AM','OQ','N'],['NMS','NYQ','NASDAQ','NYSE','ARCA','AMEX','AMX','PCX','ASE','OTC','PNK','NCM','NGM','NSQ']],
  ['cn','中国内地','A股','亚洲','Shanghai / Shenzhen / Beijing','Asia/Shanghai','CNY',['SS','SZ','BJ'],['SHH','SHZ','SSE','SZSE','BSE']],
  ['hk','香港','港股','亚洲','Hong Kong Exchange','Asia/Hong_Kong','HKD',['HK'],['HKEX','HKSE','HKG']],
  ['jp','日本','日股','亚洲','Japan Exchange Group','Asia/Tokyo','JPY',['T','JP'],['JPX','TOKYO']],
  ['kr','韩国','韩股','亚洲','Korea Exchange','Asia/Seoul','KRW',['KS','KQ'],['KRX','KSC','KSE','KOSDAQ','KOSPI']],
  ['uk','英国','英股','欧洲','London Stock Exchange','Europe/London','GBP',['L'],['LSE']],
  ['de','德国','德股','欧洲','Xetra','Europe/Berlin','EUR',['DE'],['GER','XETRA']],
  ['fr','法国','法股','欧洲','Euronext Paris','Europe/Paris','EUR',['PA'],['PAR','PARIS']],
  ['ch','瑞士','瑞股','欧洲','SIX Swiss Exchange','Europe/Zurich','CHF',['SW'],['EBS','SWISS']],
  ['nl','荷兰','荷股','欧洲','Euronext Amsterdam','Europe/Amsterdam','EUR',['AS'],['AMS','AMSTERDAM']],
  ['it','意大利','意股','欧洲','Borsa Italiana','Europe/Rome','EUR',['MI'],['MIL','MILAN']],
  ['es','西班牙','西股','欧洲','BME Madrid','Europe/Madrid','EUR',['MC'],['MCE','MADRID']],
  ['ca','加拿大','加股','美洲','Toronto Stock Exchange','America/Toronto','CAD',['TO'],['TOR','TORONTO']],
  ['au','澳大利亚','澳股','大洋洲','Australian Securities Exchange','Australia/Sydney','AUD',['AX'],['ASX']],
  ['in','印度','印股','亚洲','National Stock Exchange of India','Asia/Kolkata','INR',['NS'],['NSI','NSE']],
  ['sg','新加坡','新股','亚洲','Singapore Exchange','Asia/Singapore','SGD',['SI'],['SES','SGX']],
  ['tw','台湾','台股','亚洲','Taiwan Stock Exchange','Asia/Taipei','TWD',['TW'],['TAI','TAIWAN']],
  ['br','巴西','巴股','美洲','B3 Brasil Bolsa Balcão','America/Sao_Paulo','BRL',['SA'],['SAO','SÃO PAULO']],
  ['mx','墨西哥','墨股','美洲','Bolsa Mexicana de Valores','America/Mexico_City','MXN',['MX'],['MEX','MEXICO']],
  ['za','南非','南非股','非洲','Johannesburg Stock Exchange','Africa/Johannesburg','ZAR',['JO'],['JNB','JOHANNESBURG']],
];
export const MARKET_REGISTRY=Object.freeze(Object.fromEntries(definitions.map(([key,name,label,region,exchange,timezone,currency,suffixes,exchangeCodes])=>[key,Object.freeze({key,name,label,region,exchange,timezone,currency,suffixes:Object.freeze(suffixes),exchangeCodes:Object.freeze(exchangeCodes)})])));
export const MARKET_TIMEZONES=Object.freeze(Object.fromEntries(Object.values(MARKET_REGISTRY).map(m=>[m.key,m.timezone])));
export const MARKET_SUFFIXES=Object.freeze(Object.fromEntries(Object.values(MARKET_REGISTRY).flatMap(m=>m.suffixes.map(s=>[s,m.key]))));
const instruments=JSON.parse(readFileSync(new URL('../data/market-instruments.json',import.meta.url),'utf8'));
export const catalogInstruments=()=>[...instruments,...futureInstruments];
export function catalogInstrumentFor(symbol){return futureInstrumentFor(symbol)||instruments.find(x=>x.symbol===String(symbol||'').toUpperCase()) || null;}
export function registryMarketFor(symbol,exchange=''){
  const s=String(symbol||'').toUpperCase(),known=catalogInstrumentFor(s);
  if(known)return known.market;
  const suffix=/\.([A-Z]{1,4})$/.exec(s)?.[1];
  if(suffix)return MARKET_SUFFIXES[suffix] || null;
  const words=String(exchange||'').toUpperCase().split(/[^A-ZÀ-Ü0-9]+/);
  return Object.values(MARKET_REGISTRY).find(m=>m.exchangeCodes.some(code=>words.includes(code)))?.key || null;
}
export function marketDirectory(){
  return {version:1,featured:['^FTSE'],markets:Object.values(MARKET_REGISTRY).map(({key,name,label,region,exchange,timezone,currency})=>{
    const listed=instruments.filter(x=>x.market===key&&x.verifiedAt&&(x.type===x.providerType||x.typeSource==='catalog'&&x.sources?.length));
    const publicItem=x=>({symbol:x.symbol,name:x.name,type:x.type});
    return {key,name,label,region,exchange,timezone,currency,benchmarks:listed.filter(x=>x.type==='INDEX').map(publicItem),examples:listed.filter(x=>x.type!=='INDEX').map(publicItem),sourceNote:'公开来源可能延迟或缺少部分字段'};
  }).concat(futuresDirectory())};
}
export const MARKET_ALIASES=Object.freeze({
  '富时100':'^FTSE','富时':'^FTSE','英国':'^FTSE','英股':'^FTSE','ftse':'^FTSE','ftse100':'^FTSE','ftse 100':'^FTSE',
  '德国':'^GDAXI','德股':'^GDAXI','德国dax':'^GDAXI','dax':'^GDAXI',
  '法国':'^FCHI','法股':'^FCHI','cac40':'^FCHI','cac 40':'^FCHI',
  '瑞士':'^SSMI','瑞股':'^SSMI','smi':'^SSMI','荷兰':'^AEX','荷股':'^AEX','aex':'^AEX',
  '意大利':'FTSEMIB.MI','意股':'FTSEMIB.MI','ftse mib':'FTSEMIB.MI','富时mib':'FTSEMIB.MI',
  '西班牙':'^IBEX','西股':'^IBEX','ibex35':'^IBEX','ibex 35':'^IBEX',
  '加拿大':'^GSPTSE','加股':'^GSPTSE','tsx':'^GSPTSE','澳大利亚':'^AXJO','澳股':'^AXJO','asx200':'^AXJO','asx 200':'^AXJO',
  '印度':'^NSEI','印股':'^NSEI','nifty50':'^NSEI','nifty 50':'^NSEI','新加坡':'^STI','sti':'^STI','海峡时报':'^STI',
  '台湾':'^TWII','台股':'^TWII','台湾加权':'^TWII','巴西':'^BVSP','巴股':'^BVSP','ibovespa':'^BVSP',
  '墨西哥':'^MXX','墨股':'^MXX','南非':'^J203.JO','南非股':'^J203.JO',
});
