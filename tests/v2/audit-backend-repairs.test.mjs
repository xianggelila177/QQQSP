import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createHistoryService} from '../../lib/history-service.js';
import {usableHistory} from '../../lib/history-source.js';
import {createChartEnricher} from '../../lib/chart-enricher.js';
import {createSnapshotService} from '../../lib/snapshot-service.js';
import {parseEastmoneyFuture,parseYahooFuture,createFuturesProvider} from '../../lib/providers/futures.js';
import {parseEastmoneyHistory} from '../../lib/providers/public-history.js';
import {createAdvancedMarketData} from '../../lib/providers/advanced-market-data.js';
import {quoteStatus} from '../../lib/http-diagnostics.js';
import {mergeQuoteHistory} from '../../lib/quote-history-merge.js';
import {buildMarketContext} from '../../lib/market-context-format.js';
import {aggregateContextSeries} from '../../lib/context-series.js';
import {buildMarketDetail} from '../../lib/market-detail.js';
import {createMacroContext} from '../../lib/macro-context.js';
import {createApiKeys} from '../../lib/api-keys.js';
import {responseSchema} from '../../scripts/build-context-docs.mjs';
import {detailResponseSchema} from '../../scripts/build-detail-docs.mjs';
import SchemaValidator from '../support/schema-validator.mjs';

const NOW=Date.parse('2026-09-25T18:00:00Z');
const priceQuote=(symbol='NVDA')=>({symbol,price:101,quoteAt:NOW,regularQuoteAt:NOW,sourceCheckedAt:NOW,
  priceSession:'REGULAR',instrumentType:'EQUITY',currency:'USD',src:'tx-batch',prevClose:100});
const chart=(symbol='NVDA',interval='5m',close=101)=>({source:'yahoo',
  meta:{symbol,currency:'USD',exchangeName:symbol==='CL=F'?'NYM':'NMS',exchangeTimezoneName:'America/New_York',
    instrumentType:symbol==='CL=F'?'FUTURE':'EQUITY',dataGranularity:interval},
  timestamp:[Date.parse('2026-09-25T17:50:00Z')/1000],
  indicators:{quote:[{open:[close-1],high:[close+1],low:[close-2],close:[close],volume:[100]}]}});

test('B1 persistence round trip preserves pending latest trading day and validates it',async()=>{
  const raw=chart('NVDA','1d');raw.timestamp=[Date.parse('2026-09-24T16:00:00Z')/1000];
  raw.coverage={recentTail:{status:'pending',expectedTradeDate:'2026-09-25'}};
  const first=createHistoryService({fetchChart:async()=>raw,now:()=>NOW});
  const before=await first.get('NVDA','daily',{count:1}),state=first.exportState();
  const second=createHistoryService({now:()=>NOW});second.restore(state);
  const after=await second.get('NVDA','daily',{count:1,cacheOnly:true});
  assert.equal(before.errorCode,'HISTORY_LATEST_SESSION_PENDING');
  assert.equal(after.errorCode,before.errorCode);assert.equal(after.status,'stale');
  second.clear();state.entries[0].meta.latestSessionPending='2026-02-31';second.restore(state);
  assert.equal(second.diagnostics().restoreSkipped.reasons.dates,1);
  first.close();second.close();
});

test('B2 failed refresh retains bars with their successful source clock and partial status',async()=>{
  let at=NOW,failed=false;
  const enrich=createChartEnricher({now:()=>at,includeDaily:false,fetchChart:async()=>{if(failed)throw Error('offline');return chart();}});
  const first=await enrich('NVDA',priceQuote());at+=120000;failed=true;
  const second=await enrich('NVDA',{...priceQuote(),quoteAt:at});
  assert.equal(first.regularChart.status,'ready');assert.equal(second.regularChart.status,'partial');
  assert.equal(second.regularChart.stale,true);assert.equal(second.regularChart.sourceCheckedAt,NOW);
  assert.equal(second.regularChart.missingReason,'CHART_SOURCE_STALE');assert.equal(second.regularChart.bars.length,1);
});

test('B2 a fresh alternate source owns chart quality independently of failed primary',async()=>{
  const enrich=createChartEnricher({now:()=>NOW,includeDaily:false,fetchChart:async()=>{throw Error('offline');},fetchHistoricalChart:async()=>chart()});
  const value=await enrich('NVDA',priceQuote());
  assert.equal(value.slowFields.intraday.stale,true);
  assert.equal(value.regularChart.stale,false);assert.equal(value.regularChart.status,'ready');
  assert.equal(value.regularChart.sourceCheckedAt,NOW);assert.equal(value.regularChart.error,null);
});

