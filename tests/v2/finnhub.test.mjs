import test from 'node:test';import assert from 'node:assert/strict';
import {createFinnhubProvider} from '../../lib/providers/finnhub-stream.js';
class Socket extends EventTarget{readyState=1;sent=[];send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;}emit(x){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(x)}));}}
test('optional second stream accepts only subscribed, nonfuture trades; ping never resets age',()=>{
 let now=1789041600000,socket;const p=createFinnhubProvider({token:'not-a-real-key',now:()=>now,newSocket:()=>socket=new Socket(),schedule:()=>0,cancel(){},random:()=>0});
 p.start();p.touch('QQQ');socket.dispatchEvent(new Event('open'));assert.equal(p.read('QQQ').trade,null);assert.equal(p.read('QQQ').state,'subscribing');
 socket.emit({type:'trade',data:[{s:'QQQ',p:100,t:now-100,v:20},{s:'SPY',p:300,t:now,v:1},{s:'QQQ',p:105,t:now+9000,v:1}]});assert.equal(p.read('QQQ').trade.price,100);
 now+=2000;socket.emit({type:'ping'});assert.equal(p.read('QQQ').trade.quoteAt,now-2100);assert.equal(p.read('QQQ').delayMinutes,null);
 socket.emit({type:'trade',data:[{s:'QQQ',p:100,t:now,v:2}]});assert.equal(p.read('QQQ').trade.quoteAt,now);assert.equal(p.read('QQQ').state,'streaming');
 p.retain([]);assert.equal(socket.readyState,3);assert.equal(p.diagnostics().activeSymbols.length,0);assert.ok(!JSON.stringify(p.diagnostics()).includes('not-a-real-key'));p.stop();
});
