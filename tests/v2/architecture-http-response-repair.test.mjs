import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHttp} from '../../lib/http.js';
import {createTelemetry} from '../../log.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');}
async function fixture(t,{env={},bytes=65536,publicPath,deps={}}={}){
  const pending=[],requests=[];
  t.mock.method(zlib,'gzip',(raw,callback)=>pending.push({raw,callback}));
  const service=createHttp({getCachedQuote:symbol=>({symbol,price:100,currency:'USD',padding:'x'.repeat(bytes)}),...deps},
    {env:{HOST:'127.0.0.1',PORT:0,HTTP_RESPONSE_MAX:1,HTTP_RESPONSE_MAX_BYTES:262144,HTTP_RESPONSE_TIMEOUT_MS:1000,...env},publicPath,monitorCore:false,telemetry:createTelemetry()});
  service.startListen();await once(service.httpServer,'listening');
  const request=(method='GET',path='/api/market?symbols=QQQ',headers={})=>{
    let client;
    const result=new Promise(resolve=>{
      client=http.request({host:'127.0.0.1',port:service.httpServer.address().port,path,method,agent:false,headers:{'accept-encoding':'gzip',...headers}},res=>{
        const chunks=[];res.on('data',p=>chunks.push(p));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,body:bytes.toString(),bytes});});res.on('error',()=>resolve({status:0}));
      });client.on('error',()=>resolve({status:0}));client.end();
    });requests.push(client);return {client,result};
  };
  t.after(async()=>{for(const job of pending.splice(0))job.callback(new Error('fixture release'));for(const req of requests)req.destroy();service.httpServer.closeAllConnections();await service.stop();});
  return {service,pending,request};
}

test('response stage rejects excess compression after the business lane is free',async t=>{
  const f=await fixture(t);const first=f.request();await until(()=>f.pending.length===1);
  await until(()=>f.service.diagnostics().admission.quotes.active===0);
  let secondResult;const second=f.request();second.result.then(value=>secondResult=value);
  await until(()=>f.pending.length===2||secondResult);
  assert.equal(f.pending.length,1,'response capacity must outlive the handler');
  assert.equal(secondResult.status,503);assert.match(secondResult.body,/RESPONSE_CAPACITY_EXCEEDED/);
  assert.equal(f.service.diagnostics().responses.active,1);
  f.pending.shift().callback(new Error('identity fallback'));assert.equal((await first.result).status,200);
  await until(()=>f.service.diagnostics().responses.active===0);
});

test('disconnect retains compressor ownership until its real callback settles',async t=>{
  const f=await fixture(t);const first=f.request();await until(()=>f.pending.length===1);first.client.destroy();await first.result;await turn();
  let secondResult;const second=f.request();second.result.then(value=>secondResult=value);
  await until(()=>f.pending.length===2||secondResult);
  assert.equal(f.pending.length,1,'disconnect must not manufacture another compressor slot');assert.equal(secondResult.status,503);
  assert.equal(f.service.diagnostics().responses.compressing,1);
  f.pending.shift().callback(new Error('settled'));await until(()=>f.service.diagnostics().responses.active===0);
  assert.equal(f.service.diagnostics().responses.reservedBytes,0);
});

test('oversized response is rejected before starting compression',async t=>{
  const f=await fixture(t,{env:{HTTP_RESPONSE_MAX_BYTES:4096},bytes:8192});
  let reply;f.request().result.then(value=>reply=value);await until(()=>f.pending.length||reply);
  assert.equal(f.pending.length,0);assert.equal(reply.status,503);assert.match(reply.body,/RESPONSE_CAPACITY_EXCEEDED/);
});

test('response deadline disconnects the client but holds a pending compressor reservation',async t=>{
  const f=await fixture(t,{env:{HTTP_RESPONSE_TIMEOUT_MS:25}}),first=f.request();await until(()=>f.pending.length===1);
  let reply;first.result.then(value=>reply=value);await until(()=>reply||f.service.diagnostics().responses?.timeouts);
  assert.equal(reply?.status,0);assert.equal(f.service.diagnostics().responses.active,1);assert.equal(f.service.diagnostics().responses.timeouts,1);
  f.pending.shift().callback(new Error('settled'));await until(()=>f.service.diagnostics().responses.active===0);
});

