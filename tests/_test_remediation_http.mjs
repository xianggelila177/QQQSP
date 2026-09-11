import assert from 'node:assert/strict';
import http from 'node:http';
process.env.PORT = '0';
process.env.SYMBOLS = 'QQQ,SPY';
process.env.HTTP_REQUEST_DEADLINE_MS = '1000';
process.env.LOG_LEVEL = 'error';
const H = await import('../lib/http.js');
const quote = symbol => ({symbol,price:100,quoteAt:Date.now(),fetchedAt:Date.now(),marketState:'REGULAR'});
H.initHttp({getCachedQuote:quote,getMacro:async()=>({items:[]}),cacheSizes:()=>({}),newsCache:new Map(),cacheSet:(m,k,v)=>m.set(k,v),requestNews:symbol=>symbol==='SLOW'?new Promise(()=>{}):Promise.resolve({items:[{title:symbol}],updatedAt:1,stale:false})});
H.startListen();
while (!H.httpServer.address()) await new Promise(resolve=>setTimeout(resolve,1));
const get = path => new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:H.httpServer.address().port,path},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));});req.on('error',reject);});
try {
  const news=await get('/api/news?symbols=QQQ,SPY,SLOW');
  assert.equal(news.body.QQQ[0]?.title,'QQQ','completed news survives a sibling deadline');
  assert.equal(news.body.SPY[0]?.title,'SPY');
  assert.deepEqual(news.body.SLOW,[]);
  const meta=JSON.parse(Buffer.from(news.headers['x-news-meta'],'base64url'));
  assert.equal(meta.QQQ.stale,false); assert.equal(meta.SLOW.stale,true);
  const ready=await get('/readyz');
  assert.equal(ready.body.services['realtime-snapshots'].host,'polling.finance.naver.com');
  console.log('PASS completed news survives partial timeout and primary provider is monitored');
} finally {
  if(H.stop) await H.stop(); else await new Promise(resolve=>H.httpServer.close(resolve));
}
