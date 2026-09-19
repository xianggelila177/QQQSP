import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,stat,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {computeStatistics,queryMarketContext} from '../../scripts/market-context-client.mjs';

const KEY='test'.repeat(10);
const AT=Date.parse('2026-09-18T00:00:00Z');
const fixture=()=>({schema_version:1,request_id:'fixture',generated_at_ms:AT+86400000,status:'partial',instrument:{symbol:'NVDA',type:'EQUITY',currency:'USD',price_unit:'USD'},sections:{daily:{status:'ready',adjustment:'source_default_unverified',coverage:{currency:'USD'},columns:['time_ms','trade_date','open','high','low','close','volume'],column_units:['unix_milliseconds','exchange_date','USD','USD','USD','USD','shares'],rows:[100,105,110].map((price,i)=>[AT+i*86400000,`2026-09-${18+i}`,price,price+1,price-1,price,null])},samples:{status:'partial',coverage:{requested_trading_days:3,retained_trading_dates:['2026-09-18','2026-09-19','2026-09-20'],interval_ms:60000},columns:['time_ms','trade_date','price','currency'],column_units:['unix_milliseconds','exchange_date','USD','currency'],rows:[[AT,'2026-09-18',100,'USD'],[AT+120000,'2026-09-18',101,'USD'],[AT+86400000*2,'2026-09-20',110,'USD']]}},sources:{},quality:{missing_sections:[],warnings:[]}});
const response=(data=fixture(),status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});

