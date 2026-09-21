import {MARKET_REGISTRY} from './market-registry.js';
import {sessionFor,timezoneOffsetFor,timezoneForSymbol,marketStateFor,calendarRegistry} from '../mkt.mjs';
import {validDate,addDays,dateMs,localDateAt} from './history-contract.js';
import {contextError} from './api-error.js';
const symbols={us:'SPY',cn:'600519.SS',hk:'0700.HK',jp:'7203.T',kr:'005930.KS',uk:'VOD.L',de:'SAP.DE',fr:'AIR.PA',ch:'NESN.SW',nl:'ASML.AS',it:'ENI.MI',es:'SAN.MC',ca:'SHOP.TO',au:'BHP.AX',in:'RELIANCE.NS',sg:'D05.SI',tw:'2330.TW',br:'PETR4.SA',mx:'WALMEX.MX',za:'NPN.JO'};
export function marketSymbol(exchange='us'){
 const key=typeof exchange==='string'?exchange.toLowerCase():'';
 if(!symbols[key])throw contextError('BAD_CONTEXT_QUERY');return symbols[key];
}
export function localInstant(symbol,date,minute=0){
 const wall=dateMs(date)+minute*60000;let at=wall;
 for(let i=0;i<3;i++)at=wall-timezoneOffsetFor(symbol,at)*1000;
 return at;
}
export function tradingDayInfo(symbol,date){
 const noon=localInstant(symbol,date,720),{session,calendar}=sessionFor(symbol,null,noon);
 const weekend=[0,6].includes(new Date(dateMs(date)).getUTCDay());
 const closed=calendar.closed||weekend&&!calendar.specialOpen;
 const known=calendar.known&&!calendar.pending&&!session.unknown?.length;
 const regular=known&&!closed?(session.reg||[]).map(([a,b])=>({open_at_ms:localInstant(symbol,date,a),close_at_ms:localInstant(symbol,date,b)})):[];
 return {date,known,is_open:known?!closed&&regular.length>0:null,holiday:calendar.closed,weekend,half_day:!!calendar.halfDay,regular_sessions:regular,
  source:calendar.source||null,missing_reason:known?null:calendar.reason||'CALENDAR_OUTSIDE_COVERAGE'};
}
export function previousTradingDate(symbol,before){
 for(let i=1;i<=45;i++){const date=addDays(before,-i),d=tradingDayInfo(symbol,date);if(!d.known)throw contextError('CALENDAR_OUTSIDE_COVERAGE',422);if(d.is_open)return date;}
 throw contextError('CALENDAR_OUTSIDE_COVERAGE',422);
}
export function parseCalendarQuery(value,kind='status'){
 const keys=kind==='calendar'?['exchange','start','end']:['exchange'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw contextError('BAD_CONTEXT_QUERY');
 marketSymbol(value.exchange??'us');
 if(kind==='calendar'&&(!validDate(value.start)||!validDate(value.end)||value.start>value.end||dateMs(value.end)-dateMs(value.start)>366*86400000))throw contextError('BAD_CONTEXT_QUERY');
 return {...value,exchange:(value.exchange??'us').toLowerCase()};
}
export function marketStatus(query,{now=Date.now()}={}){
 query=parseCalendarQuery(query);const symbol=marketSymbol(query.exchange),zone=timezoneForSymbol(symbol),today=localDateAt(now,zone),day=tradingDayInfo(symbol,today);
 const session=marketStateFor(symbol,null,now),profile=MARKET_REGISTRY[query.exchange];let next=null,reason=null;
 for(let i=0;i<=45;i++){
  const d=tradingDayInfo(symbol,addDays(today,i));if(!d.known){reason='CALENDAR_OUTSIDE_COVERAGE';break;}
  next=d.regular_sessions.find(s=>s.open_at_ms>now)?.open_at_ms??null;if(next!==null)break;
 }
 if(next===null&&!reason)reason='NEXT_OPEN_OUTSIDE_SEARCH_WINDOW';
 return {schema_version:1,status:session==='UNKNOWN'||reason?'partial':'complete',exchange:query.exchange,exchange_name:profile.exchange,time_zone:zone,
  as_of_ms:now,session,market_state:session==='UNKNOWN'?'unknown':['PRE','REGULAR','POST','AUCTION'].includes(session)?'open':'closed',regular_open:session==='REGULAR',
  next_open_at_ms:next,next_open_basis:'next regular-session segment opening, strictly after as_of_ms',trading_date:today,today:day,calendar_version:calendarRegistry.version,missing_reason:reason,
  coverage:{scope:'cash-equity calendar; not a live halt or futures-status feed',source:day.source}};
}
export function tradingCalendar(query){
 query=parseCalendarQuery(query,'calendar');const symbol=marketSymbol(query.exchange),days=[];
 for(let date=query.start;date<=query.end;date=addDays(date,1))days.push(tradingDayInfo(symbol,date));
 return {schema_version:1,status:days.some(d=>!d.known)?'partial':'complete',exchange:query.exchange,time_zone:timezoneForSymbol(symbol),calendar_version:calendarRegistry.version,
  coverage:{start:query.start,end:query.end,known_days:days.filter(d=>d.known).length,total_days:days.length,scope:'cash-equity regular sessions; unknown years are not synthesized'},days};
}
