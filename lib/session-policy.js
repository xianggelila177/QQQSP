import {marketKeyFor} from './instruments.js';
import {marketStateFor,marketCalendarCoverage,sessionFor,timezoneOffsetFor,sessionContext} from '../mkt.mjs';

const cache=new Map();
const DAY=86400000;
// Return an actual known session transition, not a guessed next weekday. Cache
// all boundaries by security, venue and local calendar day to keep polling cheap.
function transitionsFor(symbol,at,venue) {
  const market=marketKeyFor(symbol),offset=timezoneOffsetFor(symbol,at);
  if(!market||offset==null||!Number.isFinite(at))return [];
  const local=new Date(at+offset*1000);
  const day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  const context=sessionContext(symbol,venue);
  const key=market+'|'+String(symbol).toUpperCase()+'|'+context.venue.slice(0,80)+'|'+context.instrumentType+'|'+day;
  let transitions=cache.get(key);
  if(!transitions) {
    transitions=[];
    for(let d=0;d<10;d++) {
      const wallDay=day+d*DAY;
      const noon=wallDay+12*3600000-offset*1000;
      const dailyOffset=timezoneOffsetFor(symbol,noon);
      const {session,calendar}=sessionFor(symbol,dailyOffset,noon,venue);
      if(!calendar.known)break;
      if(calendar.closed)continue;
      const boundaries=new Set(Object.values(session).filter(Array.isArray).flat().flat());
      for(const minute of boundaries) {
        const candidate=wallDay+minute*60000-dailyOffset*1000;
        if(marketStateFor(symbol,null,candidate-1,venue)!==marketStateFor(symbol,null,candidate,venue))transitions.push(candidate);
      }
    }
    transitions.sort((a,b)=>a-b);
    if(cache.size>=128)cache.delete(cache.keys().next().value);
    cache.set(key,transitions);
  }
  return transitions;
}
export function nextMarketTransitionAt(symbol,at=Date.now(),venue='') {return transitionsFor(symbol,at,venue).find(time=>time>at)??null;}
export function marketSessionStartedAt(symbol,at=Date.now(),venue='') {return transitionsFor(symbol,at,venue).findLast(time=>time<=at)??null;}

// Only explicitly verified index schedules produce this UI metadata. It does
// not change the source publication timestamp or manufacture a fresh quote.
export function indexPublicationSession(symbol,at=Date.now(),venue='') {
  const {publication}=sessionFor(symbol,null,at,venue);
  if(!publication)return null;
  const state=marketStateFor(symbol,null,at,venue),coverage=marketCalendarCoverage(symbol,at,null,venue);
  const verified=coverage.known&&state!=='UNKNOWN';
  const nextPublishAt=verified&&state==='CLOSED'?transitionsFor(symbol,at,venue).find(time=>time>at&&marketStateFor(symbol,null,time,venue)==='REGULAR')??null:null;
  return {kind:publication.kind,verified,phase:!verified?'unknown':state==='REGULAR'?'publishing':nextPublishAt?'waiting':'closed',
    timeZone:publication.timeZone,source:publication.source,nextPublishAt};
}

// Refresh only schedule facts at the application read boundary. Provider and
// recovery caches retain their original quote/check clocks and stale evidence.
export function refreshIndexSession(quote,at=Date.now()) {
  if(String(quote?.symbol||'').toUpperCase()!=='^SOX')return quote;
  const symbol=quote.symbol;
  return {...quote,marketState:marketStateFor(symbol,null,at,quote),calendarCoverage:marketCalendarCoverage(symbol,at,null,quote),
    publicationSession:indexPublicationSession(symbol,at,quote)};
}