test('statistics use actual closes and covered trading dates, preserving gaps and adjustment warnings',()=>{
 const result=computeStatistics(fixture());assert.equal(result.daily.mean_close,105);assert.ok(Math.abs(result.daily.close_return_percent-10)<1e-10);assert.equal(result.daily.returned_bar_count,3);assert.equal(result.daily.first_trade_date,'2026-09-18');assert.equal(result.daily.last_trade_date,'2026-09-20');assert.equal(result.daily.price_unit,'USD');assert.ok(result.daily.warnings.includes('not_total_return'));
 assert.equal(result.samples.covered_trading_days,2);assert.equal(result.samples.requested_trading_days,3);assert.ok(Math.abs(result.samples.trading_day_coverage_percent-200/3)<1e-10);assert.equal(result.samples.returned_points,3);assert.equal(result.samples.observed_gaps.length,1);assert.equal(result.samples.observed_gaps[0].gap_ms,120000);assert.ok(result.samples.warnings.includes('trading_day_coverage_is_not_minute_completeness'));
});
test('no data yields explicit null statistics and a single close has no return',()=>{
 const value=fixture();value.sections.daily.rows=[];value.sections.samples.rows=[];const none=computeStatistics(value);assert.equal(none.daily.mean_close,null);assert.equal(none.daily.close_return_percent,null);assert.equal(none.samples.trading_day_coverage_percent,0);
 value.sections.daily.rows=[[AT,'2026-09-18',100,101,99,100,null]];const one=computeStatistics(value);assert.equal(one.daily.mean_close,100);assert.equal(one.daily.close_return_percent,null);
 assert.equal(computeStatistics({...value,sections:{}}).samples.trading_day_coverage_percent,null);
});
test('index statistics retain points and reject mixed currency or malformed column contracts',()=>{
 const value=fixture();value.instrument={symbol:'^N225',type:'INDEX',currency:'JPY',price_unit:'points'};value.sections.daily.column_units=value.sections.daily.column_units.map(unit=>unit==='USD'?'points':unit);value.sections.daily.coverage.currency=null;value.sections.samples.column_units[2]='points';for(const row of value.sections.samples.rows)row[3]='JPY';assert.equal(computeStatistics(value).daily.price_unit,'points');
 const mixed=fixture();mixed.sections.samples.rows[1][3]='EUR';assert.throws(()=>computeStatistics(mixed),{code:'MIXED_CURRENCY'});
 for(const damage of [v=>v.sections.daily.columns.push('close'),v=>v.sections.daily.rows[0].pop(),v=>v.sections.daily.column_units[5]='EUR',v=>v.sections.daily.rows[1][0]=v.sections.daily.rows[0][0],v=>v.sections.daily.rows[0][5]=Infinity]){const bad=fixture();damage(bad);assert.throws(()=>computeStatistics(bad),{code:'INVALID_CONTEXT_SERIES'});}
});
test('client posts one query with the key only in Authorization and refuses redirects',async()=>{
 let captured;const result=await queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async(url,options)=>{captured={url,options};return response();}});assert.equal(result.instrument.symbol,'NVDA');assert.equal(captured.url,'https://quotes.example.com/api/v1/market-context');assert.equal(captured.options.method,'POST');assert.equal(captured.options.redirect,'error');assert.equal(captured.options.headers.Authorization,'Bearer '+KEY);assert.equal(captured.options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(captured.options.body),{symbol:'NVDA'});assert.ok(!captured.url.includes(KEY));
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response({},302)}),{code:'REDIRECT_REJECTED'});
});
test('credential and base URL validation happen before any fetch',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response();};
 for(const baseUrl of ['http://example.com','https://user:password@example.com','https://example.com/?token=abc','https://example.com/#hash','https://example.com/subpath'])await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,baseUrl,fetchImpl}),{code:'INVALID_BASE_URL'});
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:'',fetchImpl}),{code:'API_KEY_REQUIRED'});assert.equal(calls,0);
});
test('auth and provider errors are sanitized without echoing key, URL or response text',async()=>{
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response({error:{code:'UNAUTHORIZED',message:KEY}},401)}),error=>error.code==='UNAUTHORIZED'&&error.status===401&&!String(error).includes(KEY));
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>{throw Error('network token '+KEY);}}),error=>error.code==='REQUEST_FAILED'&&!String(error).includes(KEY));
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response({error:{code:'CONTEXT_RATE_LIMITED'}},429,{'Retry-After':'7'})}),error=>error.code==='CONTEXT_RATE_LIMITED'&&error.retry_after_seconds===7);
 const unavailable=fixture();unavailable.status='unavailable';assert.equal((await queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response(unavailable,503)})).status,'unavailable');
});
test('client bounds decoded response bytes, validates JSON and cancels oversized streams',async()=>{
 let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}});
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'application/json'}})}),{code:'RESPONSE_TOO_LARGE'});assert.equal(cancelled,true);
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>new Response('not JSON',{headers:{'Content-Type':'application/json'}})}),{code:'INVALID_JSON_RESPONSE'});
 await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response({symbol:'NVDA'})}),{code:'INVALID_CONTEXT_RESPONSE'});
});
test('request timeout aborts fetch and body reading with sanitized errors',async()=>{
 let signal;await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,timeoutMs:10,fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}}),{code:'REQUEST_TIMEOUT'});assert.equal(signal.aborted,true);
 let cancelled=false;await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}})}),{code:'REQUEST_TIMEOUT'});assert.equal(cancelled,true);
});

test('metadata may be unknown for an empty unavailable series, but invalid populated dates fail closed',()=>{
 const empty=fixture();empty.instrument.currency=null;empty.instrument.price_unit=null;for(const section of Object.values(empty.sections)){section.rows=[];section.column_units=section.column_units.map(unit=>unit==='USD'?null:unit);section.status='unavailable';}empty.sections.daily.coverage.currency=null;
 const result=computeStatistics(empty);assert.equal(result.daily.mean_close,null);assert.equal(result.daily.price_unit,null);assert.equal(result.samples.trading_day_coverage_percent,0);
 const invalid=fixture();invalid.sections.daily.rows[0][1]='2026-02-30';assert.throws(()=>computeStatistics(invalid),{code:'INVALID_CONTEXT_SERIES'});
});

test('response rejected before body reading is still cancelled, and identity mismatches are rejected',async()=>{
 let cancelled=false;await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/html'}})}),{code:'INVALID_JSON_RESPONSE'});assert.equal(cancelled,true);
 const wrong=fixture();wrong.instrument.symbol='SOXX';await assert.rejects(queryMarketContext({symbol:'NVDA'},{apiKey:KEY,fetchImpl:async()=>response(wrong)}),{code:'IDENTITY_MISMATCH'});
});

