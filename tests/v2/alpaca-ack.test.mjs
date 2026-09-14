import test from 'node:test';import assert from 'node:assert/strict';
import {createAlpacaProvider} from '../../lib/providers/alpaca-stream.js';
class Socket extends EventTarget{readyState=1;sent=[];send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;}emit(x){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify([x])}));}}
test('authenticated is not subscribed; each symbol needs an acknowledgement',()=>{
 let now=Date.parse('2026-09-09T15:00:00Z'),socket;
 const p=createAlpacaProvider({env:{ALPACA_ENABLED:'1',APCA_API_KEY_ID:'fixture',APCA_API_SECRET_KEY:'fixture'},now:()=>now,
  newSocket:()=>socket=new Socket(),schedule:()=>0,cancel(){},random:()=>0});
 p.start();p.touch('QQQ');p.touch('SPY');socket.emit({T:'success',msg:'authenticated'});
 assert.equal(p.read('QQQ').state,'subscribing');
 socket.emit({T:'subscription',trades:['QQQ']});assert.equal(p.read('QQQ').state,'streaming');assert.equal(p.read('SPY').state,'subscribing');
 p.retain(['QQQ']);assert.equal(p.read('SPY'),null);p.retain([]);p.step();assert.equal(p.diagnostics().socket,false);p.stop();
});
