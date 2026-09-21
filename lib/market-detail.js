import {parseContextQuery,CONTEXT_SECTIONS,contextError} from './market-context-service.js';
import {EXTRA_QUERY_KEYS} from './context-query.js';
import {METRIC_CATALOG} from './metric-catalog.js';

export function parseDetailQuery(value) {
  const keys=['symbol','profile','format','daily_bar_count','sample_trading_days','max_wait_ms','daily_before','daily_series_id','include',...EXTRA_QUERY_KEYS];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw contextError('BAD_CONTEXT_QUERY');
  const profile=value.profile??'snapshot',format=value.format??'objects';
  if(!['snapshot','analysis'].includes(profile)||!['objects','compact'].includes(format))throw contextError('BAD_CONTEXT_QUERY');
  if(profile==='snapshot'&&(value.daily_before!=null||value.daily_series_id!=null||EXTRA_QUERY_KEYS.some(k=>Object.hasOwn(value,k))))throw contextError('BAD_CONTEXT_QUERY');
  if(profile==='snapshot'&&Object.hasOwn(value,'include'))throw contextError('BAD_CONTEXT_QUERY');
  const include=value.include??(profile==='snapshot'?['quote','fundamentals']:[...CONTEXT_SECTIONS]);
  const {profile:_,format:__,...input}=value;
  const q=parseContextQuery({...input,include,format:'compact',max_wait_ms:value.max_wait_ms??(profile==='snapshot'?5000:15000)});
  return {...q,profile,format};
}

export function buildMarketDetail(context,query) {
  const sections={...context.sections};
  if(sections.quote?.data){const {order_book,...data}=sections.quote.data;sections.quote={...sections.quote,data};sections.order_book=order_book;}
  // On quote-unavailable requests the field schema is still fully discoverable.
  if(sections.quote&&!sections.order_book)sections.order_book={status:'unavailable',source_ids:[],as_of_ms:null,source_checked_at_ms:null,delay_minutes:null,
    coverage:{scope:null,depth:1,size_unit:null},adjustment:'not_applicable',missing_reason:'NO_QUOTE',data:{bid:{price:null,size:null,exchange:null},ask:{price:null,size:null,exchange:null},spread:null,currency:null,size_unit:null,retained:false}};
  if(sections.order_book&&context.instrument.type==='INDEX')sections.order_book={...sections.order_book,status:'not_applicable',missing_reason:'INSTRUMENT_TYPE'};
  if(sections.fundamentals){
    const f=sections.fundamentals;
    sections.fundamentals={...f,data:{...f.data,fields:Object.fromEntries(Object.entries(f.data.fields).map(([key,value])=>[key,{...METRIC_CATALOG[key],...value}]))}};
  }
  for(const [name,section] of Object.entries(sections))if(section?.rows&&query.format==='objects'){
    const {rows,...meta}=section;
    sections[name]={...meta,records:rows.map(row=>Object.fromEntries(section.columns.map((key,i)=>[key,row[i]])))};
  }
  const missing=[],stale=[],conflicts=[];
  for(const [key,field] of Object.entries(sections.fundamentals?.data.fields||{})){
    if(field.status==='not-applicable')continue;
    if((field.value===null&&!['loss','nonpositive-book'].includes(field.status))||['unavailable','conflict','expired'].includes(field.status))missing.push('fundamentals.'+key);
    if(field.stale)stale.push('fundamentals.'+key);
    if(field.status==='conflict')conflicts.push('fundamentals.'+key);
  }
  for(const key of ['price','previous_close','open','high','low','volume']){
    if(key==='volume'&&context.instrument.type==='INDEX')continue;
    if(sections.quote&&sections.quote.data?.[key]==null)missing.push('quote.'+key);
  }
  if(sections.order_book&&sections.order_book.status!=='not_applicable')for(const side of ['bid','ask'])for(const key of ['price','size']){
    if(sections.order_book.data?.[side]?.[key]==null)missing.push('order_book.'+side+'.'+key);
  }
  const values=Object.values(sections),usable=values.some(v=>['ready','partial'].includes(v.status));
  const warnings=[...context.quality.warnings];
  if(sections.order_book?.data?.retained)warnings.push('retained_order_book');
  return {...context,schema_version:2,profile:query.profile,format:query.format,
    status:!usable?'unavailable':missing.length||values.some(v=>['partial','unavailable'].includes(v.status))?'partial':'complete',sections,
    quality:{...context.quality,missing_sections:Object.entries(sections).filter(([,v])=>v.status==='unavailable').map(([k])=>k),missing_fields:missing,stale_fields:stale,conflicting_fields:conflicts,warnings},
    definitions:{...context.definitions,percentage:'percent 数值 1 表示 1%，不是小数 0.01。',book:'盘口与成交有独立时间；round_lots 为来源整手单位，不擅自换算成股，不用一档买卖量计算全盘口委比。',
      completeness:'partial 是有效返回，不是失败；检查 missing_fields、每段状态和缺失原因。不补零、不推断缺失成交额、不混用币种。',profile:query.profile==='snapshot'?'证券详情快照，不主动请求历史、资讯、采样或宏观数据。':'包含有限历史窗口；日线续页使用 coverage.next_before 和 series_id；每页检查来源口径。'}};
}

export function createMarketDetailService(contextService) {
  return {async query(value,options){
    const query=parseDetailQuery(value),{profile,format,...input}=query;
    const context=await contextService.query({...input,format:'compact'},options);
    return buildMarketDetail(context,query);
  }};
}