test('B3 a manual response cannot reinsert a removed symbol, including across stop',async()=>{
  let release;
  const service=createSnapshotService({now:()=>NOW,fetchBatch:()=>new Promise(resolve=>release=resolve)});
  service.start();const pending=service.forceRefresh(['NVDA']);await Promise.resolve();service.retain([]);
  release({quotes:[priceQuote()]});const result=await pending;
  assert.equal(result.outcomes.NVDA,'removed');assert.equal(service.diagnostics().snapshots,0);
  service.stop();assert.equal(service.diagnostics().snapshots,0);
});

test('B3 manual refresh preserves ordering and refuses capacity-rejected symbols',async()=>{
  let quote=priceQuote();const batches=[];
  const service=createSnapshotService({now:()=>NOW,fetchBatch:async symbols=>{batches.push(symbols);return {quotes:symbols.map(symbol=>({...quote,symbol}))};}});
  service.start();assert.equal((await service.forceRefresh(['NVDA'])).outcomes.NVDA,'updated');
  quote={...quote,quoteAt:NOW-1000};assert.equal((await service.forceRefresh(['NVDA'])).outcomes.NVDA,'older');
  assert.equal(service.getCachedQuote('NVDA').quoteAt,NOW);
  for(let i=0;i<199;i++)service.getCachedQuote('A'+i);
  const calls=batches.length,result=await service.forceRefresh(['OVERFLOW']);
  assert.equal(result.outcomes.OVERFLOW,'capacity-exceeded');assert.equal(batches.length,calls);
  service.stop();
});

test('B4 both futures quote adapters accept finite non-positive prices and suppress zero-baseline percentages',()=>{
  const payload={data:{f57:'CL00Y',f43:-1,f44:2,f45:-3,f46:0,f60:0,f170:50,f86:NOW/1000}};
  const em=parseEastmoneyFuture(payload,'CL00Y.FUT',NOW);
  assert.equal(em.price,-1);assert.equal(em.change,-1);assert.equal(em.changePct,null);
  const raw=chart('CL=F','1m',-1);Object.assign(raw.meta,{regularMarketPrice:0,regularMarketTime:NOW/1000,previousClose:0});
  const yahoo=parseYahooFuture(raw,'CL=F',NOW);
  assert.equal(yahoo.price,0);assert.equal(yahoo.changePct,null);assert.equal(yahoo.charts.intraday[0].c,-1);
  assert.equal(quoteStatus(yahoo,NOW).status,'ok');assert.equal(quoteStatus({...yahoo,instrumentType:'EQUITY'},NOW).status,'error');
  assert.throws(()=>parseYahooFuture({...raw,meta:{...raw.meta,regularMarketPrice:Infinity}},'CL=F',NOW),{code:'FUTURE_EMPTY'});
});

test('B4 futures catalogue fallback accepts zero and cannot expose a source percent with zero reference',async()=>{
  const provider=createFuturesProvider({now:()=>NOW,httpsGet:async url=>url.includes('stock/get')?{status:500,body:''}:
    {status:200,body:JSON.stringify({total:1,list:[{dm:'CL00Y',p:0,zjsj:0,zdf:999}]})}});
  try{const q=await provider.getQuote('CL00Y.FUT');assert.equal(q.price,0);assert.equal(q.changePct,null);}finally{provider.close();}
});

test('B4 negative futures survive daily adapters, service and late-price chart merges; equities remain strict',async()=>{
  const raw=chart('CL=F','1d',-1);assert.equal(usableHistory(raw,'CL=F','?interval=1d'),true);
  assert.equal(usableHistory(chart('NVDA','1d',-1),'NVDA','?interval=1d'),false);
  const publicRaw=parseEastmoneyHistory({data:{code:'CL00Y',market:102,klines:['2026-09-25,0,-1,2,-3,100']}},'CL00Y.FUT','102.CL00Y',{now:NOW});
  assert.equal(publicRaw.indicators.quote[0].close[0],-1);
  const service=createHistoryService({fetchChart:async()=>raw,now:()=>NOW});
  const history=await service.get('CL=F','daily',{count:1});assert.equal(history.bars[0].c,-1);service.close();
  const previous={symbol:'CL=F',currency:'USD',instrumentType:'FUTURE',price:-1};
  const merged=mergeQuoteHistory(previous,{...previous,charts:{intraday:[{t:NOW/1000,c:0}]},slowFields:{intraday:{source:'yahoo-futures',updatedAt:NOW}}});
  assert.equal(merged.charts.intraday[0].c,0);
});

test('B4 historical intraday and aggregation preserve non-positive futures OHLC',async()=>{
  const advanced=createAdvancedMarketData({now:()=>NOW,fetchChart:async()=>chart('CL=F','1m',-1)});
  try{
    const value=await advanced.intraday({symbol:'CL=F',intraday_date:'2026-09-25'});
    assert.equal(value.points[0].c,-1);
    const section={columns:['time_ms','trade_date','open','high','low','close'],column_units:[],rows:[[NOW,'2026-09-25',0,2,-3,-1]],status:'ready'};
    assert.equal(aggregateContextSeries(section,5,{symbol:'CL=F',zone:'America/Chicago'}).rows[0][5],-1);
  }finally{advanced.close();}
});

