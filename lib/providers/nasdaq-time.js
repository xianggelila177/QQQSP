// Nasdaq chart x may be a wall-clock plotting coordinate. z.dateTime is the
// provider's displayed event time. Normalize in this adapter, never in the UI.
// No host-local Date.parse, hardcoded +4h, current-date substitution or mutation
// of the quote timestamp. Explicit offsets always take precedence.
const ZONE='America/New_York';
const HOUR=3600000;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const zoneParts=at=>Object.fromEntries(formatter.formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
const encode=p=>Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
const valid=p=>{
 if(!p||p.year<1970||p.year>2200||p.month<1||p.month>12||p.day<1||p.hour>23||p.minute>59||p.second>59)return false;
 const d=new Date(encode(p));return d.getUTCFullYear()===p.year&&d.getUTCMonth()+1===p.month&&d.getUTCDate()===p.day;
};
function dateParts(text){
 let m;
 if((m=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)))return {year:+m[1],month:+m[2],day:+m[3]};
 if((m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)))return {year:+m[3],month:+m[1],day:+m[2]};
 if((m=/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text)))return {year:+m[3],month:MONTHS.indexOf(m[1].slice(0,3).toLowerCase())+1,day:+m[2]};
 return null;
}
function parseLabel(value){
 const text=String(value??'').trim().replace(/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+/i,'');
 const m=/^(?:(.*?)\s*[T ]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(ET|EDT|EST|UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
 if(!m)return null;
 let hour=+m[2];if(m[5]){if(hour<1||hour>12)return null;hour=hour%12+(m[5].toUpperCase()==='PM'?12:0);}
 const date=m[1]?dateParts(m[1].trim()):null;if(m[1]&&!date)return null;
 if(hour>23||+m[3]>59||+(m[4]||0)>59)return null;
 return {date,hour,minute:+m[3],second:+(m[4]||0),hasSeconds:!!m[4],zone:(m[6]||'ET').toUpperCase()};
}
function toInstant(p,zone){
 if(!valid(p))return null;
 const wall=encode(p);
 if(['Z','UTC','GMT'].includes(zone))return wall;
 if(zone==='EST'||zone==='EDT')return wall+(zone==='EST'?5:4)*HOUR;
 if(/^[+-]/.test(zone)){
  const match=/^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if(!match||+match[2]>23||+match[3]>59)return null;
  return wall-(match[1]==='+'?1:-1)*(+match[2]*60+ +match[3])*60000;
 }
 // Probe the offsets on both sides of a DST transition, then round-trip.
 // Non-existent spring times and ambiguous autumn times without EST/EDT are
 // rejected. Neither occurs in a normal weekday stock session.
 const offsets=new Set([wall-86400000,wall+86400000].map(t=>encode(zoneParts(t))-t));
 const candidates=[...offsets].map(off=>wall-off).filter(at=>encode(zoneParts(at))===wall);
 return candidates.length===1?candidates[0]:null;
}
export function normalizeNasdaqTime(row){
 const raw=typeof row?.x==='number'?row.x:typeof row?.x==='string'&&row.x.trim()?Number(row.x):NaN;
 const epoch=Number.isFinite(raw)&&raw>0?(raw>1e12?raw:raw*1000):null;
 const label=row?.z?.dateTime??row?.dateTime;
 if(label==null||String(label).trim()==='')return epoch==null?null:{at:epoch,basis:'epoch-unverified'};
 const parsed=parseLabel(label);if(!parsed)return null;
 let date=parsed.date;
 if(!date){
  if(epoch==null)return null;
  const local=zoneParts(epoch);
  // An ordinary UTC epoch already agrees with the displayed Eastern clock.
  if(parsed.zone==='ET'&&local.hour===parsed.hour&&local.minute===parsed.minute&&(!parsed.hasSeconds||local.second===parsed.second))return {at:epoch,basis:'source-label'};
  const d=new Date(epoch);date={year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
 }
 const at=toInstant({...date,hour:parsed.hour,minute:parsed.minute,second:parsed.second},parsed.zone);
 return at==null?null:{at,basis:'source-label'};
}
export const NASDAQ_TIME_CONTRACT='nasdaq-label-et-v2';
