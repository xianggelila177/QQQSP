import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import http from 'node:http';import zlib from 'node:zlib';
import {createHttp} from '../../lib/http.js';
const rawGet=(url,headers={})=>new Promise((resolve,reject)=>http.get(url,{headers},r=>{const data=[];r.on('data',d=>data.push(d));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(data)}));}).on('error',reject));
test('API shapes, symbol/search merge, news metadata and static encodings remain usable',async t=>{
 const layer=createHttp({getCachedQuote:async symbol=>({symbol,price:100,quoteAt:1000,currency:'USD',charts:{intraday:[],daily30:[]}}),getMacro:async()=>({items:[],stale:false,updatedAt:1000}),cacheSizes:()=>({}),activateNews:()=>true,requestNews:async()=>({items:[],stale:false,updatedAt:1000}),yahooSearch:async()=>[{symbol:'QQQ',name:'Yahoo QQQ'},{symbol:'SPY',name:'SPY'}],tencentSuggest:async()=>[{symbol:'QQQ',name:'腾讯 QQQ'},{symbol:'NVDA',name:'NVDA'}],history:{get:async(symbol,period)=>({symbol,period,bars:[],status:'empty',seriesId:'fixture',revision:'1',hasMore:false})}},{env:{PORT:0},monitorCore:false});
 layer.startListen();await once(layer.httpServer,'listening');t.after(()=>layer.stop());const url='http://127.0.0.1:'+layer.httpServer.address().port;
 const search=await (await fetch(url+'/api/search?q=mixed-fixture')).json();assert.deepEqual(search.map(x=>x.symbol),['QQQ','SPY','NVDA']);assert.equal(search[0].name,'Yahoo QQQ');
 const news=await fetch(url+'/api/news?symbols=QQQ');assert.deepEqual(await news.json(),{QQQ:[]});assert.ok(news.headers.get('X-News-Meta'));
 assert.deepEqual((await (await fetch(url+'/api/macro')).json()).items,[]);
 const market=await (await fetch(url+'/api/market?symbols=QQQ')).json();assert.ok(Array.isArray(market));assert.equal(market[0].price,100);assert.equal(market[0].intradayVer,0);
 assert.equal((await (await fetch(url+'/api/history?symbol=QQQ&period=weekly')).json()).period,'weekly');
 assert.equal((await fetch(url+'/api/market?symbols='+Array(100).fill('QQQ').join(','))).status,200);
 assert.equal((await fetch(url+'/api/market?symbols='+Array(101).fill('QQQ').join(','))).status,400);
 assert.equal((await fetch(url+'/api/stats',{headers:{'CF-Connecting-IP':'203.0.113.12'}})).status,404);
 const plain=await rawGet(url+'/panel.bundle.js',{'Accept-Encoding':'br;q=0,gzip;q=0'}),br=await rawGet(url+'/panel.bundle.js',{'Accept-Encoding':'br, gzip'});
 assert.equal(br.headers['content-encoding'],'br');assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(zlib.brotliDecompressSync(br.body),plain.body);
});
