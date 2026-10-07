import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {Writable} from 'node:stream';
import {createStaticService} from '../../lib/http-response.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');}
class Response extends Writable {
  constructor(){super();this.parts=[];this.headers={};}
  _write(chunk,encoding,done){this.parts.push(Buffer.from(chunk));done();}
  writeHead(status,headers){this.status=status;this.headers=headers;}
  body(){return Buffer.concat(this.parts);}
}
async function fixture(t,options={}){
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'qqqsp-static-loading-'));
  const service=createStaticService(options);
  t.after(async()=>{service.close?.();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.promises.rm(directory,{recursive:true,force:true});});
  const file=name=>path.join(directory,name);
  const serve=(name,headers={},res=new Response())=>({res,promise:service.serve({method:'GET',headers},res,file(name),'.js','no-cache')});
  return {service,file,serve,write:(name,text)=>fs.promises.writeFile(file(name),text)};
}
function holdReads(t,target){
  const entered=deferred(),release=deferred();let count=0;
  for(const method of ['readFile','open']){
    const original=fs.promises[method];
    t.mock.method(fs.promises,method,async function(file,...args){
      if(String(file)===target){count++;entered.resolve();await release.promise;}
      return original.call(this,file,...args);
    });
  }
  t.after(()=>release.resolve());
  return {entered:entered.promise,release:release.resolve,count:()=>count};
}

test('concurrent cold static readers share one physical load and preserve warm reuse',async t=>{
  const f=await fixture(t),body='x'.repeat(65536);await f.write('a.js',body);
  const held=holdReads(t,f.file('a.js'));
  const requests=Array.from({length:12},()=>f.serve('a.js'));
  await held.entered;for(let i=0;i<10;i++)await turn();held.release();
  await Promise.all(requests.map(r=>r.promise));
  assert.equal(held.count(),1,'one load must serve all same-file readers');
  for(const r of requests){assert.equal(r.res.status,200);assert.equal(r.res.body().toString(),body);}
  await f.serve('a.js').promise;assert.equal(held.count(),1);
});

test('a departing reader does not cancel another reader sharing the load',async t=>{
  const f=await fixture(t);await f.write('a.js','survivor');const held=holdReads(t,f.file('a.js'));
  const first=f.serve('a.js'),second=f.serve('a.js');
  const joined=Promise.allSettled([first.promise,second.promise]);await held.entered;
  first.res.destroy();await turn();held.release();await joined;
  assert.equal(second.res.body().toString(),'survivor');assert.equal(held.count(),1);
});

