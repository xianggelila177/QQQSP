import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createApiQuoteStream} from '../../lib/api-quote-stream.js';
import {createStreamBudget} from '../../lib/stream-budget.js';
import {streamQuotes} from '../../scripts/market-api-client.mjs';
const AT=Date.parse('2026-09-21T14:00:00Z'),key='v96_stream_fixture_'.repeat(3),req={headers:{authorization:'Bearer '+key},rawHeaders:['Authorization','Bearer '+key]};
class Sink extends EventEmitter{constructor(){super();this.text='';this.destroyed=false;this.writableEnded=false;this.writableLength=0;this.block=false;}writeHead(code,headers){this.statusCode=code;this.headers=headers;}write(text){this.text+=text;return !this.block;}end(){this.writableEnded=true;}destroy(){this.destroyed=true;this.emit('close');}}
function engine(){const listeners=new Set();let price=100,watches=0;return {watch(){watches++;return()=>watches--;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},poke(){},read(symbols){return symbols.map(symbol=>({symbol,price,currency:'USD',quoteAt:AT,sourceCheckedAt:AT,src:'fixture',priceSession:'REGULAR'}));},update(next){price=next;for(const fn of listeners)fn(['NVDA']);},state:()=>({watches,listeners:listeners.size})};}
function quotes(sink){return sink.text.split('\n\n').filter(f=>f.includes('event: quote\n')).map(f=>JSON.parse(f.split('\ndata: ')[1]));}
test('v96 default SSE survives sixty seconds, coalesces updates and reconnects with current state only',t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});let now=AT;const e=engine(),stream=createApiQuoteStream({engine:e,keys:{authenticate(){}},now:()=>now}),res=new Sink();t.after(()=>stream.close());stream.open(req,res,['NVDA'],{family:'f'},{});
 e.update(101);e.update(102);assert.equal(quotes(res).length,1);now+=1000;t.mock.timers.tick(1000);assert.equal(quotes(res).at(-1).results[0].sections.quote.data.price,102);
 now+=61000;t.mock.timers.tick(61000);assert.equal(res.writableEnded,false);assert.ok(!res.text.includes('LEASE_ENDED'));assert.match(res.text,/retry: 1000/);assert.equal(e.state().watches,1);
 res.destroy();e.update(103);const next=new Sink();stream.open({...req,headers:{...req.headers,'last-event-id':'previous:9'}},next,['NVDA'],{family:'f'},{});assert.equal(quotes(next).length,1);assert.equal(quotes(next)[0].results[0].sections.quote.data.price,103);assert.equal(quotes(next)[0].results[0].sections.quote.as_of_ms,AT);
 stream.close();assert.deepEqual(e.state(),{watches:0,listeners:0});assert.equal(stream.diagnostics().connections,0);
});
test('v96 revocation interrupts a blocked continuous stream and explicit short leases remain available',t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']});let valid=true;const e=engine(),budget=createStreamBudget(),stream=createApiQuoteStream({engine:e,budget,keys:{authenticate(){if(!valid)throw Object.assign(Error('revoked'),{code:'UNAUTHORIZED'});}},now:()=>AT}),res=new Sink();stream.open(req,res,['NVDA'],{family:'f'},{});res.block=true;e.update(101);t.mock.timers.tick(1000);valid=false;t.mock.timers.tick(1000);assert.equal(res.writableEnded,true);assert.equal(e.state().watches,0);assert.equal(budget.diagnostics().connections,0);stream.close();
 const short=createApiQuoteStream({engine:e,keys:{authenticate(){}},now:()=>AT,leaseMs:15}),s=new Sink();short.open(req,s,['NVDA'],{family:'f'},{});t.mock.timers.tick(15);assert.match(s.text,/LEASE_ENDED/);assert.equal(s.writableEnded,true);assert.deepEqual(e.state(),{watches:0,listeners:0});short.close();
});
test('v96 initial buffer rejection releases the connection without creating an orphaned watch',()=>{
 const e=engine(),budget=createStreamBudget({maxClientBytes:1}),stream=createApiQuoteStream({engine:e,keys:{authenticate(){}},budget,now:()=>AT}),res=new Sink();stream.open(req,res,['NVDA'],{family:'f'},{});assert.equal(res.destroyed,true);assert.deepEqual(e.state(),{watches:0,listeners:0});assert.equal(budget.diagnostics().connections,0);stream.close();
});
test('v96 SDK has no implicit timeout and preserves explicit timeout plus caller cancellation',async()=>{
 const original=AbortSignal.timeout,calls=[];AbortSignal.timeout=ms=>{calls.push(ms);return new AbortController().signal;};
 try{const feed=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: quote\ndata: {"price":1}\n\n'));}}),controller=new AbortController();let options;
  const stream=streamQuotes(['NVDA'],{apiKey:key,signal:controller.signal,fetchImpl:async(_url,o)=>{options=o;return new Response(feed,{headers:{'content-type':'text/event-stream'}});}});assert.equal((await stream.next()).value.data.price,1);assert.deepEqual(calls,[]);assert.equal(options.signal,controller.signal);await stream.return();
 }finally{AbortSignal.timeout=original;}
 const timeout=streamQuotes(['NVDA'],{apiKey:key,timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
 await assert.rejects(timeout.next(),error=>error.code==='STREAM_TIMEOUT');
 const c=new AbortController(),cancelled=streamQuotes(['NVDA'],{apiKey:key,signal:c.signal,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),pending=cancelled.next();c.abort(Error('caller stopped'));await assert.rejects(pending,/caller stopped/);
});