async function invoke(baseUrl,args){
 const client=fileURLToPath(new URL('../../scripts/market-context-client.mjs',import.meta.url));
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[client,'NVDA',...args],{env:{...process.env,LLM_API_KEY:KEY,LLM_API_BASE_URL:baseUrl},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
}
test('CLI complete JSON round trip, separate stats and secure output refuse existing files and symlinks',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'qqqsp-client-'));const requests=[];
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(fixture()));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl='http://127.0.0.1:'+server.address().port;
 try{
  const stdout=await invoke(baseUrl,['--stats','--include','quote,daily','--daily-bars','3','--sample-days','2','--wait-ms','500']);assert.equal(stdout.code,0,stdout.stderr);assert.deepEqual(JSON.parse(stdout.stdout),fixture());assert.equal(JSON.parse(stdout.stderr).daily.mean_close,105);assert.deepEqual(requests[0],{symbol:'NVDA',include:['quote','daily'],daily_bar_count:3,sample_trading_days:2,max_wait_ms:500});
  const output=path.join(folder,'data.json');const saved=await invoke(baseUrl,['--output',output,'--stats']);assert.equal(saved.code,0,saved.stderr);assert.equal(saved.stdout,'');assert.deepEqual(JSON.parse(await readFile(output,'utf8')),fixture());assert.equal((await stat(output)).mode&0o777,0o600);
  const exists=await invoke(baseUrl,['--output',output]);assert.equal(exists.code,1);assert.match(exists.stderr,/OUTPUT_EXISTS/);
  const target=path.join(folder,'private.env');await writeFile(target,'private=unchanged');const link=path.join(folder,'link.json');await symlink(target,link);const symlinked=await invoke(baseUrl,['--output',link]);assert.equal(symlinked.code,1);assert.equal(await readFile(target,'utf8'),'private=unchanged');
  const secret=await invoke(baseUrl,['--output',target]);assert.equal(secret.code,1);assert.match(secret.stderr,/UNSAFE_OUTPUT_PATH/);for(const result of [saved,exists,symlinked,secret])assert.ok(!result.stderr.includes(KEY));
 }finally{await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

test('CLI keeps complete unavailable JSON while returning a retryable nonzero exit status',async()=>{
 const value=fixture();value.status='unavailable';value.sections={};const server=createServer((req,res)=>{req.resume();res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify(value));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await invoke('http://127.0.0.1:'+server.address().port,[]);assert.equal(result.code,2);assert.deepEqual(JSON.parse(result.stdout),value);assert.equal(result.stderr,'');}finally{await new Promise(resolve=>server.close(resolve));}
});

test('statistics retain non-ready daily status and disclose any included unclosed period',()=>{
 for(const periodState of ['open','unclosed']){
  const value=fixture();value.sections.daily.status='partial';value.sections.daily.columns.push('period_state');value.sections.daily.column_units.push('period_state');value.sections.daily.rows.forEach((row,index)=>row.push(index===2?periodState:'closed'));
  const result=computeStatistics(value);assert.equal(result.daily.mean_close,105);assert.ok(Math.abs(result.daily.close_return_percent-10)<1e-10);assert.ok(result.daily.warnings.includes('daily_status_partial'));assert.ok(result.daily.warnings.includes('include_unclosed_daily_period'));
 }
 const unavailable=fixture();unavailable.sections.daily.status='unavailable';unavailable.sections.daily.rows=[];assert.ok(computeStatistics(unavailable).daily.warnings.includes('daily_status_unavailable'));
 const closed=fixture();closed.sections.daily.columns.push('period_state');closed.sections.daily.column_units.push('period_state');closed.sections.daily.rows.forEach(row=>row.push('closed'));assert.ok(!computeStatistics(closed).daily.warnings.includes('include_unclosed_daily_period'));
});
