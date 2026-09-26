import {common,number,nonnegative,text,localDate,timestamp,unique} from './context-values.js';
import {priceSessionFor} from './sessions.js';
import {sessionFor,timezoneOffsetFor} from '../mkt.mjs';
import {localInstant} from './market-calendar-api.js';
import {instrumentTypeFor} from './instruments.js';
import {validPrice} from './price-values.js';
const dateMsLabel=date=>Date.parse(date+'T00:00:00Z');
export const OHLC_COLUMNS=Object.freeze(['time_ms','trade_date','open','high','low','close','volume','session','sample_count','source_id']);
export function historicalIntraday(value,query,{source,zone,now,error,priceUnit}={}){
 const columns=['time_ms','trade_date','open','high','low','close','volume','session'];
 const unit=priceUnit==='points'?'points':value?.currency||null,rows=(value?.points||[]).map(p=>[p.t*1000,localDate(p.t*1000,zone),p.o,p.h,p.l,p.c,priceUnit!=='points'&&value?.volumeUnit==='shares'?nonnegative(p.v):null,priceSessionFor(query.symbol,p.t*1000)]);
 const usable=rows.length>0,reason=error?.code||value?.missing_reason||(!usable?'NO_SOURCE_HISTORY':value?.limited?'RETRIEVAL_BUDGET':null);
 const status=!usable?'unavailable':value?.limited||value?.rejected||value?.stale||error?'partial':'ready';
 return {...common({status,reason,sources:value?.source?[source(value.source)]:[],asOf:rows.at(-1)?.[0],checkedAt:value?.sourceCheckedAt,adjustment:value?.adjustment||'unknown'}),columns,
  column_units:['unix_milliseconds','exchange_date',unit,unit,unit,unit,value?.volumeUnit||'unknown','session'],
  column_descriptions:['Source bar start time; not server receipt time','Exchange trading date','Source interval open','Source interval high','Source interval low','Source interval close','Only verified non-cumulative volume; unknown unit yields null','Calendar session, not a halt feed'],rows,
  coverage:{requested_date:query.intraday_date||null,requested_before:query.intraday_before||null,requested_month:query.intraday_month||null,start:value?.start||null,end:value?.end||null,
   returned_points:rows.length,first_time_ms:rows[0]?.[0]??null,last_time_ms:rows.at(-1)?.[0]??null,time_zone:zone,next_before:value?.start||null,
   gaps:'no interpolation; absent intervals are not zero-volume bars',price_kind:'source_ohlcv',volume_kind:priceUnit!=='points'&&value?.volumeUnit==='shares'?'bar_volume':'unknown',feed:value?.feed||null,
   retrieval_limited:!!value?.limited,rejected_rows:value?.rejected||0}};
}
export function corporateActionsSection(value,{source,error}={}){
 const rows=(value?.events||[]).map(e=>[e.id??null,e.type,e.ex_date,number(e.ratio),number(e.amount),text(e.currency),text(e.payment_date),text(e.process_date),source(e.source),timestamp(e.as_of_ms),text(e.amount_basis)]);
 return {...common({status:!value?'unavailable':value.limited||value.rejected||value.stale?'partial':'ready',reason:error?.code||(!value?'ACTIONS_UNAVAILABLE':value.limited?'RETRIEVAL_BUDGET':null),sources:unique(rows.map(r=>r[8])),checkedAt:value?.sourceCheckedAt,adjustment:'event_specific'}),
  columns:['event_id','type','ex_date','ratio','amount','currency','payment_date','process_date','source_id','as_of_ms','amount_basis'],
  column_units:['identifier','event_type','exchange_date','new_shares_per_old_share','money_per_share','currency','exchange_date','exchange_date','source_reference','unix_milliseconds','basis'],
  column_descriptions:['Provider event ID; null when not supplied','split or dividend','Ex-date; not payment date','New shares / old shares; reverse splits may be below one','Cash amount per share in stated basis','Unknown currency is null; not assumed USD','Payable date, not proof an individual account received cash','Provider processing date, separate from ex-date','Reference to sources dictionary','Source observation timestamp if provided, not ex-date midnight','Per-share adjustment basis; do not apply a split twice'],rows,
  coverage:{start:value?.start||null,end:value?.end||null,filter_basis:value?.filterBasis||null,returned_events:rows.length,rejected_events:value?.rejected||0,
   has_more:!!value?.limited,stop_reason:value?.limited?'retrieval-budget; narrow actions_start/actions_end':null,paid_dividend_window_verified:!!value?.paidWindowVerified,
   ordering:'ascending ex_date, then event type; events sharing an ex-date are retained',limitations:value?.limitations||[]}};
}
// Aggregate only what is observed. Samples are never labelled exchange OHLCV.
export function aggregateContextSeries(section,minutes,{symbol,zone,sampled=false}={}){
 const columns=section.columns||[],index=Object.fromEntries(columns.map((k,i)=>[k,i]));
 const get=(r,k)=>index[k]===undefined?null:r[index[k]];
 const groups=new Map();let conflicts=0;
 const volumeReliable=!sampled&&section.coverage?.volume_kind==='bar_volume'&&section.column_units?.[index.volume]==='shares';
 for(const r of section.rows||[]){
  const at=get(r,'time_ms'),date=get(r,'trade_date'),session=get(r,'session')||'UNKNOWN';
  if(!Number.isFinite(at)||typeof date!=='string')continue;
  const source=get(r,'source_id')??(section.source_ids?.length===1?section.source_ids[0]:null),currency=get(r,'currency')??section.column_units?.[index.close??index.price]??null;
  const calendar=sessionFor(symbol,null,at),minute=(at+timezoneOffsetFor(symbol,at)*1000-dateMsLabel(date))/60000;
  const ranges=calendar.session[{PRE:'pre',REGULAR:'reg',POST:'post',AUCTION:'auc'}[session]]||[];
  const segment=ranges.find(([a,b])=>minute>=a&&minute<=b),origin=localInstant(symbol,date,segment?.[0]||0),bucket=origin+Math.floor((at-origin)/(minutes*60000))*minutes*60000;
  const key=date+'|'+session+'|'+(segment?.[0]||0),group=groups.get(key)||{date,session,first:bucket,last:bucket,buckets:new Map()};groups.set(key,group);group.first=Math.min(group.first,bucket);group.last=Math.max(group.last,bucket);
  const price=get(r,'price'),o=number(get(r,'open'))??price,h=number(get(r,'high'))??price,l=number(get(r,'low'))??price,c=number(get(r,'close'))??price;
  if(![o,h,l,c].every(n=>validPrice(n,instrumentTypeFor(symbol))))continue;
  let b=group.buckets.get(bucket);
  if(!b){b={o,h,l,c,v:0,knownVolume:volumeReliable,count:0,source,currency,firstAt:at,lastAt:at,conflict:false};group.buckets.set(bucket,b);}
  if(b.source!==source||b.currency!==currency)b.conflict=true;
  b.h=Math.max(b.h,h);b.l=Math.min(b.l,l);if(at<b.firstAt){b.o=o;b.firstAt=at;}if(at>=b.lastAt){b.c=c;b.lastAt=at;}
  const volume=get(r,'volume');if(!Number.isFinite(volume)||volume<0)b.knownVolume=false;else b.v+=volume;b.count++;
 }
 const rows=[];
 for(const g of groups.values())for(let at=g.first;at<=g.last;at+=minutes*60000){
  const b=g.buckets.get(at);if(b?.conflict)conflicts++;
  rows.push([at,g.date,b&&!b.conflict?b.o:null,b&&!b.conflict?b.h:null,b&&!b.conflict?b.l:null,b&&!b.conflict?b.c:null,b?.knownVolume&&!b.conflict?b.v:null,g.session,b?.count||0,b&&!b.conflict?b.source:null]);
 }
 rows.sort((a,b)=>a[0]-b[0]||a[7].localeCompare(b[7]));
 const unit=section.column_units?.[index.close??index.price]||null,gaps=rows.filter(r=>r[8]===0).length;
 return {...section,status:conflicts||gaps?section.status==='unavailable'?'unavailable':'partial':section.status,
  missing_reason:conflicts?'MIXED_SOURCE_BUCKET':gaps?'OBSERVATION_GAPS':section.missing_reason,
  columns:[...OHLC_COLUMNS],column_units:['unix_milliseconds','exchange_date',unit,unit,unit,unit,volumeReliable?'shares':null,'session','observations','source_reference'],
  column_descriptions:['Exchange-session-open aligned interval start; local midnight only if session is unknown','Exchange trading date','First observed/source bar open','Maximum observed/source high','Minimum observed/source low','Last observed/source bar close',volumeReliable?'Sum of source bar volume only if every input is known':'Unknown or cumulative/source-unit-unverified volume is null in the entire column','Sessions are never merged across PRE/REGULAR/POST','Number of input observations; zero is an empty bucket','Mixed-source buckets have null OHLC and source ID'],rows,
  coverage:{...section.coverage,aggregate_minutes:minutes,price_kind:sampled?'observed_price_ohlc_not_trade_bars':index.price!==undefined?'observed_source_prices_not_trade_bars':'source_bar_aggregation',
   returned_points:rows.length,input_points:section.rows?.length||0,empty_buckets:gaps,conflicting_buckets:conflicts,alignment:'known session segment open; otherwise local midnight; partitioned by date/session/segment',
   gaps:'Interior empty buckets between first and last observation of each session are retained as null; no invented full-day coverage',volume_kind:volumeReliable?'sum_of_known_bar_volume':'unknown',sampled}};
}
