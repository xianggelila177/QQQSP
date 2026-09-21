import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {quoteStatus} from '../../lib/http-diagnostics.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {createApiQuoteStream} from '../../lib/api-quote-stream.js';
const AT=Date.parse('2026-09-21T14:00:00Z');
const request={headers:{authorization:'Bearer fixture'}};
const quote={symbol:'NVDA',price:150,currency:'USD',src:'fixture',marketState:'REGULAR',quoteAt:AT-1000,sourceCheckedAt:AT};
function project(q,at=AT){return buildMarketContext({query:{symbol:q.symbol,include:['quote']},requestId:'freshness',generatedAt:at,quote:q}).sections.quote;}
class Sink extends EventEmitter{
 constructor(){super();this.text='';this.destroyed=false;this.writableEnded=false;this.writableLength=0;}
 writeHead(){} write(text){this.text+=text;return true;} end(){this.writableEnded=true;}
}
function events(sink){return sink.text.split('\n\n').filter(frame=>frame.includes('event: quote\n')).map(frame=>JSON.parse(frame.split('\ndata: ')[1]));}
function open(t,q,start){
 t.mock.timers.enable({apis:['setTimeout','setInterval']});let at=start,reads=0,pokes=0,watches=0;
 const engine={read(){reads++;return [q];},poke(){pokes++;},watch(){watches++;return()=>watches--;},subscribe(){return()=>{};}};
 const stream=createApiQuoteStream({engine,keys:{authenticate(){}},now:()=>at}),sink=new Sink();
 t.after(()=>stream.close());stream.open(request,sink,['NVDA'],{family:'fixture'},{});
 return {sink,advance(ms){at+=ms;t.mock.timers.tick(ms);},counts:()=>({reads,pokes,watches})};
}
test('v97 diagnostics and API reject unverified or recovered quotes using the same source-check clock',()=>{
 for(const patch of [{sourceCheckedAt:undefined},{sourceCheckedAt:0},{sourceCheckedAt:AT+1},{sourceCheckedAt:AT-61000,fetchedAt:AT},{recovery:true}]){
  const q={...quote,...patch};assert.equal(project(q).status,'partial');assert.equal(quoteStatus(q,AT).usable,false,JSON.stringify(patch));
 }
 const valid={...quote,sourceCheckedAt:AT-45000};assert.equal(project(valid).status,'ready');assert.equal(quoteStatus(valid,AT).usable,true);
 for(const patch of [{quoteAt:AT+1},{quoteAt:undefined,ts:AT},{price:0},{price:'150'}]){
  const q={...quote,...patch};assert.notEqual(project(q).status,'ready');assert.equal(quoteStatus(q,AT).usable,false,JSON.stringify(patch));
 }
});
test('v97 quiet SSE publishes expiry at heartbeat boundaries without inventing quote times or repeated unchanged snapshots',t=>{
 const q={...quote,quoteAt:AT-295000},original=structuredClone(q),run=open(t,q,AT);
 assert.equal(events(run.sink).length,1);assert.equal(events(run.sink)[0].results[0].sections.quote.status,'ready');
 run.advance(15000);const after=events(run.sink);assert.equal(after.length,2);assert.equal(after[1].results[0].sections.quote.missing_reason,'QUOTE_TOO_OLD');
 assert.equal(after[1].results[0].sections.quote.data.quote_at_ms,q.quoteAt);assert.equal(after[1].results[0].sections.quote.data.source_checked_at_ms,q.sourceCheckedAt);assert.equal(after[1].generated_at_ms,AT+15000);
 run.advance(15000);assert.equal(events(run.sink).length,2);assert.match(run.sink.text,/: heartbeat/);assert.deepEqual(q,original);assert.deepEqual(run.counts(),{reads:3,pokes:1,watches:1});
});
test('v97 quiet SSE reprojects current market state when the cached closed quote crosses into premarket',t=>{
 const start=Date.parse('2026-09-22T07:59:55Z'),q={...quote,quoteAt:Date.parse('2026-09-21T20:00Z'),sourceCheckedAt:start,marketState:'CLOSED'},run=open(t,q,start);
 assert.equal(events(run.sink)[0].results[0].sections.quote.status,'ready');
 run.advance(15000);const after=events(run.sink);assert.equal(after.length,2);const section=after[1].results[0].sections.quote;
 assert.equal(section.data.market_state,'PRE');assert.equal(section.missing_reason,'QUOTE_TOO_OLD');assert.equal(section.data.quote_at_ms,q.quoteAt);assert.equal(q.marketState,'CLOSED');
});
