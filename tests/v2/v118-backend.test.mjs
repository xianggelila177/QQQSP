import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHistoryService} from '../../lib/history-service.js';
import {createQuoteEngine} from '../../lib/quote-engine.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createChartDetailService} from '../../lib/chart-detail-service.js';
import {recentRegularSessions,regularChartTarget} from '../../lib/regular-chart-service.js';
import {mergeQuoteHistory} from '../../lib/quote-history-merge.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createSinaProvider} from '../../lib/providers/sina.js';
const BASE=Date.parse('2026-10-02T08:00:00Z'),DAY=86400000;
const quote={symbol:'NVDA',currency:'USD',instrumentType:'EQUITY'};
const options={range:'5d',sections:'chart'};
function daily(symbol,query,{change=0,checkedAt=BASE,split=false}={}){
 const p=new URLSearchParams(query),from=Number(p.get('period1'))*1000,to=Math.min(Number(p.get('period2'))*1000,Date.parse('2026-10-02T00:00:00Z'));
 const timestamp=[],open=[],high=[],low=[],close=[],volume=[];
 for(let t=from;t<to;t+=DAY){const d=new Date(t);if([0,6].includes(d.getUTCDay()))continue;
  const date=d.toISOString().slice(0,10),c=100+(date==='2026-10-01'?change:0);
  timestamp.push(Date.parse(date+'T16:00:00Z')/1000);open.push(100);high.push(Math.max(102,c+1));low.push(98);close.push(c);volume.push(1000);
 }
 return {source:'yahoo',sourceCheckedAt:checkedAt,events:split?{splits:{one:{date:1,numerator:2,denominator:1}}}:{},meta:{symbol,exchangeName:'NMS',exchangeTimezoneName:'America/New_York',currency:'USD',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp,indicators:{quote:[{open,high,low,close,volume}]}};
}
function minute(clock=BASE,sparse=false){
 const sessions=recentRegularSessions('NVDA',regularChartTarget('NVDA',clock).targetDate,5),timestamp=[];
 for(const day of sessions)for(const session of day.sessions)for(let t=session.open_at_ms;t<session.close_at_ms;t+=300000){timestamp.push(t/1000);if(sparse)break;}
 return {source:'yahoo',sourceCheckedAt:clock,meta:{symbol:'NVDA',currency:'USD',dataGranularity:'5m',chartTimeBasis:'bar-start',chartIntervalSeconds:300},timestamp,indicators:{quote:[{open:timestamp.map(()=>100),high:timestamp.map(()=>102),low:timestamp.map(()=>98),close:timestamp.map(()=>101),volume:timestamp.map(()=>100)}]}};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('T04 resolved 161128 fund accepts inferred public and Sina types but rejects explicit type conflicts',async()=>{
 const symbol='161128.SZ',fund={symbol,currency:'CNY',instrumentType:'ETF',instrumentTypeSource:'provider'};
 const resolveInstrument=async()=>({type:'ETF',status:'confirmed',source:'provider'});
 for(const provider of ['public','sina']){
  const publicHistory=createPublicHistory({now:()=>BASE,getQuote:()=>fund,resolveInstrument,httpsGet:async()=>({status:200,body:JSON.stringify({data:{code:'161128',market:0,klines:['2026-09-30,1.2,1.25,1.3,1.1,100']}})})});
  const sina=createSinaProvider({now:()=>BASE,httpsGet:async()=>({status:200,body:JSON.stringify([{day:'2026-09-30',open:'1.2',high:'1.3',low:'1.1',close:'1.25',volume:'100'}])})});
  const source=createHistorySource({now:()=>BASE,getQuote:()=>fund,resolveInstrument,...(provider==='public'?{alternative:publicHistory}:{sina:sina.getSinaDaily})});
  const history=createHistoryService({now:()=>BASE,fetchChart:source});
  try{const value=await history.get(symbol,'daily',{count:1});assert.equal(value.bars.length,1);assert.equal(value.instrumentType,'ETF');assert.equal(value.currency,'CNY');assert.equal(value.source,provider==='public'?'eastmoney-history':'sina');}
  finally{history.close();source.close();publicHistory.close();sina.close();}
 }
 const conflicting={source:'test',meta:{symbol,currency:'CNY',exchangeName:'SHZ',instrumentType:'EQUITY',instrumentTypeSource:'provider',dataGranularity:'1d'},timestamp:[Date.parse('2026-09-30T04:00:00Z')/1000],indicators:{quote:[{open:[1.2],high:[1.3],low:[1.1],close:[1.25],volume:[100]}]}};
 const source=createHistorySource({now:()=>BASE,getQuote:()=>fund,resolveInstrument,primary:async()=>conflicting});
 try{await assert.rejects(source(symbol,'?interval=1d&range=5d'),{code:'HISTORY_IDENTITY_CONFLICT'});}finally{source.close();}
});

test('T03 independent regularChart survives the older-price guard',async t=>{
 const sessions=recentRegularSessions('NVDA','2026-10-01',1)[0].sessions;
 const bars=[{t:sessions[0].open_at_ms/1000,o:100,h:102,l:98,c:101,v:10}];
 let candidate={...quote,price:110,quoteAt:BASE-1000};
 const engine=createQuoteEngine({now:()=>BASE,readQuote:async()=>candidate,tickMs:3600000});engine.start();t.after(()=>engine.stop());await engine.refreshNow(['NVDA']);
 candidate={...candidate,price:100,quoteAt:BASE-2000,charts:{intraday:bars},slowFields:{intraday:{source:'yahoo',updatedAt:BASE,stale:false}},regularChart:{status:'ready',targetDate:'2026-10-01',tradeDate:'2026-10-01',regularSessions:sessions,bars,source:'yahoo',pointKind:'bar-start',intervalSeconds:300,sourceCheckedAt:BASE}};
 const [q]=await engine.refreshNow(['NVDA']);assert.equal(q.price,110);assert.equal(q.regularChart?.bars.length,1);
});
test('T04 newer price observations are not replaced by yesterday volume',async t=>{
 const make=(source,t,volume)=>({source,meta:{symbol:'NVDA',currency:'USD',dataGranularity:'5m'},timestamp:[t],indicators:{quote:[{open:[100],high:[102],low:[98],close:[101],volume:[volume]}]}});
 const fresh=Date.parse('2026-10-01T19:55:00Z')/1000,old=fresh-86400;
 const alternative=Object.assign(async()=>make('nasdaq-intraday',fresh,null),{supports:()=>true}),world=Object.assign(async()=>make('naver-world-chart',old,100),{supports:()=>true});
 const source=createHistorySource({alternative,world,now:()=>BASE});t.after(()=>source.close());
 assert.equal((await source('NVDA','?interval=5m&range=5d')).timestamp.at(-1),fresh);
});
test('T13 current daily revisions maintain the long cache without a full refetch',async t=>{
 let clock=BASE,change=0;const calls=[];
 const service=createHistoryService({now:()=>clock,fetchChart:async(s,q)=>{calls.push(q);return daily(s,q,{change,checkedAt:clock});}});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:5});clock+=61000;change=1;await service.get('NVDA','daily',{count:79});
 assert.equal(service.diagnostics().longEntries,1);const value=await service.get('NVDA','yearly',{count:5});assert.equal(value.bars.at(-1).c,101);assert.equal(calls.length,2);
});
test('T13 count 80 expands near the requested range instead of jumping to three calendar years',async t=>{
 let query;const service=createHistoryService({now:()=>BASE,fetchChart:async(s,q)=>{query=new URLSearchParams(q);return daily(s,q);}});t.after(()=>service.close());
 assert.equal((await service.get('NVDA','daily',{count:80})).bars.length,80);
 assert.ok((Number(query.get('period2'))-Number(query.get('period1')))/86400<160);
});
test('T14 an old-range failure does not poison cache-only current data',async t=>{
 let fail=false;const service=createHistoryService({now:()=>BASE,fetchChart:async(s,q)=>{if(fail)throw Object.assign(Error('wide unavailable'),{code:'HISTORY_SOURCE_UNAVAILABLE'});return daily(s,q);}});t.after(()=>service.close());
 await service.get('NVDA','daily',{count:79});fail=true;await service.get('NVDA','yearly',{count:39});
 const direct=await service.get('NVDA','daily',{count:79}),cached=await service.get('NVDA','daily',{count:79,cacheOnly:true});
 assert.equal(direct.stale,false);assert.equal(cached.stale,false);assert.equal(cached.errorCode,undefined);
});
test('T15 real source time is preserved across 61/121-second cache returns without busy retrying',async t=>{
 let clock=BASE,calls=0;const service=createHistoryService({now:()=>clock,fetchChart:async(s,q)=>{calls++;return daily(s,q);}});t.after(()=>service.close());
 await service.get('NVDA','daily',{count:79});
 for(const offset of [61000,121001]){clock=BASE+offset;const value=await service.get('NVDA','daily',{count:79});assert.equal(value.sourceCheckedAt,BASE);assert.equal(value.cacheServedAt,clock);for(let i=0;i<3;i++)await service.get('NVDA','daily',{count:79});}
 assert.equal(calls,3);
});
test('T17 a same-date five-day truncation preserves the known bars and source time',async t=>{
 let clock=BASE,sparse=false;const service=createChartDetailService({now:()=>clock,readQuote:()=>quote,fetchChart:async()=>minute(clock,sparse)});t.after(()=>service.stop());
 const original=(await service.read('NVDA',options)).fiveDay;assert.equal(original.bars.length,390);clock+=120001;sparse=true;
 await service.read('NVDA',options);await service.settled();const value=(await service.read('NVDA',options)).fiveDay;
 assert.equal(value.bars.length,390);assert.equal(value.stale,true);assert.equal(value.refreshError,'FIVE_DAY_COVERAGE_REGRESSION');assert.equal(value.sourceCheckedAt,BASE);
});
test('T17 sparse initial data stays usable with explicit unknown interval coverage',async t=>{
 const service=createChartDetailService({now:()=>BASE,readQuote:()=>quote,fetchChart:async()=>minute(BASE,true)});t.after(()=>service.stop());
 const value=(await service.read('NVDA',options)).fiveDay;
 assert.equal(value.bars.length,5);assert.equal(value.status,'partial');assert.equal(value.intervalCoverage.status,'partial');assert.equal(value.intervalCoverage.observedBars,5);
});
test('T18 checkpoint writes retain only current and latest pending versions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-v118-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let clock=BASE,release,writes=0;const blocked=new Promise(resolve=>release=resolve),saved=[];
 const service=createChartDetailService({now:()=>clock,readQuote:()=>quote,fetchChart:async()=>minute(clock),freshMs:1,statePath:path.join(dir,'five.json'),writeFile:async(_file,body)=>{writes++;saved.push(JSON.parse(body));if(writes===1)await blocked;}});
 await service.read('NVDA',options);const pending=[service.persist()];await turn();
 for(let i=0;i<7;i++){clock+=2;await service.read('NVDA',options);await service.settled();pending.push(service.persist());}
 try{assert.equal(writes,1);}finally{release();await Promise.all(pending);await service.stop();}
 assert.equal(writes,2);assert.equal(saved.at(-1).entries[0].value.sourceCheckedAt,clock);
});
test('T12 near prewarm explicitly marks a one-year provisional extent',async t=>{
 const service=createHistoryService({now:()=>BASE,fetchChart:async(s,q)=>daily(s,q)});t.after(()=>service.close());
 const value=await service.prepare('NVDA');
 assert.equal(value.yearly.extent.scope,'near');assert.equal(value.yearly.extent.satisfied,false);assert.equal(value.yearly.extent.available.count,1);assert.equal(value.yearly.extent.requested.count,39);
});

