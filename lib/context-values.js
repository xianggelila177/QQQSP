// Projection boundary: upstream objects are never spread into the public API.
export const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export const positive=value=>number(value)>0?value:null;
export const nonnegative=value=>number(value)!==null&&value>=0?value:null;
export const text=value=>typeof value==='string'&&value.trim()?value:null;
export const list=value=>Array.isArray(value)?value:[];
export const timestamp=value=>positive(value)!==null&&value<=8.64e15?value:null;
export const seconds=value=>positive(value)===null?null:timestamp(value*1000);
export const legacyTime=value=>positive(value)===null?null:value<1e12?seconds(value):timestamp(value);
export const unique=values=>[...new Set(values.filter(value=>value!==null&&value!==undefined))];
export const max=values=>values.reduce((highest,value)=>number(value)!==null&&(highest===null||value>highest)?value:highest,null);
export const min=values=>values.reduce((lowest,value)=>number(value)!==null&&(lowest===null||value<lowest)?value:lowest,null);
export const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
export const failureCode=(error,fallback)=>typeof (error?.code||error)==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||error)?error.code||error:fallback;
export const stale=value=>!!(value?.stale||value?.recovery||value?.staleInfo);
export function safeUrl(value){
 try{
  const url=new URL(value),host=url.hostname.toLowerCase();
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.includes(':')||/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))return null;
  if([...url.searchParams.keys()].some(key=>/^(?:key|api[-_]?key|token|access[-_]?token|secret|password|authorization)$/i.test(key)))return null;
  return url.href;
 }catch{return null;}
}
const dateFormatters=new Map();
export function localDate(at,zone){
 if(!timestamp(at)||!zone)return null;
 try{
  let formatter=dateFormatters.get(zone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});if(dateFormatters.size>=64)dateFormatters.delete(dateFormatters.keys().next().value);dateFormatters.set(zone,formatter);}
  return formatter.format(new Date(at));
 }catch{return null;}
}
export function sortedRows(rows){
 const byTime=new Map();for(const row of rows)byTime.set(row[0],row);
 return [...byTime.values()].sort((a,b)=>a[0]-b[0]);
}
const statusReason=status=>status==='partial'?'PARTIAL_DATA':status==='unavailable'?'SOURCE_UNAVAILABLE':null;
export function common({status='unavailable',sources=[],asOf=null,checkedAt=null,delay=null,coverage={},adjustment='unknown',reason=null}={}){
 return {status,source_ids:unique(sources),as_of_ms:timestamp(asOf),source_checked_at_ms:timestamp(checkedAt),delay_minutes:nonnegative(delay),coverage,adjustment,missing_reason:reason||statusReason(status)};
}

