import {historyError} from './history-contract.js';

// Provider check time belongs to the provider cache; checkedAt belongs to the
// local reader. Legacy adapters explicitly disclose an unverified return clock.
export function sourceTiming(value,at){
 const stamp=value?.sourceCheckedAt??value?.meta?.sourceCheckedAt;
 if(stamp==null)return {sourceCheckedAt:at,sourceTimeBasis:'adapter-return-unverified'};
 if(!Number.isFinite(stamp)||stamp<=0||stamp>at+5000)throw historyError('HISTORY_SOURCE_TIME_INVALID','Invalid history source-check time',502);
 const until=value?.sourceFreshUntil;
 return {sourceCheckedAt:stamp,sourceTimeBasis:value.sourceTimeBasis||'source-checked',
  ...(Number.isFinite(until)&&until>=stamp&&until<=stamp+7*86400000?{sourceFreshUntil:until}:{})};
}
export function failureAppliesToRange(raw,start){
 return !!raw?.error&&(raw.failureBlocksAll||!raw.failedFrom||start<=raw.failedFrom);
}
export function historyExtent(query,bars,{scope='requested',hasMore}={}){
 return {requested:{period:query.period,count:query.count,before:query.before??null},
  available:{first:bars[0]?.periodStart??null,last:bars.at(-1)?.periodStart??null,count:bars.length},scope,
  satisfied:!(scope==='near'&&query.period!=='daily')&&(bars.length>=query.count||hasMore===false)};
}
const duration=value=>value?.pointKind==='price-point'?0:
 Number(value?.intervalSeconds)||({'1m':60,'5m':300}[value?.resolution])||0;
function intervals(value){
 const step=duration(value),ranges=[];
 for(const bar of [...(value?.bars||[])].sort((a,b)=>a.t-b.t)){
  const start=bar.t-(value.pointKind==='bar-close'?step:0),end=start+step,last=ranges.at(-1);
  if(last&&start<=last[1])last[1]=Math.max(last[1],end);else ranges.push([start,end]);
 }
 return ranges;
}
// Compare known observations, not an assumption that every security trades in
// every slot. Different bar widths may cover the same verified time intervals.
export function knownCoverageRegressed(previous,next){
 const old=intervals(previous),fresh=intervals(next);let cursor=0;
 for(const [start,end] of old){
  while(cursor<fresh.length&&fresh[cursor][1]<start)cursor++;
  if(!fresh[cursor]||fresh[cursor][0]>start||fresh[cursor][1]<end)return true;
 }
 return false;
}
export function intervalCoverage(days,{pointKind,resolution,intervalSeconds}={}){
 const step=duration({pointKind,resolution,intervalSeconds});
 const rows=days.map(day=>{
  const bars=day.bars||[],sessions=day.regularSessions||[],keys=new Set(bars.map(b=>b.t));
  const known=step>0&&pointKind!=='price-point'&&bars.every(b=>[b.o,b.h,b.l,b.c].every(Number.isFinite));
  let expectedSlots=0,observedSlots=0,gapCount=0;
  if(known)for(const session of sessions){let gap=false;
   for(let at=session.open_at_ms/1000;at+step<=session.close_at_ms/1000;at+=step){
    expectedSlots++;const present=keys.has(at+(pointKind==='bar-close'?step:0));
    if(present){observedSlots++;gap=false;}else if(!gap){gapCount++;gap=true;}
   }
  }
  return {date:day.date,status:known?(observedSlots===expectedSlots&&expectedSlots>0?'complete':'partial'):'unknown',
   observedBars:bars.length,expectedSlots:known?expectedSlots:null,observedSlots:known?observedSlots:null,
   missingSlots:known?expectedSlots-observedSlots:null,gapCount:known?gapCount:null,
   firstAt:bars[0]?.t??null,lastAt:bars.at(-1)?.t??null};
 });
 return {status:rows.every(day=>day.status==='complete')?'complete':rows.some(day=>day.status==='unknown')?'unknown':'partial',
  observedBars:rows.reduce((n,day)=>n+day.observedBars,0),expectedSlots:rows.some(day=>day.expectedSlots==null)?null:rows.reduce((n,day)=>n+day.expectedSlots,0),days:rows};
}
