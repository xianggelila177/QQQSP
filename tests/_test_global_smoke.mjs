import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {chartFailures,waitForCharts} from '../ops/chart-smoke.mjs';

const symbols=['QQQ','SPY','^FTSE'];
const quote=symbol=>({symbol,price:100,charts:{intraday:[{t:1,c:100}],daily30:[{t:1,c:100}]},slowFields:{intraday:{stale:false,updatedAt:1},daily30:{stale:false,updatedAt:1}}});
const run=(quotes,options={})=>waitForCharts('http://localhost:8567',{deadlineMs:0,fetchImpl:async()=>({ok:true,json:async()=>quotes}),...options});

test('FTSE is mandatory when requested even when US charts pass',async()=>{
 await assert.rejects(run(['QQQ','SPY'].map(quote),{symbols}),/\^FTSE:quote unavailable/);
});
test('all requested markets pass and duplicate symbols are removed',async()=>{
 const result=await run(symbols.map(quote),{symbols:[...symbols,'QQQ']});
 assert.deepEqual(result.symbols,symbols);
});
test('FTSE stale quote and missing/stale chart metadata fail',async()=>{
 for(const mutate of [q=>q.stale=true,q=>delete q.slowFields,q=>q.slowFields.intraday.stale=true]){
  const quotes=symbols.map(quote);mutate(quotes[2]);
  await assert.rejects(run(quotes,{symbols}),/\^FTSE:/);
 }
});
test('both chart families and strict quote checks remain required',()=>{
 for(const key of ['intraday','daily30']){
  const quotes=symbols.map(quote);quotes[2].charts[key]=[];
  assert.ok(chartFailures(quotes,symbols).includes('^FTSE:'+key+' unavailable'));
 }
 for(const property of ['error','pending','stale','staleInfo','recovery']){
  const quotes=symbols.map(quote);quotes[2][property]=true;
  assert.ok(chartFailures(quotes,symbols).includes('^FTSE:quote unavailable'));
 }
});
test('invalid symbols are rejected before network activity',async()=>{
 for(const invalid of [[],new Array(1),null,'QQQ',[1],['qqq'],[''],['A'.repeat(17)],['A B'],['A?X'],['A/B'],['A\n'],Array.from({length:13},(_,i)=>'A'+i)]){
  let called=false;
  await assert.rejects(run([],{symbols:invalid,fetchImpl:async()=>{called=true;throw Error('network');}}),/Invalid smoke-test symbols/);
  assert.equal(called,false);
 }
});
test('CLI accepts third argument, checks every requested symbol/period through history API, and rejects malformed symbols',async()=>{
 const seen=[];
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),symbol=url.searchParams.get('symbol'),period=url.searchParams.get('period');
  assert.equal(url.pathname,'/api/history');assert.ok(symbols.includes(symbol));assert.ok(['daily','weekly','monthly','yearly'].includes(period));seen.push(symbol+':'+period);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({symbol,period,status:'ready',source:'test',bars:[{t:1,o:100,h:105,l:99,c:101}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const script=fileURLToPath(new URL('../ops/chart-smoke.mjs',import.meta.url));
 try{
  const {stdout}=await promisify(execFile)(process.execPath,[script,'http://127.0.0.1:'+server.address().port,symbols.join(',')]);
  const result=JSON.parse(stdout);assert.equal(result.ok,true);assert.deepEqual([...new Set(result.checks.map(x=>x.symbol))],symbols);assert.equal(seen.length,12);assert.equal(new Set(seen).size,12);
  await assert.rejects(promisify(execFile)(process.execPath,[script,'http://127.0.0.1:1','QQQ,,SPY']),error=>error.code===1&&/无效证券代码/.test(error.stderr));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('defaults preserve QQQ and SPY',async()=>{
 assert.deepEqual((await run(['QQQ','SPY'].map(quote))).symbols,['QQQ','SPY']);
});
test('symbols are URLSearchParams encoded including ampersand',async()=>{
 let observed;
 const requested=['QQQ','^FTSE','M&M'];
 await run([],{symbols:requested,fetchImpl:async url=>{observed=url;return {ok:true,json:async()=>requested.map(quote)};}});
 assert.equal(observed.searchParams.get('symbols'),requested.join(','));
 assert.equal([...observed.searchParams].length,1);
 assert.match(observed.search,/%26/);
 assert.match(observed.search,/%5E/);
});
