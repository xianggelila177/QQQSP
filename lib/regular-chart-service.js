import {timezoneForSymbol} from '../mkt.mjs';
import {localDateAt} from './history-contract.js';
import {previousTradingDate,tradingDayInfo} from './market-calendar-api.js';
import {volumeCapability} from './volume-normalizer.js';
import {marketKeyFor,instrumentTypeFor} from './instruments.js';

const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const validVolume=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const dateOf=(symbol,at)=>localDateAt(at,timezoneForSymbol(symbol));

export function regularChartTarget(symbol,now){
  let today;
  try{today=dateOf(symbol,now);}catch{return {status:'unavailable',missingReason:'CHART_TIME_ZONE_UNKNOWN'};}
  const current=tradingDayInfo(symbol,today);
  if(!current.known)return {status:'unavailable',missingReason:current.missing_reason||'CALENDAR_OUTSIDE_COVERAGE'};
  let targetDate=today;
  if(!current.is_open||now<current.regular_sessions[0].open_at_ms){
    try{targetDate=previousTradingDate(symbol,today);}catch{return {status:'unavailable',missingReason:'CALENDAR_OUTSIDE_COVERAGE'};}
  }
  const day=targetDate===today?current:tradingDayInfo(symbol,targetDate);
  if(!day.known||!day.is_open||!day.regular_sessions.length)return {status:'unavailable',missingReason:'REGULAR_SESSION_UNKNOWN'};
  return {status:'ready',targetDate,exchangeZone:timezoneForSymbol(symbol),regularSessions:day.regular_sessions,
    halfDay:day.half_day,calendarSource:day.source};
}

export function projectRegularBars(symbol,bars,{source,pointKind='bar-start',instrumentType,targetDate,now=Date.now()}={}){
  if(!targetDate||!Array.isArray(bars))return {bars:[],tradeDate:null,regularSessions:[],missingReason:'NO_SOURCE_HISTORY'};
  const valid=bars.filter(b=>positive(b?.t)&&b.t*1000<=now+5000&&positive(b.c))
    .map(b=>({...b,v:validVolume(b.v)?b.v:null})).sort((a,b)=>a.t-b.t);
  const dates=[...new Set(valid.map(b=>dateOf(symbol,b.t*1000)))].filter(d=>d<=targetDate).sort();
  const candidates=[targetDate,...dates.reverse().filter(d=>d!==targetDate)];
  for(const date of candidates){
    const day=tradingDayInfo(symbol,date);
    if(!day.known||!day.is_open||!day.regular_sessions.length)continue;
    const regular=valid.filter(b=>dateOf(symbol,b.t*1000)===date&&
      day.regular_sessions.some(s=>b.t*1000>=s.open_at_ms&&
        (b.t*1000<s.close_at_ms||pointKind==='price-point'&&b.t*1000===s.close_at_ms)));
    if(!regular.length)continue;
    const capability=volumeCapability({source,market:marketKeyFor(symbol),instrumentType:instrumentType||instrumentTypeFor(symbol)});
    const knownVolume=capability.status==='verified'?regular.filter(b=>validVolume(b.v)).length:0;
    const selected=regular.map(b=>({...b,v:capability.status==='verified'?b.v:null}));
    return {bars:selected,tradeDate:date,regularSessions:day.regular_sessions,
      missingReason:date===targetDate?null:'TARGET_DAY_HISTORY_PENDING',
      pointKind,source,volumeUnit:capability.unit,
      volumeQuality:{status:knownVolume===0?'missing':knownVolume===selected.length?'ready':'partial',
        knownBars:knownVolume,totalBars:selected.length,source,unit:capability.unit,
        missingReason:knownVolume===0?capability.status==='verified'?'SOURCE_VOLUME_MISSING':'VOLUME_UNIT_UNVERIFIED':
          knownVolume<selected.length?'PARTIAL_VOLUME_COVERAGE':null}};
  }
  return {bars:[],tradeDate:null,regularSessions:[],missingReason:'REGULAR_HISTORY_NOT_AVAILABLE',
    pointKind,source,volumeUnit:null,volumeQuality:{status:'missing',knownBars:0,totalBars:0,source,unit:null,
      missingReason:'REGULAR_HISTORY_NOT_AVAILABLE'}};
}

export function recentRegularSessions(symbol,before,count=5){
  const result=[];let cursor=before;
  for(let i=0;i<count;i++){
    if(i){try{cursor=previousTradingDate(symbol,cursor);}catch{break;}}
    const day=tradingDayInfo(symbol,cursor);
    if(!day.known||!day.is_open)break;
    result.unshift({date:cursor,sessions:day.regular_sessions,halfDay:day.half_day});
  }
  return result;
}

export function chartPreviousClose(quote,tradeDate){
  if(!quote?.symbol||!tradeDate)return {value:null,tradeDate:null,status:'unavailable',source:null};
  let expected;
  try{expected=previousTradingDate(quote.symbol,tradeDate);}catch{return {value:null,tradeDate:null,status:'calendar-unknown',source:null};}
  if(quote.quoteTradeDate===tradeDate&&quote.previousCloseTradeDate===expected&&positive(quote.prevClose))
    return {value:quote.prevClose,tradeDate:expected,status:quote.previousCloseStatus,source:quote.previousCloseSource};
  const regularAt=quote.regularQuoteAt;
  if(quote.priceSession==='PRE'&&positive(regularAt)&&dateOf(quote.symbol,regularAt)===tradeDate&&
     quote.src?.startsWith('naver-')&&positive(quote.providerPrevClose))
    return {value:quote.providerPrevClose,tradeDate:expected,status:'source-aligned',source:quote.src};
  const daily=quote.charts?.daily30||[];
  const match=daily.find(b=>Number.isFinite(b?.t)&&new Date(b.t*1000).toISOString().slice(0,10)===expected&&positive(b.c));
  return match?{value:match.c,tradeDate:expected,status:'source-dated',source:quote.slowFields?.daily30?.source||quote.src}:
    {value:null,tradeDate:expected,status:'unavailable',source:null};
}
