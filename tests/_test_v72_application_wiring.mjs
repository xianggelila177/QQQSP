import assert from 'node:assert/strict';
import {once} from 'node:events';
delete process.env.PANEL_TEST_AUTOSTART;
const {createApplication}=await import('../server.js');
let starts=0,stops=0,legacyCalls=0;
const at=Date.parse('2026-09-09T15:00:00Z');
const provider={start(){starts++;},stop(){stops++;},supports:s=>s==='QQQ',touch:()=>true,
 read:()=>({source:'alpaca-iex',coverage:'single-exchange',state:'streaming',trade:{symbol:'QQQ',price:101,quoteAt:at,receivedAt:at,exchange:'V',conditions:[],sourceTimestamp:new Date(at).toISOString()}}),
 diagnostics:()=>({status:'streaming'})};
const app=createApplication({env:{...process.env,PORT:'0',SYMBOLS:'!',ALPACA_ENABLED:'1',LOG_LEVEL:'error'},now:()=>at,
 providerOverrides:{alpacaProvider:provider,fetchQuote:async symbol=>{legacyCalls++;return {symbol,price:100,quoteAt:at-1000,marketState:'REGULAR',currency:'USD',src:'fixture'};}}});
assert.equal(starts,0);app.start();app.start();if(!app.httpServer.listening)await once(app.httpServer,'listening');
try {
 const response=await fetch('http://127.0.0.1:'+app.httpServer.address().port+'/api/market?symbols=QQQ');
 assert.equal(response.status,200);const [quote]=await response.json();assert.equal(quote.src,'alpaca-iex');assert.equal(quote.price,101);assert.equal(quote.quoteAt,at);assert.equal(quote.change,null);
 assert.equal(starts,1);assert.ok(legacyCalls<=1);assert.equal(app.cacheSizes().alpaca.status,'streaming');
} finally {await app.stop();}
assert.equal(stops,1);assert.equal(app.httpServer.listening,false);
console.log('v72 application opt-in wiring, HTTP quote path and lifecycle passed');
