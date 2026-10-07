import {sessionFor,timezoneOffsetFor,marketStateFor,calendarRegistry,sessionContext} from '../mkt.mjs';
import {localInstant} from './market-calendar-api.js';
import {isFutureSymbol} from './futures-instruments.js';

const DAY=86400000,completedCache=new Map();
// Cache schedule facts, never a provider's price/check time. The phase key
// separates pre-open from after-close on the same exchange date.
function completedSession(quote,at){
 if(isFutureSymbol(quote?.symbol))return null; // Cash calendars cannot certify a Globex close.
 const symbol=quote?.symbol,offset=symbol?timezoneOffsetFor(symbol,at):null;
 if(offset==null)return null;
 const wall=new Date(at+offset*1000),today=wall.toISOString().slice(0,10),ctx=sessionContext(symbol,quote);
 const current=sessionFor(symbol,null,at,quote),last=current.session.reg?.at(-1)?.[1];
 const after=last!=null&&at>=localInstant(symbol,today,last);
 const key=[symbol,ctx.venue,ctx.instrumentType,today,after,calendarRegistry.version].join('|');
 if(completedCache.has(key))return completedCache.get(key);
 let result=null;
 for(let i=0;i<45;i++){
  const date=new Date(Date.parse(today+'T00:00:00Z')-i*DAY).toISOString().slice(0,10);
  const noon=localInstant(symbol,date,720),{session,calendar}=sessionFor(symbol,null,noon,quote);
  if(!calendar.known||calendar.pending||session.unknown?.length)break;
  const weekend=[0,6].includes(new Date(date+'T00:00:00Z').getUTCDay());
  if(calendar.closed||weekend&&!calendar.specialOpen)continue;
  const closeMinute=session.reg?.at(-1)?.[1];
  if(closeMinute==null)break;
  const closeAt=localInstant(symbol,date,closeMinute);
  if(closeAt>at)continue;
  result={tradeDate:date,closeAt,calendarSource:calendar.source};break;
 }
 if(completedCache.size>=400)completedCache.delete(completedCache.keys().next().value);
 completedCache.set(key,result);return result;
}

/** Closed markets still require their last completed regular session. An old
 * last trade stays visible but is not declared current without halt evidence. */
export function quoteFreshnessPolicy(quote,at=Date.now()){
 const rawDelay=quote?.feedDelayMinutes;
 const delay=typeof rawDelay==='number'&&Number.isFinite(rawDelay)&&rawDelay>=0?rawDelay:0;
 const ordinary=Math.max(300000,delay*60000+30000);
 const calendarState=quote?.symbol?marketStateFor(quote.symbol,null,at,quote):'UNKNOWN';
 const state=calendarState==='UNKNOWN'?quote?.marketState:calendarState;
 if(['CLOSED','HOLIDAY'].includes(state)){
  const completed=completedSession(quote,at);
  return {evaluatedAt:at,state,kind:'last_completed_regular_session',calendarVerified:!!completed,
   minEventAt:completed?completed.closeAt-ordinary:at-ordinary,
   requiredTradeDate:completed?.tradeDate??null,sessionCloseAt:completed?.closeAt??null,
   calendarSource:completed?.calendarSource??null,missingReason:completed?null:'QUOTE_CALENDAR_UNVERIFIED'};
 }
 let budget=ordinary;
 if(state==='BREAK'&&quote.symbol){
  const offset=timezoneOffsetFor(quote.symbol,at);
  if(offset!=null){
   const local=new Date(at+offset*1000),minute=local.getUTCHours()*60+local.getUTCMinutes();
   const pause=sessionFor(quote.symbol,offset,at,quote).session.brk?.find(([from,to])=>minute>=from&&minute<to);
   if(pause)budget+=(minute-pause[0])*60000+local.getUTCSeconds()*1000+local.getUTCMilliseconds();
  }
 }
 return {evaluatedAt:at,state,kind:'event_age',calendarVerified:calendarState!=='UNKNOWN',minEventAt:at-budget,missingReason:null};
}

export function quoteAgeLimitMs(quote,at){return Math.max(0,at-quoteFreshnessPolicy(quote,at).minEventAt);}
