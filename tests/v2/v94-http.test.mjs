import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter,once} from 'node:events';
import {createApiKeys,requireScopes} from '../../lib/api-keys.js';
import {createContextLimiter} from '../../lib/api-rate-limit.js';
import {createMarketContextHttp} from '../../lib/market-context-http.js';
import {createKeyAdminHandler} from '../../lib/api-key-admin.js';
import {createApiQuoteStream} from '../../lib/api-quote-stream.js';
import {createStreamBudget} from '../../lib/stream-budget.js';
import {createMarketAuxRoutes} from '../../lib/api-market-routes.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {queryMarketApi} from '../../scripts/market-api-client.mjs';
const key='fixture_readonly_'.repeat(3),admin='fixture_admin_'.repeat(3),now=Date.parse('2026-09-21T16:00Z');
const request=k=>({headers:{authorization:'Bearer '+k},rawHeaders:['Authorization','Bearer '+k]});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-v94-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'api-keys.json');}
function context(query,id='test'){
 const quote={symbol:query.symbol,price:100,currency:'USD',instrumentType:'EQUITY',priceSession:'REGULAR',quoteAt:now,sourceCheckedAt:now,src:'fixture'};
 return buildMarketContext({query,requestId:id,generatedAt:now,quote,daily:{symbol:query.symbol,currency:'USD',source:'fixture',sourceCheckedAt:now,bars:[{t:Date.parse('2026-09-18T00:00Z')/1000,sessionDate:'2026-09-18',o:99,h:101,l:98,c:100,v:10}]}});
}
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));return 'http://127.0.0.1:'+s.address().port;}
const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
test('v94 quota charges every batch symbol atomically while burst is per envelope',()=>{
 let clock=0;const q=createContextLimiter({now:()=>clock,wallNow:()=>now+clock});let a=q.consume(10,'a');assert.equal(a.remaining,10);a=q.consume(9,'a');assert.equal(a.remaining,1);assert.equal(q.consume(2,'a').ok,false);assert.equal(q.consume(1,'a').remaining,0);assert.equal(q.consume(1,'b').remaining,19);clock=60001;assert.equal(q.consume(10,'a').remaining,10);
});
test('v94 key creation stores digests only; restart, scoped auth and family revocation work',async t=>{
 const file=await temp(t);const keys=createApiKeys({apiKey:key,file,now:()=>now}),made=await keys.mutate({action:'create',label:'研究助手',scopes:['quote-only']});assert.match(made.secret,/^[\w-]{32,}$/);const raw=await fs.readFile(file,'utf8');assert.ok(!raw.includes(made.secret));assert.ok(!JSON.stringify(keys.list()).includes('digest'));assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const restored=createApiKeys({apiKey:key,file,now:()=>now}),principal=restored.authenticate(request(made.secret));requireScopes(principal,['quote','fundamentals']);assert.throws(()=>requireScopes(principal,['daily']),{code:'INSUFFICIENT_SCOPE'});assert.throws(()=>requireScopes(principal,['macro']),{code:'INSUFFICIENT_SCOPE'});
 await restored.mutate({action:'revoke',id:made.id});assert.throws(()=>restored.authenticate(request(made.secret)),{code:'UNAUTHORIZED'});
});
test('v94 rotation grants exactly 24 hours, shares rate family, then KEY_ROTATED',async t=>{
 let at=now;const keys=createApiKeys({apiKey:key,file:await temp(t),now:()=>at});const next=await keys.mutate({action:'rotate',id:'legacy'}),old=keys.authenticate(request(key)),fresh=keys.authenticate(request(next.secret));assert.equal(old.status,'rotating');assert.equal(old.family,fresh.family);assert.equal(old.expiresAt,now+86400000);at=now+86400000-1;assert.equal(keys.authenticate(request(key)).status,'rotating');at++;assert.throws(()=>keys.authenticate(request(key)),{code:'KEY_ROTATED'});assert.equal(keys.authenticate(request(next.secret)).status,'active');
 await keys.mutate({action:'revoke',id:'legacy'});assert.throws(()=>keys.authenticate(request(next.secret)),{code:'UNAUTHORIZED'});
});
test('v94 corrupt key stores fail closed and failed atomic writes do not mutate memory',async t=>{
 const file=await temp(t);await fs.writeFile(file,'{"schemaVersion":1,"keys":[{"digest":"bad"}]}');assert.throws(()=>createApiKeys({file}),{code:'KEY_STORE_INVALID'});
 const blocked=path.join(path.dirname(file),'blocked');const keys=createApiKeys({apiKey:key,file:path.join(blocked,'keys.json')});await fs.writeFile(blocked,'not a directory');await assert.rejects(keys.mutate({action:'create',label:'test',scopes:['history']}),{code:'KEY_STORE_WRITE_FAILED'});assert.equal(keys.list().keys.length,1);
});
test('v94 store creation rejects invalid scopes/unknown fields/unknown actions and duplicate authorization',async t=>{
 const keys=createApiKeys({apiKey:key,file:await temp(t)});
 for(const x of [{action:'create',label:'x',scopes:[]},{action:'create',label:'x',scopes:['admin']},{action:'create',label:'x',scopes:['history','history']},{action:'create',label:'x',scopes:['history'],token:'bad'},{action:'forget',id:'legacy'}])await assert.rejects(keys.mutate(x),{code:'BAD_KEY_QUERY'});
 assert.throws(()=>keys.authenticate({...request(key),rawHeaders:['Authorization','Bearer '+key,'authorization','Bearer '+key]}),{code:'UNAUTHORIZED'});
});
test('v94 GET/HEAD conditional responses authorize first; POST returns 412, never 304',async t=>{
 let calls=0;const handler=createMarketContextHttp({apiKey:key,allowGet:true,now:()=>now,service:{query:async(q,o)=>{calls++;return context(q,o.requestId);}}}),base=await server(t,handler),url=base+'?symbol=NVDA&include=quote&max_wait_ms=0';
 const first=await fetch(url,{headers});assert.equal(first.status,200);assert.equal(first.headers.get('x-ratelimit-limit'),'20');assert.equal(first.headers.get('x-ratelimit-remaining'),'19');assert.match(first.headers.get('vary'),/Authorization/);const tag=first.headers.get('etag');await first.text();
 const cached=await fetch(url,{headers:{...headers,'If-None-Match':tag}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');assert.equal(cached.headers.get('x-ratelimit-remaining'),'18');
 const bad=await fetch(url,{headers:{'If-None-Match':tag}});assert.equal(bad.status,401);assert.equal(calls,2);
 const post=await fetch(base,{method:'POST',headers:{...headers,'If-None-Match':'*'},body:'{"symbol":"NVDA","include":["quote"]}'});assert.equal(post.status,412);assert.equal((await post.json()).error.code,'PRECONDITION_FAILED');
});
test('v94 HEAD computes headers with an empty body, invalid UTF8 cannot reach service',async t=>{
 let calls=0;const base=await server(t,createMarketContextHttp({apiKey:key,allowGet:true,service:{query:async q=>{calls++;return context(q);}}}));
 const r=await fetch(base+'?symbol=NVDA&include=quote',{method:'HEAD',headers});assert.equal(r.status,200);assert.ok(r.headers.get('etag'));assert.equal(await r.text(),'');
 const bad=await fetch(base,{method:'POST',headers,body:Buffer.from([0xff])});assert.equal(bad.status,400);assert.equal((await bad.json()).error.code,'BAD_JSON');assert.equal(calls,1);
});
test('v94 CSV HTTP representation and advanced client preserve metadata and refuse redirects',async t=>{
 const base=await server(t,createMarketContextHttp({apiKey:key,allowGet:true,service:{query:async q=>context(q)}}));const result=await queryMarketApi({symbol:'NVDA',include:['daily'],daily_bar_count:1,format:'csv'},{apiKey:key,baseUrl:base});assert.ok(result.csv.startsWith('"time_ms"'));assert.equal(result.metadata.instrument.symbol,'NVDA');assert.equal(result.metadata.metadata.columns[2],'open');
 await assert.rejects(queryMarketApi({symbol:'NVDA'},{apiKey:key,baseUrl:'http://public.example'}),{code:'INVALID_BASE_URL'});
 await assert.rejects(queryMarketApi({symbol:'NVDA'},{apiKey:key,baseUrl:base,fetchImpl:async()=>new Response('',{status:302,headers:{Location:'https://elsewhere'}})}),{code:'REDIRECT_REJECTED'});
});
test('v94 batch HTTP charges three units, preserves each item and rejects cross-scope work',async t=>{
 let calls=0;const service={query:async(q,o)=>{calls++;const {symbols,...single}=q;return {schema_version:1,request_id:o.requestId,generated_at_ms:now,status:'complete',coverage:{requested_symbols:symbols.length,returned_symbols:symbols.length,quota_cost:symbols.length},results:symbols.map(symbol=>context({...single,symbol}))};}};
 const base=await server(t,createMarketContextHttp({apiKey:key,service}));const result=await queryMarketApi({symbols:['NVDA','SPY','QQQ'],include:['quote']},{apiKey:key,baseUrl:base});assert.equal(result.headers['x-ratelimit-remaining'],'17');assert.equal(result.data.results.length,3);
 const r=await fetch(base,{method:'POST',headers,body:'{"symbols":["NVDA"],"include":["daily"]}'});assert.equal(r.status,400);assert.equal(calls,1);
});
test('v94 scopes and rotation headers are enforced before work, without returning a secret',async t=>{
 const keys=createApiKeys({apiKey:key,file:await temp(t),now:()=>now}),quote=await keys.mutate({action:'create',label:'quote',scopes:['quote-only']});let calls=0;
 const base=await server(t,createMarketContextHttp({keys,service:{query:async q=>{calls++;return context(q);}}}));const requestHeaders={...headers,Authorization:'Bearer '+quote.secret};
 const r=await fetch(base,{method:'POST',headers:requestHeaders,body:'{"symbol":"NVDA","include":["daily"]}'});assert.equal(r.status,403);assert.equal(calls,0);
 await keys.mutate({action:'rotate',id:quote.id});const good=await fetch(base,{method:'POST',headers:requestHeaders,body:'{"symbol":"NVDA","include":["quote"]}'});assert.equal(good.status,200);assert.equal(good.headers.get('x-api-key-status'),'rotating');assert.ok(good.headers.get('x-key-expires-at'));assert.ok(!(await good.text()).includes(quote.secret));
});
test('v94 private admin API requires STATS_TOKEN even on loopback; read-only key cannot manage',async t=>{
 const keys=createApiKeys({apiKey:key,file:await temp(t)});const base=await server(t,createKeyAdminHandler({keys,token:admin}));
 for(const h of [{},headers,{'X-Admin-Token':key}])assert.equal((await fetch(base,{headers:h})).status,403);
 const h={'X-Admin-Token':admin,'Content-Type':'application/json'},r=await fetch(base,{method:'POST',headers:h,body:'{"action":"create","label":"test","scopes":["history"]}'});assert.equal(r.status,200);const made=await r.json();assert.ok(made.secret);
 const list=await(await fetch(base,{headers:h})).json();assert.ok(!JSON.stringify(list).includes(made.secret));assert.ok(!JSON.stringify(list).includes('digest'));
 const badOrigin=await fetch(base,{method:'POST',headers:{...h,Origin:'https://evil.example'},body:'{"action":"revoke","id":"legacy"}'});assert.equal(badOrigin.status,403);
 const noConfig=await server(t,createKeyAdminHandler({keys}));assert.equal((await fetch(noConfig,{headers:h})).status,403);
});
test('v94 auxiliary routes share auth, scope and quota with market queries',async t=>{
 const keys=createApiKeys({apiKey:key,now:()=>now}),limiter=createContextLimiter(),aux=createMarketAuxRoutes({keys,limiter,now:()=>now,advanced:{capabilities:()=>({}),movers:async()=>({schema_version:1,status:'complete'})}});t.after(()=>aux.close());const base=await server(t,(req,res)=>aux.handle(req,res,new URL(req.url,'http://local')));
 assert.equal((await fetch(base+'/api/v1/market-status?exchange=us')).status,401);
 const r=await fetch(base+'/api/v1/market-status?exchange=US',{headers});assert.equal(r.status,200);assert.equal((await r.json()).session,'REGULAR');assert.equal(r.headers.get('x-ratelimit-remaining'),'19');
 const c=await fetch(base+'/api/v1/trading-calendar?exchange=us&start=2026-11-26&end=2026-11-27',{headers});assert.equal(c.status,200);const days=(await c.json()).days;assert.equal(days[0].holiday,true);assert.equal(days[1].half_day,true);
});
class Sink extends EventEmitter{constructor(){super();this.text='';this.destroyed=false;this.writableEnded=false;this.writableLength=0;this.block=false;}writeHead(status,h){this.status=status;this.headers=h;}write(t){this.text+=t;return !this.block;}end(){this.writableEnded=true;}destroy(){this.destroyed=true;this.emit('close');}}
function engine(){let listener;const e={watches:0,watch(){e.watches++;return()=>e.watches--;},poke(){},subscribe(fn){listener=fn;return()=>listener=null;},read(symbols){return symbols.map(symbol=>({symbol,price:100,currency:'USD',quoteAt:now,sourceCheckedAt:now,src:'fixture'}));},update(){listener?.(['NVDA']);}};return e;}
test('v94 quote stream is coalesced, bounded, closes on revoked credentials, and releases leases',async()=>{
 let valid=true;const e=engine(),keys={authenticate(){if(!valid)throw Object.assign(Error(),{code:'KEY_ROTATED'});}},stream=createApiQuoteStream({engine:e,keys,now:()=>now,tickMs:5,leaseMs:100});const res=new Sink();stream.open(request(key),res,['NVDA'],{family:'x'},{});assert.match(res.text,/event: quote/);assert.equal(e.watches,1);valid=false;await new Promise(r=>setTimeout(r,20));assert.match(res.text,/KEY_ROTATED/);assert.equal(e.watches,0);assert.equal(stream.diagnostics().connections,0);stream.close();
});
test('v94 streaming cannot exceed two connections per key and slow buffers are bounded',()=>{
 const e=engine(),stream=createApiQuoteStream({engine:e,keys:{authenticate(){}},now:()=>now}),a=new Sink(),b=new Sink();stream.open(request(key),a,['NVDA'],{family:'x'},{});stream.open(request(key),b,['NVDA'],{family:'x'},{});assert.throws(()=>stream.open(request(key),new Sink(),['NVDA'],{family:'x'},{}),{code:'CONTEXT_BUSY'});stream.close();assert.equal(e.watches,0);
 const budget=createStreamBudget({maxClientBytes:32}),sink=new Sink();budget.acquire(sink);assert.equal(budget.write(sink,'x'.repeat(33)),false);assert.equal(sink.destroyed,true);budget.release(sink);
});
test('v94 SSE leases end predictably and broken quote readers cannot crash a timer callback',async()=>{
 const e=engine(),s=createApiQuoteStream({engine:e,keys:{authenticate(){}},now:()=>now,tickMs:5,leaseMs:15}),r=new Sink();s.open(request(key),r,['NVDA'],{family:'x'},{});await new Promise(resolve=>setTimeout(resolve,30));assert.match(r.text,/LEASE_ENDED/);assert.equal(e.watches,0);s.close();
 e.read=()=>{throw Error('broken reader');};const broken=createApiQuoteStream({engine:e,keys:{authenticate(){}},now:()=>now}),res=new Sink();broken.open(request(key),res,['NVDA'],{family:'x'},{});assert.match(res.text,/source_error/);assert.equal(e.watches,0);broken.close();
});
test('v94 replacing or removing environment key cannot leave imported old key active',async t=>{
 const file=await temp(t),first=createApiKeys({apiKey:key,file});const managed=await first.mutate({action:'create',label:'history',scopes:['history']});
 const replacement='replacement_fixture_'.repeat(3),next=createApiKeys({apiKey:replacement,file});assert.throws(()=>next.authenticate(request(key)),{code:'UNAUTHORIZED'});assert.equal(next.authenticate(request(replacement)).id,'legacy');assert.equal(next.authenticate(request(managed.secret)).scopes[0],'history');
 const empty=createApiKeys({apiKey:'',file});assert.throws(()=>empty.authenticate(request(key)),{code:'UNAUTHORIZED'});assert.equal(empty.authenticate(request(managed.secret)).scopes[0],'history');
 const scoped=createApiKeys({apiKey:managed.secret,file});assert.throws(()=>requireScopes(scoped.authenticate(request(managed.secret)),['quote']),{code:'INSUFFICIENT_SCOPE'});
});
