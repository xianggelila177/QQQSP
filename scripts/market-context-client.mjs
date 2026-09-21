import {constants} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_RESPONSE_BYTES=2*1024*1024;
const API_PATH='/api/v1/market-context';
const DEFAULT_BASE='https://quotes.example.com';
// Keep this legacy client copyable as one file. Verified aliases mirror
// lib/symbol-canonical.js; the standalone client regression checks agreement.
const canonicalSymbol=value=>{const symbol=value.normalize('NFKC').trim().toUpperCase();return symbol==='SPX'||symbol==='^SPX'?'^GSPC':symbol;};
class ClientError extends Error{
 constructor(code,extra={}){super(code);this.name='MarketContextClientError';this.code=code;Object.assign(this,extra);}
}
const error=(code,extra)=>new ClientError(code,extra);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const tradingDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:'HTTP_ERROR';
function endpoint(baseUrl,apiPath=API_PATH){
 let parsed;try{parsed=new URL(baseUrl);}catch{throw error('INVALID_BASE_URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
 if(parsed.username||parsed.password||parsed.search||parsed.hash||!['','/'].includes(parsed.pathname)||parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback))throw error('INVALID_BASE_URL');
 return new URL(apiPath,parsed).href;
}
function isContext(value,version=1){return object(value)&&value.schema_version===version&&['complete','partial','unavailable'].includes(value.status)&&object(value.instrument)&&typeof value.instrument.symbol==='string'&&object(value.sections);}

/** Retrieve a complete response. Deliberately never follows redirects carrying credentials. */
async function queryData(query,{apiKey,baseUrl=DEFAULT_BASE,timeoutMs=20000,fetchImpl=fetch}={},apiPath=API_PATH,version=1){
 if(typeof apiKey!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(apiKey))throw error('API_KEY_REQUIRED');
 const url=endpoint(baseUrl,apiPath);
 if(!object(query)||typeof query.symbol!=='string')throw error('INVALID_QUERY');
 query={...query,symbol:canonicalSymbol(query.symbol)};
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw error('INVALID_TIMEOUT');
 let body;try{body=JSON.stringify(query);}catch{throw error('INVALID_QUERY');}
 if(Buffer.byteLength(body)>8192)throw error('REQUEST_TOO_LARGE');
 const controller=new AbortController();let timer,reader,response;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(error('REQUEST_TIMEOUT'));},timeoutMs);});
 try{
  const operation=(async()=>{
   response=await fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json',Accept:'application/json'},body,redirect:'error',signal:controller.signal});
   if(controller.signal.aborted){void response.body?.cancel()?.catch(()=>{});throw error('REQUEST_TIMEOUT');}
   if(response.redirected||response.status>=300&&response.status<400)throw error('REDIRECT_REJECTED');
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw error('INVALID_JSON_RESPONSE');
   if(!response.body?.getReader)throw error('INVALID_JSON_RESPONSE');
   reader=response.body.getReader();const chunks=[];let bytes=0;
   for(;;){
    const {done,value}=await reader.read();if(done)break;
    bytes+=value.byteLength;if(bytes>MAX_RESPONSE_BYTES)throw error('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));
   }
   let parsed;try{parsed=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{throw error('INVALID_JSON_RESPONSE');}
   // An unavailable context remains useful diagnostic data. Auth/rate/schema
   // error envelopes are different and are exposed only by their safe code.
   if(isContext(parsed,version)&&(response.ok||response.status===503&&parsed.status==='unavailable')){
    if(parsed.instrument.symbol!==query.symbol)throw error('IDENTITY_MISMATCH');
    return parsed;
   }
   if(!response.ok){const retry=Number(response.headers.get('retry-after'));throw error(safeCode(parsed?.error?.code),{status:response.status,retry_after_seconds:Number.isFinite(retry)&&retry>0?retry:null});}
   throw error('INVALID_CONTEXT_RESPONSE');
  })();
  return await Promise.race([operation,timeout]);
 }catch(cause){if(cause instanceof ClientError)throw cause;throw error(controller.signal.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');}
 finally{
  clearTimeout(timer);
  if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{ /* pending reads settle after cancellation */ }}
  else if(response?.body)void response.body.cancel().catch(()=>{});
 }
}

export function queryMarketContext(query,options){return queryData(query,options);}
export function queryMarketDetail(query,options){return queryData(query,options,'/api/v2/market-detail',2);}

function inspectSeries(section,required){
 if(section==null)return null;
 if(!Array.isArray(section.columns)||!Array.isArray(section.column_units)||!Array.isArray(section.rows)||section.columns.length!==section.column_units.length||section.columns.some(value=>typeof value!=='string')||new Set(section.columns).size!==section.columns.length||required.some(name=>!section.columns.includes(name)))throw error('INVALID_CONTEXT_SERIES');
 const index=Object.fromEntries(section.columns.map((name,i)=>[name,i]));let previous=null;
 for(const row of section.rows){
  if(!Array.isArray(row)||row.length!==section.columns.length)throw error('INVALID_CONTEXT_SERIES');
  const at=row[index.time_ms],day=row[index.trade_date];
  if(!finite(at)||at<=0||previous!==null&&at<=previous||!tradingDate(day))throw error('INVALID_CONTEXT_SERIES');
  previous=at;
 }
 if(section.column_units[index.time_ms]!=='unix_milliseconds')throw error('INVALID_CONTEXT_SERIES');
 return {section,index};
}
function priceUnit(context,series,field){
 const unit=series.section.column_units[series.index[field]],points=context.instrument.price_unit==='points';
 if(unit===null&&!series.section.rows.length)return null;
 if(typeof unit!=='string'||!unit||points&&unit!=='points'||!points&&unit==='points')throw error('INVALID_CONTEXT_SERIES');
 for(const name of ['open','high','low','close','price'])if(name in series.index&&series.section.column_units[series.index[name]]!==unit)throw error('INVALID_CONTEXT_SERIES');
 const declared=series.section.coverage?.currency;
 if(!points&&declared!=null&&declared!==unit)throw error('INVALID_CONTEXT_SERIES');
 if('currency' in series.index){
  const currencies=new Set(series.section.rows.map(row=>row[series.index.currency]));
  const expected=points?context.instrument.currency:unit;
  if(currencies.size>1||currencies.size===1&&[...currencies][0]!==expected)throw error('MIXED_CURRENCY');
 }
 return unit;
}
function checkedPrice(value){if(value===null)return null;if(!finite(value)||value<=0)throw error('INVALID_CONTEXT_SERIES');return value;}

/** Descriptive arithmetic only. Missing observations are never imputed. */
export function computeStatistics(context){
 if(!isContext(context))throw error('INVALID_CONTEXT_RESPONSE');
 const daily=inspectSeries(context.sections.daily,['time_ms','trade_date','close']);
 const samples=inspectSeries(context.sections.samples,['time_ms','trade_date','price']);
 const dailyUnit=daily?priceUnit(context,daily,'close'):null;
 const closes=daily?daily.section.rows.map(row=>({value:checkedPrice(row[daily.index.close]),date:row[daily.index.trade_date]})).filter(item=>item.value!==null):[];
 let mean=null;for(let i=0;i<closes.length;i++)mean=i===0?closes[i].value:mean+(closes[i].value-mean)/(i+1);
 const rawReturn=closes.length>1?(closes.at(-1).value/closes[0].value-1)*100:null;
 const dailyWarnings=['not_total_return'];
 if(daily?.section.status!=='ready')dailyWarnings.push('daily_status_'+(['partial','unavailable','not_applicable'].includes(daily?.section.status)?daily.section.status:'unknown'));
 if(daily&&'period_state' in daily.index&&daily.section.rows.some(row=>['open','unclosed'].includes(row[daily.index.period_state])))dailyWarnings.push('include_unclosed_daily_period');
 if(!daily?.section.adjustment||/unknown|unverified/.test(daily.section.adjustment))dailyWarnings.push('adjustment_unverified');
 if(daily&&closes.length<daily.section.rows.length)dailyWarnings.push('null_closes_excluded');
 if(mean!==null&&!finite(mean)||rawReturn!==null&&!finite(rawReturn))dailyWarnings.push('arithmetic_overflow');
 const retained=samples?.section.coverage?.retained_trading_dates;
 const count=samples?.section.coverage?.requested_trading_days;
 const retainedDays=Array.isArray(retained)&&retained.every(tradingDate)?[...new Set(retained)]:[];
 if(samples&&(!Number.isInteger(count)||count<1||count>3||retainedDays.length!==retained?.length||retainedDays.length>count))throw error('INVALID_CONTEXT_SERIES');
 const sampleUnit=samples?priceUnit(context,samples,'price'):null;
 const covered=new Set(),gaps=[];let last;
 const interval=samples?.section.coverage?.interval_ms;
 if(samples&&(!finite(interval)||interval<=0))throw error('INVALID_CONTEXT_SERIES');
 for(const row of samples?.section.rows||[]){
  const value=checkedPrice(row[samples.index.price]),day=row[samples.index.trade_date],at=row[samples.index.time_ms];
  if(!retainedDays.includes(day))throw error('INVALID_CONTEXT_SERIES');
  if(value===null)continue;
  covered.add(day);
  if(last&&last.day===day&&at-last.at>interval)gaps.push({trade_date:day,after_ms:last.at,before_ms:at,gap_ms:at-last.at});
  last={at,day};
 }
 return {schema_version:1,symbol:context.instrument.symbol,generated_at_ms:context.generated_at_ms,daily:{status:closes.length?'ready':'unavailable',returned_bar_count:daily?.section.rows.length??0,used_close_count:closes.length,mean_close:finite(mean)?mean:null,close_return_percent:finite(rawReturn)?rawReturn:null,price_unit:dailyUnit,first_trade_date:closes[0]?.date??null,last_trade_date:closes.at(-1)?.date??null,warnings:dailyWarnings},samples:{status:covered.size?'ready':'unavailable',requested_trading_days:samples?count:null,retained_trading_days:retainedDays.length,covered_trading_days:covered.size,trading_day_coverage_percent:samples?covered.size/count*100:null,returned_points:samples?.section.rows.length??0,price_unit:sampleUnit,observed_gaps:gaps,warnings:['trading_day_coverage_is_not_minute_completeness','observed_gaps_can_include_scheduled_breaks','no_interpolation_or_backfill']}};
}

function cliOptions(args){
 if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
 const symbol=args.shift();if(!symbol||symbol.startsWith('-'))throw error('SYMBOL_REQUIRED');
 const query={symbol},options={query};
 const flags={'--include':'include','--daily-bars':'daily_bar_count','--sample-days':'sample_trading_days','--wait-ms':'max_wait_ms'};
 const seen=new Set();
 while(args.length){const flag=args.shift();if(seen.has(flag))throw error('DUPLICATE_FLAG');seen.add(flag);
  if(flag==='--stats'){options.stats=true;continue;}
  if(flag==='--output'){options.output=args.shift();if(!options.output||options.output.startsWith('--'))throw error('OUTPUT_REQUIRED');continue;}
  if(!Object.hasOwn(flags,flag))throw error('UNKNOWN_FLAG');const value=args.shift();if(value==null)throw error('FLAG_VALUE_REQUIRED');
  if(flag==='--include'){const includes=value.split(',');if(!includes.length||includes.some(name=>!['quote','intraday','daily','samples','fundamentals','news','macro'].includes(name))||new Set(includes).size!==includes.length)throw error('INVALID_INCLUDE');query.include=includes;}
  else{if(!/^\d+$/.test(value))throw error('INVALID_NUMBER');query[flags[flag]]=Number(value);}
 }
 return options;
}
export function safeOutputPath(output){
 const name=path.basename(output);
 if(name.startsWith('.')||/(?:^|[._-])(?:env|pem|key|credentials|secrets?)(?:[._-]|$)/i.test(name)||path.extname(output).toLowerCase()!=='.json')throw error('UNSAFE_OUTPUT_PATH');
 return path.resolve(output);
}
export async function saveNewFile(output,text){
 let file,created=false;
 try{
  file=await open(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);created=true;
  await file.writeFile(text,'utf8');await file.sync();
 }catch(cause){if(created)await unlink(output).catch(()=>{});throw error(cause.code==='EEXIST'||cause.code==='ELOOP'?'OUTPUT_EXISTS':'OUTPUT_WRITE_FAILED');}
 finally{await file?.close();}
}
async function main(){
 try{
  const options=cliOptions(process.argv.slice(2));
  if(options.help){process.stdout.write('Usage: node --env-file=/private/client.env scripts/market-context-client.mjs SYMBOL [--output data.json] [--stats] [--include quote,daily] [--daily-bars 252] [--sample-days 3] [--wait-ms 15000]\nCredentials: LLM_API_KEY; optional origin: LLM_API_BASE_URL. Output files must be new .json files. Statistics go to stderr.\n');return;}
  const output=options.output?safeOutputPath(options.output):null;
  const context=await queryMarketContext(options.query,{apiKey:process.env.LLM_API_KEY,baseUrl:process.env.LLM_API_BASE_URL||DEFAULT_BASE});
  const statistics=options.stats?computeStatistics(context):null,serialized=JSON.stringify(context)+'\n';
  if(output)await saveNewFile(output,serialized);else process.stdout.write(serialized);
  if(statistics)process.stderr.write(JSON.stringify(statistics)+'\n');
  if(context.status==='unavailable')process.exitCode=2;
 }catch(cause){process.stderr.write(JSON.stringify({error:{code:cause instanceof ClientError?cause.code:'CLIENT_FAILED',...(cause instanceof ClientError&&cause.status?{status:cause.status}:{}),...(cause instanceof ClientError&&cause.retry_after_seconds?{retry_after_seconds:cause.retry_after_seconds}:{})}})+'\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