test('B4 v1/v2 schema accepts futures negative values only in the instrument price domain',()=>{
  const quote={...parseYahooFuture({...chart('CL=F','1m',-1),meta:{...chart('CL=F','1m',-1).meta,regularMarketPrice:-1,regularMarketTime:NOW/1000,previousClose:0}},'CL=F',NOW)};
  const query={symbol:'CL=F',include:['quote','intraday','daily'],daily_bar_count:1,sample_trading_days:1};
  const out=buildMarketContext({query,requestId:'audit',generatedAt:NOW,quote,daily:{symbol:'CL=F',currency:'USD',source:'yahoo',bars:[{t:Date.parse('2026-09-25T00:00Z')/1000,sessionDate:'2026-09-25',o:0,h:2,l:-3,c:-1,v:100}]}});
  assert.equal(out.sections.quote.data.price,-1);assert.equal(out.sections.quote.data.change_percent,null);
  assert.equal(out.sections.daily.rows[0][5],-1);
  const validator=new SchemaValidator({allErrors:true}),v1=validator.compile(responseSchema),v2=validator.compile(detailResponseSchema);
  assert.ok(v1(out),JSON.stringify(v1.errors));
  const detail=buildMarketDetail(out,{profile:'analysis',format:'objects'});assert.ok(v2(detail),JSON.stringify(v2.errors));
  const equity=structuredClone(out);equity.instrument.type='EQUITY';assert.equal(v1(equity),false);
  const badTime=structuredClone(out);badTime.sections.quote.as_of_ms=-1;assert.equal(v1(badTime),false);
  const detailEquity=structuredClone(detail);detailEquity.instrument.type='EQUITY';assert.equal(v2(detailEquity),false);
});

test('B4 macro futures keep non-positive observations, including restore, without zero-division',async()=>{
  let at=NOW,price=0;
  const macro=createMacroContext({now:()=>at,readQuote:async symbol=>({symbol,instrumentType:symbol.includes('FUT')||symbol.endsWith('=F')?'FUTURE':'INDEX',price:symbol==='CL00Y.FUT'?price:100,quoteAt:at,sourceCheckedAt:at,src:'fixture'})});
  await macro.getContext();at+=60000;price=-1;await macro.getContext();
  const factor=macro.snapshot().factors.find(f=>f.id==='wti');assert.equal(factor.price,-1);assert.equal(factor.change,null);
  const restored=createMacroContext({now:()=>at});restored.restore(macro.exportState());
  assert.equal(restored.snapshot().factors.find(f=>f.id==='wti').price,-1);macro.close();restored.close();
});

test('B5 enabled calendar waiting/loading is partial; disabled optional calendar is not a failure',()=>{
  const make=status=>buildMarketContext({query:{symbol:'NVDA',include:['macro']},requestId:'audit',generatedAt:NOW,
    macro:{context:{factors:[{price:100,status:'ready'}],calendar:{enabled:status!=='disabled',status,items:[]}},news:{items:[],updatedAt:NOW}}});
  for(const status of ['waiting','loading']){const out=make(status);assert.equal(out.status,'partial');assert.equal(out.sections.macro.missing_reason,'MACRO_CALENDAR_PENDING');}
  assert.equal(make('disabled').status,'complete');assert.equal(make('ready').status,'complete');
});

test('B6 saturated managed history compacts without resurrecting env keys or splitting live rotation families',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-audit-backend-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'keys.json'),digest=value=>createHash('sha256').update(value).digest('hex');
  const env='audit_environment_fixture_'.repeat(2),old='audit_rotation_old_fixture_'.repeat(2),current='audit_rotation_current_fixture_'.repeat(2);
  const record=(id,secret,status='revoked',family=id,expiresAt=null)=>({id,family,digest:digest(secret),scopes:['quote-only'],status,label:id,createdAt:1,expiresAt});
  const records=[record('legacy',env),record('old',old,'rotating','family',NOW+86400000),record('current',current,'active','family'),
    ...Array.from({length:253},(_,i)=>record('retired'+i,'audit-retired-'+i))];
  await fs.writeFile(file,JSON.stringify({schemaVersion:1,keys:records}));
  let keys=createApiKeys({apiKey:env,file,now:()=>NOW});await keys.mutate({action:'create',label:'replacement',scopes:['quote-only']});
  const request=secret=>({headers:{authorization:'Bearer '+secret}});
  keys=createApiKeys({apiKey:env,file,now:()=>NOW});assert.equal(keys.list().keys.length,256);
  assert.throws(()=>keys.authenticate(request(env)),{code:'UNAUTHORIZED'});
  assert.equal(keys.authenticate(request(old)).family,keys.authenticate(request(current)).family);
  await keys.mutate({action:'revoke',id:'old'});
  assert.throws(()=>keys.authenticate(request(current)),{code:'UNAUTHORIZED'});
});
