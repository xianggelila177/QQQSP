import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {unlink} from 'node:fs/promises';
import {parseContextQuery} from '../lib/context-query.js';
import {safeOutputPath,saveNewFile} from './market-context-client.mjs';
const fail=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
const code=v=>/^[A-Z][A-Z0-9_]{0,79}$/.test(v||'')?v:'REQUEST_FAILED';
export function apiEndpoint(base,route){
 let u;try{u=new URL(base);}catch{throw fail('INVALID_BASE_URL');}
 if(u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname)||u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw fail('INVALID_BASE_URL');
 return new URL(route,u).href;
}
function credentials(key){if(!/^[A-Za-z0-9_-]{32,256}$/.test(key||''))throw fail('API_KEY_REQUIRED');}
async function readBounded(response,max=2097152){
 const reader=response.body?.getReader();if(!reader)throw fail('INVALID_RESPONSE');const parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw fail('RESPONSE_TOO_LARGE');parts.push(Buffer.from(value));}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function queryMarketApi(input,{apiKey,baseUrl='https://quotes.example.com',method='POST',etag,fetchImpl=fetch,timeoutMs=20000}={}){
 credentials(apiKey);if(!['GET','POST'].includes(method)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw fail('INVALID_OPTIONS');
 const query=parseContextQuery(input),body=JSON.stringify(query);if(Buffer.byteLength(body)>8192)throw fail('REQUEST_TOO_LARGE');
 let url=apiEndpoint(baseUrl,'/api/v1/market-context');if(method==='GET')url+='?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!=null).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let response;
 try{
  response=await fetchImpl(url,{method,redirect:'error',cache:'no-store',signal:controller.signal,headers:{Authorization:'Bearer '+apiKey,Accept:query.format==='csv'?'text/csv, application/json':'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{}),...(etag?{'If-None-Match':etag}:{})},...(method==='POST'?{body}:{})});
  const headers=Object.fromEntries(['etag','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','x-api-key-status','x-key-expires-at'].map(k=>[k,response.headers.get(k)]));
  if(response.status===304&&method==='GET')return {notModified:true,headers,data:null};
  if(response.redirected||response.status>=300&&response.status<400)throw fail('REDIRECT_REJECTED');
  const text=await readBounded(response),type=response.headers.get('content-type')||'';
  if(response.ok&&query.format==='csv'&&/^text\/csv(?:;|$)/i.test(type)){
   const raw=response.headers.get('x-qqqsp-metadata');if(!raw||raw.length>12000)throw fail('CSV_METADATA_MISSING');let metadata;
   try{metadata=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw fail('INVALID_CSV_METADATA');}
   if(metadata.instrument?.symbol!==query.symbol||metadata.schema_version!==1)throw fail('IDENTITY_MISMATCH');
   return {csv:text,metadata,headers,status:metadata.status};
  }
  if(!/^application\/json(?:;|$)/i.test(type))throw fail('INVALID_JSON_RESPONSE');let data;try{data=JSON.parse(text);}catch{throw fail('INVALID_JSON_RESPONSE');}
  if(!response.ok&&!(response.status===503&&data.status==='unavailable'&&data.sections||response.status===503&&data.status==='unavailable'&&Array.isArray(data.results)))throw fail(code(data.error?.code),{status:response.status,retryAfter:response.headers.get('retry-after')});
  if(data.schema_version!==1||!['complete','partial','unavailable'].includes(data.status))throw fail('INVALID_CONTEXT_RESPONSE');
  if(query.symbols){if(!Array.isArray(data.results)||data.results.length!==query.symbols.length||data.results.some((r,i)=>r?.schema_version!==1||r?.instrument?.symbol!==query.symbols[i]||!r.sections))throw fail('IDENTITY_MISMATCH');}
  else if(data.instrument?.symbol!==query.symbol||!data.sections)throw fail('IDENTITY_MISMATCH');
  return {data,headers,status:data.status};
 }catch(e){if(e.code&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code))throw e;throw fail(controller.signal.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');}
 finally{clearTimeout(timer);if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});}
}
export async function* streamQuotes(symbols,{apiKey,baseUrl='https://quotes.example.com',signal,fetchImpl=fetch}={}){
 credentials(apiKey);const q=parseContextQuery({symbols,include:['quote']}),url=apiEndpoint(baseUrl,'/api/v1/quote-stream')+'?'+new URLSearchParams({symbols:q.symbols.join(',')});
 const lifetime=AbortSignal.timeout(65000),combined=signal?AbortSignal.any([lifetime,signal]):lifetime;
 const r=await fetchImpl(url,{headers:{Authorization:'Bearer '+apiKey,Accept:'text/event-stream'},redirect:'error',signal:combined});
 if(r.redirected||!r.ok||!/^text\/event-stream/.test(r.headers.get('content-type')||'')){void r.body?.cancel().catch(()=>{});throw fail('STREAM_REJECTED',{status:r.status});}
 const reader=r.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='';
 try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(Buffer.byteLength(buffer)>262144)throw fail('STREAM_FRAME_TOO_LARGE');let boundary;
  while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);let event='message',data=[];for(const line of frame.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}if(data.length){let value;try{value=JSON.parse(data.join('\n'));}catch{throw fail('INVALID_STREAM_DATA');}yield {event,data:value};}}
 }}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function advancedCliOptions(argv){
 if(argv.length===1&&['--help','-h'].includes(argv[0]))return {help:true};
 const [symbol,...rest]=argv;if(!symbol||symbol.startsWith('-'))throw fail('SYMBOL_REQUIRED');
 const q=symbol.includes(',')?{symbols:symbol.split(',')}:{symbol},out={query:q,method:'POST'},seen=new Set();
 const flags={'--include':'include','--daily-bars':'daily_bar_count','--sample-days':'sample_trading_days','--wait-ms':'max_wait_ms','--before':'daily_before','--series-id':'daily_series_id','--adjustment':'adjustment','--granularity':'daily_granularity','--intraday-date':'intraday_date','--intraday-before':'intraday_before','--intraday-month':'intraday_month','--minutes':'aggregate_minutes','--aggregate-source':'aggregate_source','--actions-start':'actions_start','--actions-end':'actions_end','--format':'format'};
 while(rest.length){const f=rest.shift();if(seen.has(f))throw fail('DUPLICATE_FLAG');seen.add(f);if(f==='--get'){out.method='GET';continue;}if(f==='--stream'){out.stream=true;continue;}const v=rest.shift();if(v==null||v.startsWith('--'))throw fail('FLAG_VALUE_REQUIRED');if(f==='--output'){out.output=v;continue;}if(f==='--etag'){out.etag=v;continue;}const k=flags[f];if(!k)throw fail('UNKNOWN_FLAG');q[k]=f==='--include'?v.split(','):['daily_bar_count','sample_trading_days','max_wait_ms','aggregate_minutes'].includes(k)?/^\d+$/.test(v)?Number(v):NaN:v;}
 if(out.stream){if(out.output||Object.keys(q).some(k=>!['symbol','symbols'].includes(k)))throw fail('INVALID_OPTIONS');}
 else parseContextQuery(q);return out;
}
async function main(){try{
 const options=advancedCliOptions(process.argv.slice(2));if(options.help){process.stdout.write('QQQSP 数据接口客户端\n证券用逗号分隔可批量查询；密钥从 LLM_API_KEY、地址从 LLM_API_BASE_URL 读取。\n--include 分区 --adjustment raw|split|split_dividend --granularity daily|weekly|monthly\n--intraday-date 日期 | --intraday-before 日期 | --intraday-month 年月\n--minutes 1|5|15|30|60 --aggregate-source intraday|samples\n--actions-start 日期 --actions-end 日期 --before 日期 --series-id 标识\n--format compact|csv --output 新文件 --get --etag 条件值 --stream\nCSV必须仅选择一个时序分区，同时生成 .metadata.json 侧车；不覆盖任何已有文件。\n');return;}
 const config={apiKey:process.env.LLM_API_KEY,baseUrl:process.env.LLM_API_BASE_URL||'https://quotes.example.com',method:options.method,etag:options.etag};
 if(options.stream){for await(const event of streamQuotes(options.query.symbols||[options.query.symbol],config))process.stdout.write(JSON.stringify(event)+'\n');return;}
 const result=await queryMarketApi(options.query,config);
 if(result.notModified){process.stderr.write(JSON.stringify({not_modified:true,headers:result.headers})+'\n');return;}
 if(result.csv!==undefined){
  if(options.output){const dest=path.resolve(options.output);if(path.extname(dest)!=='.csv')throw fail('UNSAFE_OUTPUT_PATH');safeOutputPath(dest+'.metadata.json');await saveNewFile(dest,result.csv);try{await saveNewFile(dest+'.metadata.json',JSON.stringify(result.metadata,null,2)+'\n');}catch(e){await unlink(dest).catch(()=>{});throw e;}}
  else {process.stdout.write(result.csv);process.stderr.write(JSON.stringify({metadata:result.metadata,headers:result.headers})+'\n');}
 }else{const text=JSON.stringify(result.data)+'\n';if(options.output)await saveNewFile(safeOutputPath(options.output),text);else process.stdout.write(text);}
 process.stderr.write(JSON.stringify({status:result.status,headers:result.headers})+'\n');if(result.status==='unavailable')process.exitCode=2;
}catch(e){process.stderr.write(JSON.stringify({error:{code:code(e.code),...(e.status?{status:e.status}:{})}})+'\n');process.exitCode=1;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
