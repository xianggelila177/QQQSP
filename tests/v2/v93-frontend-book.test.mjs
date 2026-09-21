import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createAlpacaProvider} from '../../lib/providers/alpaca-stream.js';
import {mergeAlpacaQuote} from '../../lib/realtime-quote-service.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function syncFixture(responses){
 const ctx={window:{},setTimeout,clearTimeout,Date};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-watchlist-sync.js',import.meta.url),'utf8'),ctx);
 const requests=[],statuses=[],timers=[];let key='';
 const network={request:async(_kind,_url,options)=>{requests.push(options);const next=responses.shift();return typeof next==='function'?next():next||{ok:true};},abort(){}};
 const sync=ctx.window.PANEL_WATCHLIST_SYNC.createWatchlistSync({network,getToken:()=>key,onStatus:s=>statuses.push(s),setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer(){},now:()=>0});
 return {sync,requests,statuses,timers,key:value=>key=value};
}
test('v93 failed watchlist write retains pending revision and retries without another user edit',async()=>{
 const f=syncFixture([{ok:false,status:503,retryAt:5000},{ok:true}]);f.sync.save(['NVDA']);await tick();assert.equal(f.sync.state().pending,true);assert.equal(f.statuses.at(-1).state,'retrying');f.timers.shift()();await tick();assert.equal(f.sync.state().pending,false);assert.equal(f.requests.length,2);assert.equal(f.requests[1].body,'{"symbols":["NVDA"]}');
});
test('v93 newer in-flight watchlist revisions are not overwritten by an older completion',async()=>{
 let resolve;const first=new Promise(r=>resolve=r),f=syncFixture([()=>first,{ok:true}]);f.sync.save(['NVDA']);f.sync.save(['AMD']);resolve({ok:true});await tick();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body,'{"symbols":["AMD"]}');assert.equal(f.sync.state().pending,false);
});
test('v93 authorization failures stop automatic writes until explicit retry; secret is only in header',async()=>{
 const f=syncFixture([{ok:false,status:401},{ok:true}]);f.sync.save(['NVDA']);await tick();assert.equal(f.sync.state().blocked,true);assert.equal(f.timers.length,0);
 f.key('temporary-value');f.sync.retry();await tick();assert.equal(f.requests[1].headers['X-Admin-Token'],'temporary-value');assert.ok(!f.requests[1].body.includes('temporary-value'));assert.equal(f.sync.state().pending,false);
});
test('v93 paused synchronization keeps pending changes and stops scheduled retries',async()=>{
 const f=syncFixture([]);f.sync.pause();f.sync.save(['NVDA']);await tick();assert.equal(f.requests.length,0);f.sync.resume();await tick();assert.equal(f.requests.length,1);
});
class Socket extends EventTarget {readyState=1;sent=[];send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;}emit(x){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify([x])}));}}
test('v93 Alpaca subscribes to quotes; book nanosecond order and trade time remain independent',()=>{
 const at=Date.parse('2026-09-18T14:00:00Z');let socket;
 const p=createAlpacaProvider({env:{ALPACA_ENABLED:'1',APCA_API_KEY_ID:'fixture',APCA_API_SECRET_KEY:'fixture'},now:()=>at,newSocket:()=>socket=new Socket(),schedule:()=>0,cancel(){}});
 p.start();p.touch('NVDA');socket.emit({T:'success',msg:'authenticated'});assert.deepEqual(socket.sent.at(-1).quotes,['NVDA']);
 socket.emit({T:'subscription',trades:['NVDA'],quotes:['NVDA']});
 socket.emit({T:'t',S:'NVDA',p:100,s:10,i:1,x:'V',t:'2026-09-18T13:59:59.000000001Z'});
 socket.emit({T:'q',S:'NVDA',bp:100,bs:2,ap:101,as:3,bx:'V',ax:'V',t:'2026-09-18T14:00:00.000000002Z'});
 const first=p.read('NVDA');assert.equal(first.orderBook.bid.size,2);assert.equal(first.orderBook.sizeUnit,'round_lots');assert.equal(first.trade.quoteAt,at-1000);
 socket.emit({T:'q',S:'NVDA',bp:99,bs:2,ap:102,as:3,t:'2026-09-18T14:00:00.000000001Z'});assert.equal(p.read('NVDA').orderBook.bid.price,100);
 const base={symbol:'NVDA',currency:'USD',price:100,quoteAt:at-1000,instrumentType:'EQUITY'};
 const merged=mergeAlpacaQuote(base,{...first,trade:null},at);assert.equal(merged.quoteAt,at-1000);assert.equal(merged.orderBook.asOf,at);assert.equal(merged.orderBook.bid.size,2);p.stop();
});
