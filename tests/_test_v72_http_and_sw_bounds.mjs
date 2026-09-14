import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {once} from 'node:events';
import {createHttp} from '../lib/http.js';
let calls=0;
const server=createHttp({getCachedQuote:async symbol=>(calls++,{symbol,price:1,quoteAt:Date.now()}),cacheSizes:()=>({})},{env:{...process.env,PORT:'0',LOG_LEVEL:'error'},monitorCore:false});
server.startListen();if(!server.httpServer.listening)await once(server.httpServer,'listening');
const base='http://127.0.0.1:'+server.httpServer.address().port;
try {
 const bad=await fetch(base+'/api/not-a-route?symbols=QQQ');assert.equal(bad.status,404);await bad.text();assert.equal(calls,0);
 for(const route of ['/api/market?symbols=QQQ','/api/quote?symbols=QQQ','/api/QQQ']) {
  const response=await fetch(base+route);assert.equal(response.status,200);assert.equal((await response.json())[0].symbol,'QQQ');
 }
} finally {await server.stop();}
const handlers={},store=new Map();
const cache={addAll:async()=>{},put:async(key,value)=>{store.set(key,value);}};
vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{
 self:{location:new URL('https://fixture.test/sw.js'),addEventListener:(k,v)=>handlers[k]=v},URL,Response,
 caches:{open:async()=>cache,match:async()=>undefined},fetch:async()=>new Response('asset')
});
async function dispatch(path) {
 let response;const waiting=[];
 handlers.fetch({request:{method:'GET',url:'https://fixture.test'+path},respondWith:p=>response=p,waitUntil:p=>waiting.push(p)});
 await response;await Promise.all(waiting);await Promise.resolve();
}
for(let i=0;i<500;i++)await dispatch('/style.css?request='+i);
assert.equal(store.size,1,'arbitrary query strings share one application cache key');
await dispatch('/healthz');await dispatch('/unknown.json');await dispatch('/api/market?t=1');assert.equal(store.size,1,'non-assets cannot be persisted');
console.log('v72 strict HTTP routing, legacy compatibility and bounded service-worker cache passed');