test('HEAD has no compression body and gzip failure releases the response budget',async t=>{
  const f=await fixture(t);const head=await f.request('HEAD').result;assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(f.pending.length,0);
  const first=f.request();await until(()=>f.pending.length===1);f.pending.shift().callback(new Error('gzip failed'));
  const response=await first.result;assert.equal(response.status,200);assert.equal(response.headers['content-encoding'],undefined);assert.equal(JSON.parse(response.body)[0].price,100);
  await until(()=>f.service.diagnostics().responses?.active===0);
});

test('precompressed static assets use the response budget without a second gzip pass',async t=>{
  const f=await fixture(t),result=await f.request('GET','/index.html').result;
  assert.equal(result.status,200);assert.equal(result.headers['content-encoding'],'gzip');assert.match(zlib.gunzipSync(result.bytes).toString(),/<html/i);assert.equal(f.pending.length,0);
  await until(()=>f.service.diagnostics().responses.active===0);
});

test('stopping HTTP closes response clients without releasing a still active compressor',async t=>{
  const f=await fixture(t),request=f.request();await until(()=>f.pending.length===1);
  await f.service.stop();assert.equal((await request.result).status,0);
  assert.equal(f.service.diagnostics().responses.closed,true);assert.equal(f.service.diagnostics().responses.compressing,1);
  f.pending.shift().callback(new Error('settled after shutdown'));await until(()=>f.service.diagnostics().responses.active===0);
});

test('response admission failures retain authorized CORS response metadata',async t=>{
  const origin='https://panel.example',key='response-budget-fixture-token-0000000000';
  const f=await fixture(t,{env:{HTTP_RESPONSE_MAX_BYTES:4096,PUBLIC_ORIGIN:origin,LLM_API_KEY:key},deps:{marketContext:{query:async()=>({schema_version:1,status:'complete',padding:'x'.repeat(8192)})}}});
  const response=await f.request('GET','/api/v1/market-context?symbol=NVDA&include=quote&max_wait_ms=0',{origin,authorization:'Bearer '+key}).result;
  assert.equal(response.status,503);assert.equal(response.headers['access-control-allow-origin'],origin);assert.match(response.headers.vary,/Authorization/);assert.match(response.headers['access-control-expose-headers'],/X-Request-Id/);assert.equal(response.headers['content-encoding'],undefined);assert.equal(response.headers.etag,undefined);
  const body=JSON.parse(response.body);assert.equal(body.schema_version,1);assert.equal(body.request_id,response.headers['x-request-id']);assert.equal(body.status,'unavailable');assert.equal(body.error.code,'RESPONSE_CAPACITY_EXCEEDED');
});

test('different cold static assets without precompression share the response compression cap',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-response-budget-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  await Promise.all(['a.js','b.js'].map(file=>fs.writeFile(path.join(directory,file),'x'.repeat(8192))));
  const f=await fixture(t,{publicPath:directory});f.request('GET','/a.js');await until(()=>f.pending.length===1);
  let second;f.request('GET','/b.js').result.then(value=>second=value);await until(()=>second||f.pending.length===2);
  assert.equal(f.pending.length,1);assert.equal(second.status,503);assert.equal(f.service.diagnostics().responses.compressing,1);
});

test('versioned auxiliary and detail routes keep their error envelope under response saturation',async t=>{
  const key='response-budget-fixture-token-0000000000';
  const f=await fixture(t,{env:{LLM_API_KEY:key},deps:{marketContext:{query:async()=>({status:'unavailable'})}}});
  f.request();await until(()=>f.pending.length===1);
  for(const [path,version] of [['/api/v1/capabilities',1],['/api/v2/market-detail',2]]){
    const response=await f.request('GET',path,{authorization:'Bearer '+key}).result,body=JSON.parse(response.body);
    assert.equal(response.status,503);assert.equal(body.schema_version,version);assert.equal(body.request_id,response.headers['x-request-id']);assert.equal(body.status,'unavailable');assert.equal(body.error.code,'RESPONSE_CAPACITY_EXCEEDED');
  }
});
