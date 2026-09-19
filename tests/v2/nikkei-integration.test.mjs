import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createNikkeiApp} from '../support/nikkei-app.mjs';import {nikkeiSnapshot} from './nikkei-fixture.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(await fn())return;await wait(20);}assert.fail('condition timed out');}
function stream(url){
  const frames=[];let buffer='';
  const req=http.get(url,res=>{res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let end;
    while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const body=/^data: (.+)$/m.exec(frame)?.[1];if(body)frames.push(JSON.parse(body));}
  });});
  return {frames,close:()=>req.destroy()};
}
test('Nikkei background collects without browsers; multiple SSE clients share updates despite Yahoo 429',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nikkei-test-'));
  const f=await createNikkeiApp({now:Date.parse('2026-09-17T02:00:00Z'),background:true,directory});
  t.after(async()=>{await f.close();await fs.rm(directory,{recursive:true,force:true});});
  f.state.snapshot=nikkeiSnapshot({at:'2026-09-17T10:45:00+09:00'});
  await until(()=>f.app.services.samples.diagnostics().running);
  f.app.services.historyPrewarm.retain(['^N225']);f.app.services.samples.runDue();
  await until(()=>f.app.getCachedQuote('^N225').price===64136.25);
  assert.equal(f.quoteCalls(),1);assert.equal(f.app.services.engine.diagnostics().subscribers,1,'background owner, no browser');
  f.app.services.samples.runDue();assert.equal(f.app.services.samples.snapshot('^N225').points.length,1);
  const a=stream(f.url+'/api/stream?symbols=%5EN225'),b=stream(f.url+'/api/stream?symbols=%5EN225');t.after(()=>{a.close();b.close();});
  await until(()=>[a,b].every(s=>s.frames.some(f=>f.quotes?.some(q=>q.price===64136.25))));
  assert.equal(f.quoteCalls(),1,'browsers must not cause duplicate upstream calls');
  for(let i=0;i<3;i++)await fetch(f.url+'/api/market?symbols=%5EN225');assert.equal(f.quoteCalls(),1);
  f.state.now+=71000;f.state.snapshot=nikkeiSnapshot({price:'64,137.25',at:'2026-09-17T10:46:00+09:00'});
  await until(()=>[a,b].every(s=>s.frames.some(f=>f.quotes?.some(q=>q.price===64137.25))));
  assert.equal(f.quoteCalls(),2);assert.equal(f.app.getCachedQuote('^N225').feedDelayMinutes,15);
  f.app.services.samples.runDue();assert.equal(f.app.services.samples.snapshot('^N225').points.length,2);
  a.close();b.close();await until(()=>f.app.services.engine.diagnostics().subscribers===1);
  await f.close();
  assert.ok((await fs.readdir(directory)).some(n=>n.endsWith('.json')));
});
test('a warm Naver failure can recover through Yahoo without waiting for enrichment',async t=>{
  let f,fallbackCalls=0;
  f=await createNikkeiApp({providerOverrides:{fetchQuote:async symbol=>{
    fallbackCalls++;return {symbol,price:64140,quoteAt:f.state.now-60000,sourceCheckedAt:f.state.now,currency:'JPY',instrumentType:'INDEX',src:'yahoo',feedDelayMinutes:30};
  }}});t.after(()=>f.close());
  const unwatch=f.app.services.engine.watch(['^N225']);t.after(unwatch);
  await until(()=>f.app.getCachedQuote('^N225').src==='naver-index');assert.equal(fallbackCalls,0);
  f.state.naverUnavailable=true;f.state.now+=71000;
  await until(()=>f.app.getCachedQuote('^N225').src==='yahoo');
  assert.equal(f.app.getCachedQuote('^N225').price,64140);assert.equal(f.app.getCachedQuote('^N225').stale,undefined);assert.equal(fallbackCalls,1);
});
