import {createHash} from 'node:crypto';
export {symbolValid as validSymbol} from './symbol-validation.js';
export const HISTORY_PERIODS=Object.freeze({daily:'daily',weekly:'weekly',monthly:'monthly',yearly:'yearly'});
export const HISTORY_PERIOD_LIST=Object.freeze(Object.keys(HISTORY_PERIODS));
export const validHistoryPeriod=value=>HISTORY_PERIOD_LIST.includes(value);
export const finiteNumber=value=>typeof value==='number'&&Number.isFinite(value);
export const historyError=(code,message,status=400)=>Object.assign(new Error(message),{code,statusCode:status});
export function validDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const ms=Date.parse(value+'T00:00:00Z');
 return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value;
}
export const dateMs=date=>Date.parse(date+'T00:00:00Z');
export const addDays=(date,n)=>new Date(dateMs(date)+n*86400000).toISOString().slice(0,10);
export const contentHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const dateFormatters=new Map();
export function localDateAt(ms,zone){
 if(!finiteNumber(ms)||!zone)throw historyError('HISTORY_TIMEZONE','Missing exchange time zone',422);
 let formatter=dateFormatters.get(zone);
 if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});dateFormatters.set(zone,formatter);}
 const parts=formatter.formatToParts(new Date(ms));
 const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;
}
export function normalizeDailyBar(row){
 if(!row||!validDate(row.sessionDate)||![row.o,row.h,row.l,row.c].every(finiteNumber))return null;
 const {o,h,l,c}=row,v=row.v==null?null:row.v;
 if(h<Math.max(o,c)||l>Math.min(o,c)||l>h||v!==null&&(!finiteNumber(v)||v<0))return null;
 return {...row,o,h,l,c,v,source:row.source||'unknown',currency:row.currency??null,quality:row.quality||'source-unverified'};
}
export function historyQuery(symbol,period,options={}){
 if(!validHistoryPeriod(period))throw historyError('BAD_HISTORY_QUERY','Unsupported history period');
 const count=options.count??options.limit??(period==='yearly'?39:79);
 if(!/^[1-9]\d*$/.test(String(count))||!Number.isInteger(Number(count))||Number(count)>500)throw historyError('BAD_HISTORY_QUERY','count must be an integer from 1 to 500');
 const before=options.before??null;
 if(before!==null&&!validDate(before))throw historyError('BAD_HISTORY_QUERY','before must be a valid YYYY-MM-DD');
 if(options.seriesId!=null&&(typeof options.seriesId!=='string'||options.seriesId.length>128))throw historyError('BAD_HISTORY_QUERY','Invalid seriesId');
 return {symbol:String(symbol||'').toUpperCase(),period,count:Number(count),before,seriesId:options.seriesId??null};
}
