import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSchwabClient} from '../../lib/providers/schwab-client.js';
import {normalizeSchwabQuote,parseSchwabCandles,createSchwabMarket} from '../../lib/providers/schwab-market.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createFastPolling} from '../../lib/providers/fast-polling.js';
import {publicSourceHealth} from '../../lib/source-health-public.js';

const at=Date.parse('2026-11-06T16:00:00Z');
const payload={symbol:'NVDA',assetMainType:'EQUITY',assetSubType:'COE',realtime:true,reference:{description:'NVIDIA'},
  quote:{lastPrice:200,tradeTime:at,quoteTime:at+1000,closePrice:190,openPrice:195,highPrice:201,lowPrice:194,totalVolume:10000},
  regular:{regularMarketLastPrice:200,regularMarketTradeTime:at}};
const candles={symbol:'NVDA',candles:[{datetime:at-60000,open:195,high:201,low:194,close:200,volume:100}]};
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
test('public health exposes reauthorization state without credential fields',()=>{
  const out=publicSourceHealth({schwab:{enabled:true,status:'SCHWAB_AUTH_REQUIRED',reauthorizationRequired:true,access_token:'sensitive',envFile:'private'}});
  assert.deepEqual(out.schwab,{enabled:true,status:'SCHWAB_AUTH_REQUIRED',reauthorizationRequired:true});
});
async function fixture(fn){
  const dir=await mkdtemp(join(tmpdir(),'qqqsp-schwab-'));
  const tokenFile=join(dir,'token.json'),envFile=join(dir,'schwab.env');
  await writeFile(envFile,'SCHWAB_CLIENT_ID=test-client\nSCHWAB_CLIENT_SECRET=test-secret\n');
  await writeFile(tokenFile,JSON.stringify({access_token:'old-access',refresh_token:'old-refresh',expires_at_ms:at-1}));
  try{await fn({tokenFile,envFile,now:()=>at,minGapMs:0});}finally{await rm(dir,{recursive:true,force:true});}
}
test('concurrent requests refresh once and atomically persist the rotated token',()=>fixture(async opts=>{
  let refreshes=0;
  const client=createSchwabClient({...opts,fetchImpl:async url=>{
    if(url.endsWith('/token')){refreshes++;return response({access_token:'new-access',refresh_token:'new-refresh',expires_in:1800});}
    return response({NVDA:payload});
  }});
  await Promise.all([client.request('/quotes?symbols=NVDA'),client.request('/quotes?symbols=AAPL')]);
  assert.equal(refreshes,1);const saved=JSON.parse(await readFile(opts.tokenFile,'utf8'));
  assert.equal(saved.refresh_token,'new-refresh');assert.equal(saved.expires_at_ms,at+1800000);
  assert.equal(client.diagnostics().status,'ready');
}));
test('invalid grant preserves old token, reports reauthorization and suppresses retry storms',()=>fixture(async opts=>{
  const before=await readFile(opts.tokenFile,'utf8');let calls=0;
  const client=createSchwabClient({...opts,fetchImpl:async()=>{calls++;return response({error:'invalid_grant',secret:'must-not-leak'},400);}});
  for(let i=0;i<2;i++)await assert.rejects(client.request('/quotes?symbols=NVDA'),{code:'SCHWAB_AUTH_REQUIRED'});
  assert.equal(calls,1);assert.equal(await readFile(opts.tokenFile,'utf8'),before);
  assert.equal(client.diagnostics().reauthorizationRequired,true);assert.ok(!JSON.stringify(client.diagnostics()).includes('old-refresh'));
}));
test('401 refresh retries only once; omitted refresh token preserves the last valid token',()=>fixture(async opts=>{
  await writeFile(opts.tokenFile,JSON.stringify({access_token:'old-access',refresh_token:'old-refresh',expires_at_ms:at+1800000}));
  let calls=0;
  const client=createSchwabClient({...opts,fetchImpl:async url=>{
    if(url.endsWith('/token'))return response({access_token:'new-access',expires_in:1800});
    calls++;return calls===1?response({},401):response({NVDA:payload});
  }});
  await client.request('/quotes?symbols=NVDA');assert.equal(calls,2);
  assert.equal(JSON.parse(await readFile(opts.tokenFile,'utf8')).refresh_token,'old-refresh');
}));
test('429 Retry-After applies globally; a 403 only cools down the denied dataset',()=>fixture(async opts=>{
  await writeFile(opts.tokenFile,JSON.stringify({access_token:'access',expires_at_ms:at+1800000}));
  const client=createSchwabClient({...opts,fetchImpl:async url=>url.includes('pricehistory')?response({},403):response({},429,{'Retry-After':'120'})});
  await assert.rejects(client.request('/pricehistory?symbol=NVDA'),{code:'SCHWAB_DATASET_DENIED'});
  await assert.rejects(client.request('/quotes?symbols=NVDA'),{code:'SCHWAB_RATE_LIMITED',retryAt:at+120000});
}));
test('quote trade time is independent of quote time and rejects foreign identities',()=>{
  const q=normalizeSchwabQuote('NVDA',payload,{now:at+2000});
  assert.equal(q.quoteAt,at);assert.equal(q.bidAskAt,at+1000);assert.equal(q.prevClose,190);assert.equal(q.feedDelayMinutes,0);
  assert.equal(normalizeSchwabQuote('NVDA',{...payload,symbol:'AAPL'},{now:at}),null);
  assert.equal(normalizeSchwabQuote('285A.T',payload,{now:at}),null);
});
test('history validates OHLC identity and retains source adjustment uncertainty',()=>{
  const parsed=parseSchwabCandles(candles,'NVDA','1m',{now:at});
  assert.equal(parsed.adjustment,'source-default-unverified');assert.equal(parsed.indicators.quote[0].volume[0],100);
  assert.throws(()=>parseSchwabCandles({...candles,symbol:'AAPL'},'NVDA','1m',{now:at}),{code:'HISTORY_IDENTITY_CONFLICT'});
  assert.throws(()=>parseSchwabCandles({...candles,candles:[{...candles.candles[0],high:190}]},'NVDA','1m',{now:at}),{code:'HISTORY_EMPTY'});
});
test('history primary failure reaches backup, cools independently, and returns to primary',async()=>{
  let clock=at,down=true,primaryCalls=0,backupCalls=0;
  const primary=async()=>{primaryCalls++;if(down)throw Object.assign(new Error('down'),{retryAt:clock+60000});return parseSchwabCandles(candles,'NVDA','1m',{now:clock});};primary.supports=()=>true;
  const source=createHistorySource({schwab:primary,primary:async()=>{backupCalls++;return {...parseSchwabCandles(candles,'NVDA','1m',{now:clock}),source:'yahoo'};},now:()=>clock});
  assert.equal((await source('NVDA','interval=1m')).source,'yahoo');
  await source('NVDA','interval=1m');assert.equal(primaryCalls,1);assert.equal(backupCalls,2);
  clock+=61000;down=false;assert.equal((await source('NVDA','interval=1m')).source,'schwab-history');source.close();
});
test('batch polling uses Schwab when healthy and recovers via independent quote fallback',async()=>{
  let clock=at,down=false;
  const q=normalizeSchwabQuote('NVDA',payload,{now:at});
  const polling=createFastPolling({now:()=>clock,httpsGet:async()=>({status:200,body:''}),
    schwabQuotes:async()=>{if(down)throw Object.assign(new Error('down'),{retryAt:clock+120000});return [{...q,quoteAt:clock}];},
    legacy:{tencent:async()=>[{...q,src:'tx-batch',quoteAt:clock}],fetchSnapshotBatch:async()=>({quotes:[]})}});
  assert.equal((await polling.fetchSnapshotBatch(['NVDA'],{group:'us'})).quotes[0].src,'schwab-quote');
  down=true;clock+=16000;
  assert.equal((await polling.fetchSnapshotBatch(['NVDA'],{group:'us'})).quotes[0].src,'tx-batch');
});
test('market history uses the requested interval and cancels cleanly on stop',async()=>{
  let path;
  const market=createSchwabMarket({now:()=>at,client:{request:async p=>{path=p;return candles;},close(){},reopen(){},diagnostics(){return {};}}});
  await market.fetchHistory('NVDA','interval=5m&range=5d');assert.match(path,/frequency=5/);assert.match(path,/needExtendedHoursData=false/);
  market.close();await assert.rejects(market.fetchHistory('NVDA','interval=5m'),{code:'STOPPED'});market.reopen();
  await market.fetchHistory('NVDA','interval=5m');market.close();
});
