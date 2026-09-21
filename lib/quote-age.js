import {sessionFor,timezoneOffsetFor,marketStateFor} from '../mkt.mjs';

/** Event-age tolerance, independent of provider fetch/check freshness. */
export function quoteAgeLimitMs(quote,at){
 const rawDelay=quote?.feedDelayMinutes;
 const delay=typeof rawDelay==='number'&&Number.isFinite(rawDelay)&&rawDelay>=0?rawDelay:0;
 const ordinary=Math.max(300000,delay*60000+30000);
 const calendarState=quote?.symbol?marketStateFor(quote.symbol,null,at,quote):'UNKNOWN';
 const state=calendarState==='UNKNOWN'?quote?.marketState:calendarState;
 if(['CLOSED','HOLIDAY'].includes(state))return 14*86400000;
 if(state==='BREAK'&&quote.symbol){
  const offset=timezoneOffsetFor(quote.symbol,at);
  if(offset!=null){
   const local=new Date(at+offset*1000),minute=local.getUTCHours()*60+local.getUTCMinutes();
   const pause=sessionFor(quote.symbol,offset,at,quote).session.brk?.find(([from,to])=>minute>=from&&minute<to);
   if(pause)return ordinary+(minute-pause[0])*60000+local.getUTCSeconds()*1000+local.getUTCMilliseconds();
  }
 }
 return ordinary;
}
