import {sessionFor,timezoneForSymbol,timezoneOffsetFor} from '../mkt.mjs';
import {isFutureSymbol} from './futures-instruments.js';
import {localDateAt,addDays} from './history-contract.js';

const ranges=session=>['pre','auc','reg','post'].flatMap(key=>session[key]||[]);
function dayInfo(symbol,date,context) {
  const probe=Date.parse(date+'T12:00:00Z');
  const noon=probe-timezoneOffsetFor(symbol,probe)*1000;
  const {session,calendar}=sessionFor(symbol,null,noon,context);
  const weekday=new Date(date+'T12:00:00Z').getUTCDay();
  return {session,calendar,noon,open:!calendar.closed&&(!(weekday===0||weekday===6)||calendar.specialOpen)};
}
export function sampleTradingDays(symbol,at=Date.now(),context={}) {
  const timeZone=timezoneForSymbol(symbol);
  const unavailable={supported:false,timeZone,tradingDays:[],reason:'暂不支持三交易日采样：交易日或交易时段尚未核验'};
  if(!timeZone||isFutureSymbol(symbol)||!Number.isFinite(at))return unavailable;
  const today=localDateAt(at,timeZone),local=new Date(at+timezoneOffsetFor(symbol,at)*1000);
  const minute=local.getUTCHours()*60+local.getUTCMinutes(),days=[];
  for(let i=0;i<45&&days.length<3;i++){
    const date=addDays(today,-i),info=dayInfo(symbol,date,context);
    if(!info.calendar.known)return unavailable;
    if(!info.open)continue;
    const sessions=ranges(info.session);
    if(!sessions.length)return unavailable;
    if(i===0&&minute<Math.min(...sessions.map(([start])=>start)))continue;
    days.push(date);
  }
  return days.length===3?{supported:true,timeZone,tradingDays:days.reverse(),reason:null}:unavailable;
}
export function sampleTradingDay(symbol,at,context={}) {
  const zone=timezoneForSymbol(symbol);if(!zone||isFutureSymbol(symbol))return null;
  const date=localDateAt(at,zone),info=dayInfo(symbol,date,context);
  if(!info.calendar.known||!info.open)return null;
  const local=new Date(at+timezoneOffsetFor(symbol,at)*1000),minute=local.getUTCHours()*60+local.getUTCMinutes()+local.getUTCSeconds()/60;
  // Endpoint timestamps at a session's closing boundary are legitimate quotes.
  if(info.session.unknown?.some(([start,end])=>minute>=start&&minute<end))return null;
  return ranges(info.session).some(([start,end])=>minute>=start&&minute<=end+1)?date:null;
}