test('distinct cold files are bounded before reading and retry after load completion',async t=>{
  const f=await fixture(t,{maxActive:1});await f.write('a.js','a');await f.write('b.js','b');
  const held=holdReads(t,f.file('a.js')),first=f.serve('a.js');await held.entered;
  try{await assert.rejects(f.serve('b.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});}finally{held.release();await first.promise;}
  const retry=f.serve('b.js');await retry.promise;assert.equal(retry.res.body().toString(),'b');
});

test('oversized static input is rejected before file content allocation',async t=>{
  const f=await fixture(t,{maxBytes:4096});await f.write('a.js','x'.repeat(8192));
  let reads=0;const original=fs.promises.open;
  t.mock.method(fs.promises,'open',async function(...args){reads++;return original.apply(this,args);});
  await assert.rejects(f.serve('a.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});
  assert.equal(reads,0);assert.equal(f.service.cache.size,0);
});

test('file replacement during a shared load retries instead of caching mixed versions',async t=>{
  const f=await fixture(t);await f.write('a.js','old');const held=holdReads(t,f.file('a.js'));
  const pending=f.serve('a.js');await held.entered;await f.write('a.js','replacement-content');held.release();
  await pending.promise;assert.equal(pending.res.body().toString(),'replacement-content');
  assert.equal(held.count(),2,'the first reader must validate and retry the changed version');
  const again=f.serve('a.js');await again.promise;assert.equal(again.res.body().toString(),'replacement-content');
  assert.equal(held.count(),2,'changed load is retried once, then the correct version stays cached');
});

test('static cache has a byte bound and rejected loads do not evict useful entries',async t=>{
  const f=await fixture(t,{maxBytes:4096,maxCacheBytes:1500});await f.write('a.js','a'.repeat(1000));await f.write('b.js','b'.repeat(1000));
  await f.serve('a.js').promise;await f.serve('b.js').promise;
  assert.equal(f.service.cache.size,1);assert.ok(f.service.cache.has(f.file('b.js')));
  await f.write('huge.js','x'.repeat(8192));await assert.rejects(f.serve('huge.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});
  assert.ok(f.service.cache.has(f.file('b.js')));
  assert.equal(f.service.diagnostics().cacheBytes,1000);assert.equal(f.service.diagnostics().reservedBytes,0);
});

test('precompressed files retain encoding selection and HEAD has no body',async t=>{
  const f=await fixture(t),body=Buffer.from('const fixture="'+'x'.repeat(4096)+'";');
  await f.write('a.js',body);await f.write('a.js.gz',zlib.gzipSync(body));await f.write('a.js.br',zlib.brotliCompressSync(body));
  const gz=f.serve('a.js',{'accept-encoding':'gzip'});await gz.promise;assert.equal(gz.res.headers['Content-Encoding'],'gzip');assert.deepEqual(zlib.gunzipSync(gz.res.body()),body);
  const br=f.serve('a.js',{'accept-encoding':'br, gzip'});await br.promise;assert.equal(br.res.headers['Content-Encoding'],'br');assert.deepEqual(zlib.brotliDecompressSync(br.res.body()),body);
  const res=new Response();await f.service.serve({method:'HEAD',headers:{}},res,f.file('a.js'),'.js','no-cache');assert.equal(res.status,200);assert.equal(res.body().length,0);
});

test('cancelled readers release promptly but a pending filesystem operation keeps its reservation',async t=>{
  const f=await fixture(t,{maxActive:1,maxBytes:4096});await f.write('a.js','a'.repeat(3000));await f.write('b.js','b');
  const held=holdReads(t,f.file('a.js')),request=f.serve('a.js');
  const cancelled=assert.rejects(request.promise,{code:'REQUEST_CANCELLED'});await held.entered;
  request.res.destroy();await cancelled;
  assert.equal(f.service.diagnostics().readers,0);assert.equal(f.service.diagnostics().reservedBytes,3000);
  await assert.rejects(f.serve('b.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});
  held.release();await until(()=>f.service.diagnostics().active===0);
  assert.equal(f.service.diagnostics().reservedBytes,0);assert.equal(f.service.cache.size,0);
  const retry=f.serve('a.js');await retry.promise;assert.equal(retry.res.body().length,3000);
});

test('aggregate loading bytes are bounded independently of the number of load slots',async t=>{
  const f=await fixture(t,{maxActive:2,maxBytes:4096});await f.write('a.js','a'.repeat(3000));await f.write('b.js','b'.repeat(3000));
  const held=holdReads(t,f.file('a.js')),request=f.serve('a.js');await held.entered;
  try{await assert.rejects(f.serve('b.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});assert.equal(f.service.diagnostics().reservedBytes,3000);}
  finally{held.release();await request.promise;}
  await f.serve('b.js').promise;assert.equal(f.service.diagnostics().reservedBytes,0);
});

test('static timeout and stop reject readers without publishing an unfinished load',async t=>{
  const f=await fixture(t,{maxActive:1,timeoutMs:25});await f.write('a.js','a');
  const held=holdReads(t,f.file('a.js')),request=f.serve('a.js');
  const timedOut=assert.rejects(request.promise,{code:'STATIC_TIMEOUT'});await held.entered;
  // A referenced timer keeps this artificial held-I/O fixture alive.
  await new Promise(resolve=>setTimeout(resolve,40));await timedOut;
  assert.equal(f.service.diagnostics().active,1);assert.equal(f.service.cache.size,0);
  f.service.close();await assert.rejects(f.serve('a.js').promise,{code:'STOPPED'});
  f.service.reopen();await assert.rejects(f.serve('a.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});
  held.release();await until(()=>f.service.diagnostics().active===0);
  await f.serve('a.js').promise;assert.equal(f.service.diagnostics().reservedBytes,0);
});

test('failed loads clear singleflight state and all readers can retry',async t=>{
  const f=await fixture(t,{maxReaders:2});await f.write('a.js','ok');
  const held=holdReads(t,f.file('a.js')),first=f.serve('a.js'),second=f.serve('a.js');
  const outcomes=Promise.allSettled([first.promise,second.promise]);await held.entered;
  await assert.rejects(f.serve('a.js').promise,{code:'STATIC_CAPACITY_EXCEEDED'});
  await fs.promises.unlink(f.file('a.js'));held.release();
  assert.ok((await outcomes).every(r=>r.status==='rejected'&&r.reason.code==='ENOENT'));
  assert.equal(f.service.diagnostics().active,0);assert.equal(f.service.diagnostics().reservedBytes,0);
  await f.write('a.js','retry');const retry=f.serve('a.js');await retry.promise;assert.equal(retry.res.body().toString(),'retry');
});

test('static compression is bound to raw content, including stale or oversized decoded sidecars',async t=>{
  const f=await fixture(t);await f.write('a.js','new');
  await f.write('a.js.gz',zlib.gzipSync('old'));await f.write('a.js.br',zlib.brotliCompressSync(Buffer.from('old')));
  const gzip=f.serve('a.js',{'accept-encoding':'gzip'});await gzip.promise;
  assert.equal((gzip.res.headers['Content-Encoding']==='gzip'?zlib.gunzipSync(gzip.res.body()):gzip.res.body()).toString(),'new');
  const br=f.serve('a.js',{'accept-encoding':'br'});await br.promise;
  assert.equal((br.res.headers['Content-Encoding']==='br'?zlib.brotliDecompressSync(br.res.body()):br.res.body()).toString(),'new');
  assert.equal(f.service.cache.get(f.file('a.js')).gz,null);assert.equal(f.service.cache.get(f.file('a.js')).br,null);
  await f.write('b.js','small');await f.write('b.js.gz',zlib.gzipSync('x'.repeat(100000)));
  const bounded=f.serve('b.js',{'accept-encoding':'gzip'});await bounded.promise;
  assert.equal(bounded.res.body().toString(),'small');assert.equal(f.service.diagnostics().reservedBytes,0);
});
