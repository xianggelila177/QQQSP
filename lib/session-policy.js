import {marketKeyFor} from './instruments.js';
import {marketStateFor,sessionFor,timezoneOffsetFor,sessionContext} from '../mkt.mjs';

const cache=new Map();
const DAY=86400000;
// Return an actual known session transition, not a guessed next weekday. Cache
// all boundaries by market, venue and local calendar day to keep polling cheap.
function transitionsFor(symbol,at,venue) {
  const market=marketKeyFor(symbol),offset=timezoneOffsetFor(symbol,at);
  if(!market||offset==null||!Number.isFinite(at))return [];
  const local=new Date(at+offset*1000);
  const day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  const context=sessionContext(symbol,venue);
  const key=market+'|'+context.venue.slice(0,80)+'|'+context.instrumentType+'|'+day;
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
