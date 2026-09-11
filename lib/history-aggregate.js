import {normalizeDailyBar,validHistoryPeriod,validDate,dateMs,addDays,localDateAt,historyError,contentHash} from './history-contract.js';
import {marketCalendarInfo,sessionFor,timezoneOffsetFor} from '../mkt.mjs';
export function periodBounds(date,period,weekStartsOn=1){
 if(!validDate(date)||!validHistoryPeriod(period)||!Number.isInteger(weekStartsOn)||weekStartsOn<0||weekStartsOn>6)throw historyError('BAD_HISTORY_QUERY','Invalid period boundary');
 let start=date,end;
 if(period==='weekly')start=addDays(date,-((new Date(dateMs(date)).getUTCDay()-weekStartsOn+7)%7));
 if(period==='monthly')start=date.slice(0,7)+'-01';
 if(period==='yearly')start=date.slice(0,4)+'-01-01';
 if(period==='daily')end=addDays(start,1);
 else if(period==='weekly')end=addDays(start,7);
 else if(period==='monthly'){const d=new Date(dateMs(start));d.setUTCMonth(d.getUTCMonth()+1);end=d.toISOString().slice(0,10);}
 else end=String(Number(start.slice(0,4))+1).padStart(4,'0')+'-01-01';
 return {periodStart:start,periodEndExclusive:end};
}
function plannedDay(symbol,date){
 const noon=dateMs(date)+43200000,offset=timezoneOffsetFor(symbol,noon);
 if(offset==null)return {known:false};
 const localNoon=noon-offset*1000,calendar=marketCalendarInfo(symbol,localNoon),{session}=sessionFor(symbol,null,localNoon);
 if(!calendar.known||calendar.pending||session.unknown?.length)return {known:false};
 const weekday=new Date(dateMs(date)).getUTCDay();
 if(calendar.closed||[0,6].includes(weekday)&&!calendar.specialOpen)return {known:true,trading:false};
 if(!session.reg?.length)return {known:false};
 return {known:true,trading:true,closeAt:dateMs(date)+Math.max(...session.reg.map(x=>x[1]))*60000-offset*1000};
}
export function periodStatus(bounds,{symbol,zone,asOf=Date.now(),dayPlan=plannedDay}={}){
 const today=zone?localDateAt(asOf,zone):new Date(asOf).toISOString().slice(0,10);
 if(today>=bounds.periodEndExclusive)return 'closed';
 if(!symbol||!zone)return 'unknown';
 let lastClose=null;
 for(let date=bounds.periodStart;date<bounds.periodEndExclusive;date=addDays(date,1)){
  const plan=dayPlan(symbol,date);if(!plan.known)return 'unknown';
  if(plan.trading)lastClose=plan.closeAt;
 }
 return lastClose==null?'unknown':asOf>=lastClose?'closed':'open';
}
export function aggregateHistory(rows,period,options={}){
 const {asOf=Date.now(),symbol,zone,weekStartsOn=1,requestedFrom,listingDate,historyAsOf,dayPlan=plannedDay}=options;
 if(!validHistoryPeriod(period))throw historyError('BAD_HISTORY_QUERY','Unsupported history period');
 const byDate=new Map();let identity=null;const invalid=[];
 const today=zone?localDateAt(asOf,zone):new Date(asOf).toISOString().slice(0,10);
 for(const row of rows||[]){
  const b=normalizeDailyBar(row);if(!b){invalid.push(row?.sessionDate);continue;}
  if(b.sessionDate>today)throw historyError('HISTORY_FUTURE_DATE','Future trading date',422);
  const id=contentHash([b.source,b.currency,b.adjustmentBasis,b.adjustmentRevision,b.volumeUnit,b.exchangeTimeZone,b.sessionScope]);
  if(identity&&identity!==id)throw historyError('HISTORY_IDENTITY_CONFLICT','mixed history identity',422);identity=id;
  const old=byDate.get(b.sessionDate);
  if(old&&contentHash(old)!==contentHash(b)){
   if(!Number.isFinite(old.sourceRevision)||!Number.isFinite(b.sourceRevision)||old.sourceRevision===b.sourceRevision)throw historyError('HISTORY_CONFLICT','Conflicting daily bar without a comparable source revision',422);
   if(b.sourceRevision<old.sourceRevision)continue;
  }
  byDate.set(b.sessionDate,b);
 }
 const groups=new Map();
 for(const b of [...byDate.values()].sort((a,z)=>a.sessionDate.localeCompare(z.sessionDate))){
  const bounds=periodBounds(b.sessionDate,period,weekStartsOn),key=bounds.periodStart;
  const g=groups.get(key)||{...bounds,t:dateMs(key)/1000,firstTradingDate:b.sessionDate,lastTradingDate:b.sessionDate,o:b.o,h:b.h,l:b.l,c:b.c,v:0,knownVolume:0,volumeComplete:true,dates:new Set(),source:b.source,currency:b.currency};
  g.lastTradingDate=b.sessionDate;g.h=Math.max(g.h,b.h);g.l=Math.min(g.l,b.l);g.c=b.c;g.dates.add(b.sessionDate);
  if(b.v==null)g.volumeComplete=false;else g.knownVolume+=b.v;
  groups.set(key,g);
 }
 return [...groups.values()].map(g=>{
  const flags=[];let coverage='unknown';
  const left=listingDate&&listingDate>g.periodStart?listingDate:g.periodStart;
  if(requestedFrom&&requestedFrom>left){coverage='partial';flags.push('left-boundary-truncated');}
  if(invalid.some(date=>!validDate(date)||date>=g.periodStart&&date<g.periodEndExclusive)){coverage='partial';flags.push('invalid-source-records');}
  if(symbol&&zone&&historyAsOf&&coverage!=='partial'){
   let known=true,missing=false;
   const through=historyAsOf<g.periodEndExclusive?historyAsOf:addDays(g.periodEndExclusive,-1);
   for(let date=left;date<=through;date=addDays(date,1)){
    const plan=dayPlan(symbol,date);if(!plan.known){known=false;break;}
    if(plan.trading&&!g.dates.has(date))missing=true;
   }
   if(known&&!missing)coverage='complete-to-asof';
   else if(missing){coverage='partial';flags.push('missing-sessions-unexplained');}
   else flags.push('historical-calendar-unknown');
  }else if(coverage==='unknown')flags.push('coverage-unverified');
  if(!g.volumeComplete)flags.push('volume-unknown');
  const {dates,...bar}=g;
  return {...bar,v:g.volumeComplete?g.knownVolume:null,periodState:periodStatus(g,{symbol,zone,asOf,dayPlan}),coverageStatus:coverage,qualityFlags:flags};
 });
}
