import {symbolValid} from './symbol-validation.js';
import {canonicalSymbol} from './symbol-canonical.js';
import {marketKeyFor} from './instruments.js';
import {historyQuery,validDate,dateMs} from './history-contract.js';
import {contextError} from './api-error.js';

import {CONTEXT_SECTIONS,ALL_CONTEXT_SECTIONS,EXTRA_QUERY_KEYS,CONTEXT_QUERY_KEYS} from './context-query-catalog.js';
export {CONTEXT_SECTIONS,ALL_CONTEXT_SECTIONS,EXTRA_QUERY_KEYS,CONTEXT_QUERY_KEYS};
const bad=()=>{throw contextError('BAD_CONTEXT_QUERY');};
const canonical=value=>typeof value==='string'&&value.length<=64?canonicalSymbol(value):'';
const valid=s=>symbolValid(s)&&!!marketKeyFor(s);
export function parseContextQuery(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!CONTEXT_QUERY_KEYS.includes(k)))bad();
 const batch=Object.hasOwn(value,'symbols');
 if(batch&&(Object.hasOwn(value,'symbol')||!Array.isArray(value.symbols)||!value.symbols.length||value.symbols.length>10))bad();
 const symbols=batch?value.symbols.map(canonical):[canonical(value.symbol)];
 if(symbols.some(s=>!valid(s))||new Set(symbols).size!==symbols.length)bad();
 const query={daily_bar_count:252,sample_trading_days:3,include:batch?['quote','fundamentals']:[...CONTEXT_SECTIONS],max_wait_ms:15000,format:'compact',...value};
 if(batch)query.symbols=symbols;else query.symbol=symbols[0];
 for(const [key,min,max] of [['daily_bar_count',1,500],['sample_trading_days',1,3],['max_wait_ms',0,15000]])if(!Number.isInteger(query[key])||query[key]<min||query[key]>max)bad();
 if(!['compact','csv'].includes(query.format)||!Array.isArray(query.include)||!query.include.length||query.include.length>ALL_CONTEXT_SECTIONS.length||query.include.some(s=>!ALL_CONTEXT_SECTIONS.includes(s))||new Set(query.include).size!==query.include.length)bad();
 if(batch){
  if(query.include.some(s=>!['quote','fundamentals'].includes(s))||query.format==='csv'||EXTRA_QUERY_KEYS.some(k=>Object.hasOwn(value,k))||value.daily_before!=null||value.daily_series_id!=null)bad();
  return query;
 }
 if(query.daily_before!=null||query.daily_series_id!=null){
  try{const h=historyQuery(query.symbol,'daily',{count:query.daily_bar_count,before:query.daily_before,seriesId:query.daily_series_id});query.daily_before=h.before;query.daily_series_id=h.seriesId;}catch{bad();}
 }
 if(Object.hasOwn(value,'adjustment')&&(!query.include.includes('daily')||!['raw','split','split_dividend'].includes(value.adjustment)))bad();
 if(Object.hasOwn(value,'daily_granularity')&&(!query.include.includes('daily')||!['daily','weekly','monthly'].includes(value.daily_granularity)))bad();
 const selectors=['intraday_before','intraday_month','intraday_date'].filter(k=>Object.hasOwn(value,k));
 if(selectors.length>1||selectors.length&&!query.include.includes('intraday'))bad();
 for(const key of ['intraday_before','intraday_date','actions_start','actions_end'])if(Object.hasOwn(value,key)&&!validDate(value[key]))bad();
 if(Object.hasOwn(value,'intraday_month')&&!(typeof value.intraday_month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value.intraday_month)&&validDate(value.intraday_month+'-01')))bad();
 if(['actions_start','actions_end'].some(k=>Object.hasOwn(value,k))&&!query.include.includes('corporate_actions'))bad();
 if(value.actions_start&&value.actions_end&&(value.actions_start>value.actions_end||dateMs(value.actions_end)-dateMs(value.actions_start)>3660*86400000))bad();
 if(Object.hasOwn(value,'aggregate_minutes')){
  if(![1,5,15,30,60].includes(value.aggregate_minutes))bad();
  const source=value.aggregate_source??'intraday';if(!['intraday','samples'].includes(source)||!query.include.includes(source))bad();
 }else if(Object.hasOwn(value,'aggregate_source'))bad();
 if(query.format==='csv'&&(query.include.length!==1||!['daily','intraday','samples','corporate_actions'].includes(query.include[0])))bad();
 return query;
}
export function contextFromSearch(params){
 const value={};
 for(const [key,raw] of params){
  if(Object.hasOwn(value,key)||!CONTEXT_QUERY_KEYS.includes(key))bad();
  if(['daily_bar_count','sample_trading_days','max_wait_ms','aggregate_minutes'].includes(key)){
   if(!/^\d+$/.test(raw))bad();value[key]=Number(raw);
  }else value[key]=['include','symbols'].includes(key)?raw.split(','):raw;
 }
 return parseContextQuery(value);
}
