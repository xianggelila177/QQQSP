import assert from 'node:assert/strict';
import {createAlpacaProvider,alpacaConfig,tradeTimestamp} from '../lib/providers/alpaca-stream.js';
import {providerRetryAt} from '../lib/providers/provider-retry.js';
const start=Date.parse('2026-09-09T15:00:00Z');
let at=start;
class Socket {
 constructor(url){this.url=url;this.handlers={};this.sent=[];this.readyState=0;}
 addEventListener(type,fn){this.handlers[type]=fn;}
 send(data){this.sent.push(JSON.parse(data));}
 close(){this.readyState=3;this.handlers.close?.({});}
 open(){this.readyState=1;this.handlers.open?.({});}
 emit(message){this.handlers.message?.({data:JSON.stringify(Array.isArray(message)?message:[message])});}
}
function fixture(extra={}) {
 const sockets=[],requests=[];
 const provider=createAlpacaProvider({env:{ALPACA_ENABLED:'1',APCA_API_KEY_ID:'fixture-key',APCA_API_SECRET_KEY:'fixture-secret',...extra.env},
  now:()=>at,random:()=>0,newSocket:url=>{const s=new Socket(url);sockets.push(s);return s;},schedule:()=>1,cancel(){},
  httpsGet:async(url,headers)=>{requests.push({url,headers});return extra.response?.()||{status:200,headers:{},body:'{}'};}});
 return {provider,sockets,requests};
}
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const trade=(i,p=100,t=new Date(at-500).toISOString())=>({T:'t',S:'QQQ',i,p,t,x:'V',s:1,c:['@']});
assert.throws(()=>alpacaConfig({ALPACA_ENABLED:'1'}),/credentials/);
assert.throws(()=>alpacaConfig({ALPACA_FEED:'delayed_sip'}),/Invalid/);
assert.equal(createAlpacaProvider({env:{}}).supports('QQQ'),false);
assert.equal(tradeTimestamp('2026-02-30T00:00:00Z'),null);
const a=tradeTimestamp('2026-09-09T15:00:00.000000001Z'),b=tradeTimestamp('2026-09-09T15:00:00.000000002Z');
assert.equal(a.milliseconds,b.milliseconds);assert.ok(a.order<b.order);
const f=fixture();assert.equal(f.sockets.length,0);f.provider.start();assert.equal(f.sockets.length,0);
assert.equal(f.provider.touch('VOD.L'),false);assert.equal(f.provider.touch('^FTSE'),false);
assert.equal(f.provider.touch('QQQ'),true);f.provider.touch('SPY');assert.equal(f.sockets.length,1);
const s=f.sockets[0];s.open();assert.equal(s.sent[0].action,'auth');s.emit({T:'success',msg:'authenticated'});
assert.deepEqual(s.sent[1].trades,['QQQ','SPY']);assert.equal(f.provider.read('QQQ').trade,null);
s.emit(trade(1));const first=f.provider.read('QQQ').trade;assert.equal(first.price,100);
at+=1000;s.emit(trade(2));assert.equal(f.provider.read('QQQ').trade.price,100);assert.ok(f.provider.read('QQQ').trade.quoteAt>first.quoteAt,'same price new trade updates age');
s.emit(trade(3,99,new Date(at-2000).toISOString()));assert.equal(f.provider.read('QQQ').trade.id,'2','old trade rejected');
s.emit(trade(4,99,new Date(at+6000).toISOString()));assert.equal(f.provider.read('QQQ').trade.id,'2','future trade rejected');
s.emit({T:'success',msg:'connected'});assert.equal(f.provider.read('QQQ').trade.id,'2');
s.emit({T:'x',S:'QQQ',i:2,x:'V',t:new Date(at).toISOString()});assert.equal(f.provider.read('QQQ').trade,null);
s.emit(trade(2));assert.equal(f.provider.read('QQQ').trade,null,'invalidated print cannot be resurrected');
at+=1000;s.emit(trade(5));s.emit({T:'c',S:'QQQ',oi:5,x:'V',cp:101,t:new Date(at).toISOString()});assert.equal(f.provider.read('QQQ').trade,null);
at+=1000;s.emit(trade(6));f.provider.step();await drain();assert.equal(f.requests.length,1);assert.ok(f.requests[0].url.includes('QQQ%2CSPY'));
assert.ok(!JSON.stringify(f.provider.diagnostics()).includes('fixture-secret'));
f.provider.stop();assert.equal(f.provider.diagnostics().entries,0);s.emit(trade(7));assert.equal(f.provider.read('QQQ'),null);
const l=fixture({response:()=>({status:429,headers:{'Retry-After':'120'},body:''})});l.provider.start();l.provider.touch('QQQ');l.provider.step();await drain();
assert.equal(l.requests.length,1);const retry=l.provider.diagnostics().restRetryAt;assert.equal(retry,at+120000);
for(let i=0;i<50;i++){at+=1000;l.provider.touch('QQQ');l.provider.step();}await drain();assert.equal(l.requests.length,1);
at=retry;l.provider.step();await drain();assert.equal(l.requests.length,2);l.provider.stop();
const p=fixture();p.provider.start();p.provider.touch('QQQ');p.sockets[0].open();p.sockets[0].emit({T:'error',code:409});at+=600000;p.provider.touch('QQQ');p.provider.step();assert.equal(p.sockets.length,1);assert.equal(p.provider.diagnostics().status,'blocked');p.provider.stop();
const cap=fixture({env:{ALPACA_MAX_SYMBOLS:'1'}});cap.provider.start();assert.equal(cap.provider.touch('QQQ'),true);assert.equal(cap.provider.touch('SPY'),false);at+=300001;cap.provider.step();assert.equal(cap.provider.touch('SPY'),true);cap.provider.stop();
assert.equal(providerRetryAt({'retry-after':new Date(at+90000).toUTCString()},at,1000),at+90000-at%1000);
console.log('v72 Alpaca lifecycle, subscription budget, timestamp order, cancellation, 429 and entitlement handling passed');