test('T03 identity, timestamps, target dates, invalid OHLC and coverage cannot overwrite a verified chart',()=>{
 const regularSessions=recentRegularSessions('NVDA','2026-10-01',1)[0].sessions,begin=regularSessions[0].open_at_ms/1000;
 const bars=[0,300,600].map(shift=>({t:begin+shift,o:100,h:102,l:98,c:101,v:100}));
 const chart={status:'ready',source:'yahoo',tradeDate:'2026-10-01',targetDate:'2026-10-01',regularSessions,bars,intervalSeconds:300,pointKind:'bar-start',sourceCheckedAt:BASE};
 const old={...quote,price:110,regularChart:chart};
 for(const extra of [{currency:'TWD'},{symbol:'AAPL'},{instrumentType:'ETF'},
  {regularChart:{...chart,sourceCheckedAt:BASE-1}}, {regularChart:{...chart,targetDate:'2026-09-30',tradeDate:'2026-09-30'}},
  {regularChart:{...chart,targetDate:'2026-10-02',tradeDate:'2026-10-02'}},
  {regularChart:{...chart,bars:[bars[0],bars[2]]}}, {regularChart:{...chart,bars:[{...bars[0],h:1}]}},
  {regularChart:{...chart,stale:true}}]){
  assert.equal(mergeQuoteHistory(old,{...old,...extra},BASE).regularChart,chart);
 }
 const corrected={...chart,sourceCheckedAt:BASE+1,bars:bars.map(bar=>({...bar,c:100.5}))};
 assert.equal(mergeQuoteHistory(old,{...old,regularChart:corrected},BASE+1).regularChart,corrected);
});
test('T04 same-session OHLC can upgrade price points while wrong currency, market and adjustment are rejected',async()=>{
 const at=Date.parse('2026-10-01T20:00:00Z')/1000;
 const point={source:'nasdaq-intraday',adjustment:'raw',meta:{symbol:'NVDA',currency:'USD',dataGranularity:'1m',chartTimeBasis:'price-point'},timestamp:[at],indicators:{quote:[{close:[101],volume:[null]}]}};
 for(const variant of [{}, {meta:{currency:'JPY'}}, {meta:{exchangeName:'TOKYO'}}, {adjustment:'split-adjusted'}]){
  const raw={source:'naver-world-chart',adjustment:variant.adjustment||'raw',meta:{...point.meta,dataGranularity:'5m',chartTimeBasis:'bar-start',chartIntervalSeconds:300,...variant.meta},timestamp:[at-300],indicators:{quote:[{open:[100],high:[102],low:[98],close:[101],volume:[100]}]}};
  const alternative=Object.assign(async()=>point,{supports:()=>true}),world=Object.assign(async()=>raw,{supports:()=>true});
  const source=createHistorySource({alternative,world,getQuote:()=>quote,now:()=>BASE});
  try{assert.equal((await source('NVDA','?interval=5m&range=5d')).source,Object.keys(variant).length?'nasdaq-intraday':'naver-world-chart');}finally{source.close();}
 }
});
test('T13 corporate-action changes still invalidate the other tier',async t=>{
 let split=false;const service=createHistoryService({now:()=>BASE,fetchChart:async(s,q)=>daily(s,q,{split})});t.after(()=>service.close());
 await service.get('NVDA','yearly',{count:5});split=true;await service.get('NVDA','daily',{count:79,force:true});
 assert.equal(service.diagnostics().longEntries,0);assert.ok(service.diagnostics().crossTierInvalidations>0);
});
test('T14 current-range failure and global rate limiting still mark cache reads stale',async()=>{
 for(const global of [false,true]){let fail=false;
  const service=createHistoryService({now:()=>BASE,fetchChart:async(s,q)=>{if(fail)throw Object.assign(Error('unavailable'),{code:global?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE',statusCode:global?429:503});return daily(s,q);}});
  try{await service.get('NVDA','daily',{count:79});fail=true;
   await service.get('NVDA',global?'yearly':'daily',{count:global?39:79,force:true});
   const value=await service.get('NVDA','daily',{count:79,cacheOnly:true});assert.equal(value.stale,true);assert.ok(value.retryAt>BASE);
  }finally{service.close();}
 }
});
test('T15 actual public-provider cache preserves source time and freshness across service checks and restart',async t=>{
 let clock=BASE,calls=0;
 const source=createPublicHistory({now:()=>clock,getQuote:()=>quote,httpsGet:async url=>{if(!url.includes('nasdaq.com'))return {status:200,body:'{"data":null}'};calls++;return {status:200,body:JSON.stringify({data:{symbol:'NVDA',tradesTable:{rows:[{date:'10/01/2026',open:'100',high:'102',low:'98',close:'101',volume:'1000'}]}}})};}});
 const service=createHistoryService({now:()=>clock,fetchChart:source});t.after(()=>{service.close();source.close();});
 await service.get('NVDA','daily',{count:1});clock+=61000;const value=await service.get('NVDA','daily',{count:1});
 assert.equal(value.sourceCheckedAt,BASE);assert.equal(value.sourceFreshUntil,BASE+300000);assert.equal(value.stale,false);assert.equal(calls,1);
 const restored=createHistoryService({now:()=>clock});t.after(()=>restored.close());restored.restore(service.exportState());
 const cached=await restored.get('NVDA','daily',{count:1,cacheOnly:true});assert.equal(cached.sourceCheckedAt,BASE);assert.equal(cached.sourceFreshUntil,BASE+300000);assert.equal(cached.stale,false);
 clock=BASE+300001;assert.equal((await service.get('NVDA','daily',{count:1})).sourceCheckedAt,clock);assert.equal(calls,2);
});
test('T17 a verified same-coverage correction replaces values; sparse regression can recover',async t=>{
 let clock=BASE,sparse=false,corrected=false;
 const service=createChartDetailService({now:()=>clock,readQuote:()=>quote,fetchChart:async()=>{const data=minute(clock,sparse);if(corrected)data.indicators.quote[0].close.fill(100.5);return data;}});t.after(()=>service.stop());
 const first=(await service.read('NVDA',options)).fiveDay;clock+=120001;corrected=true;
 await service.read('NVDA',options);await service.settled();const correction=(await service.read('NVDA',options)).fiveDay;
 assert.equal(correction.bars[0].c,100.5);assert.equal(correction.previousRevision,first.revision);assert.notEqual(correction.revision,first.revision);
 clock+=120001;sparse=true;await service.read('NVDA',options);await service.settled();assert.equal((await service.read('NVDA',options)).fiveDay.refreshError,'FIVE_DAY_COVERAGE_REGRESSION');
 clock+=120001;sparse=false;await service.read('NVDA',options);await service.settled();const recovered=(await service.read('NVDA',options)).fiveDay;
 assert.equal(recovered.stale,false);assert.equal(recovered.refreshError,undefined);assert.equal(recovered.status,'ready');
});
test('T18 failed writes retain dirty state, recover on next flush and preserve a failed-refresh checkpoint',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-v118-save-')),statePath=path.join(dir,'five.json');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let fail=true,clock=BASE,sparse=false;
 const service=createChartDetailService({statePath,now:()=>clock,readQuote:()=>quote,fetchChart:async()=>minute(clock,sparse),writeFile:async(file,body)=>{if(fail)throw Object.assign(Error('disk full'),{code:'ENOSPC'});await fs.writeFile(file,body);}});
 await service.read('NVDA',options);await assert.rejects(service.persist(),{code:'ENOSPC'});assert.equal(service.diagnostics().saveError,'ENOSPC');
 fail=false;await service.persist();assert.equal(service.diagnostics().saveError,null);
 clock+=120001;sparse=true;await service.read('NVDA',options);await service.settled();await service.stop();
 const restored=createChartDetailService({statePath,now:()=>clock,readQuote:()=>quote,fetchChart:async()=>{throw Error('cooldown should retain data');}});t.after(()=>restored.stop());
 const value=(await restored.read('NVDA',options)).fiveDay;assert.equal(value.stale,true);assert.equal(value.refreshError,'FIVE_DAY_COVERAGE_REGRESSION');assert.equal(value.bars.length,390);
});
