import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHttp} from '../../lib/http.js';

test('worker update URLs never receive immutable caching, including existing versioned registrations',async t=>{
  const layer=createHttp({cacheSizes:()=>({})},{env:{PORT:0},monitorCore:false});
  layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());
  const base='http://127.0.0.1:'+layer.httpServer.address().port;
  for(const path of ['/sw.js','/sw.js?v=111','/sw.js?v=113','/sw.js?v=999','/update.html','/update.js?v=111']){
    const response=await fetch(base+path);
    assert.equal(response.status,200,path);
    assert.equal(response.headers.get('cache-control'),'no-store, max-age=0',path);
    const etag=response.headers.get('etag');await response.arrayBuffer();
    if(etag){
      const conditional=await fetch(base+path,{headers:{'If-None-Match':etag}});
      assert.equal(conditional.status,304);
      assert.equal(conditional.headers.get('cache-control'),'no-store, max-age=0');
    }
  }
  const version=fs.readFileSync(new URL('../../VERSION',import.meta.url),'utf8').trim();
  const asset=await fetch(base+'/panel.bundle.js?v='+version);
  assert.equal(asset.headers.get('cache-control'),'public, max-age=31536000, immutable');await asset.arrayBuffer();
});

test('worker version handshake returns the installed version without modifying user data',()=>{
  const source=fs.readFileSync(new URL('../../public/sw.js',import.meta.url),'utf8');
  const handlers={},messages=[];
  vm.runInNewContext(source,{self:{addEventListener:(event,listener)=>handlers[event]=listener}});
  handlers.message({data:{type:'QQQSP_GET_VERSION'},ports:[{postMessage:value=>messages.push(value)}]});
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{type:'QQQSP_VERSION',version:source.match(/const VERSION = 'v(\d+)'/)[1]}]);
  handlers.message({data:{type:'unknown'},ports:[{postMessage:()=>assert.fail('Unknown message should be ignored')}]});
  handlers.message({data:{type:'QQQSP_GET_VERSION'}});
});
