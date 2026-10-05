import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryService} from '../../lib/history-service.js';
import {createHistorySource} from '../../lib/history-source.js';
import {createPublicHistory} from '../../lib/providers/public-history.js';
import {createSinaProvider} from '../../lib/providers/sina.js';

const now=()=>Date.parse('2026-10-05T04:00:00Z');
// Exact production listing identity observed from /api/quote on 2026-10-05.
// The earlier ETF-only regression missed Tencent's confirmed MUTUALFUND type.
const symbol='161128.SZ',quote={symbol,currency:'CNY',instrumentType:'MUTUALFUND',instrumentTypeSource:'provider',src:'tx-batch'};
const resolveInstrument=async()=>({type:'MUTUALFUND',status:'confirmed',source:'provider'});
const row={day:'2026-09-30',open:'1.2',high:'1.3',low:'1.1',close:'1.25',volume:'100'};

for(const provider of ['public','sina'])test(`161128 confirmed MUTUALFUND traverses ${provider} adapter, source router and daily service`,async t=>{
 const publicHistory=createPublicHistory({now,getQuote:()=>quote,resolveInstrument,httpsGet:async()=>({status:200,body:JSON.stringify({data:{code:'161128',market:0,klines:['2026-09-30,1.2,1.25,1.3,1.1,100']}})})});
 const sina=createSinaProvider({now,httpsGet:async()=>({status:200,body:JSON.stringify([row])})});
 const source=createHistorySource({now,getQuote:()=>quote,resolveInstrument,...(provider==='public'?{alternative:publicHistory}:{sina:sina.getSinaDaily})});
 const history=createHistoryService({now,getQuote:()=>quote,fetchChart:source});
 t.after(()=>{history.close();source.close();publicHistory.close();sina.close();});
 const value=await history.get(symbol,'daily',{count:1});
 assert.equal(value.status,'ready');assert.equal(value.stale,false);assert.equal(value.errorCode,undefined);
 assert.equal(value.instrumentType,'MUTUALFUND');assert.equal(value.currency,'CNY');
 assert.equal(value.source,provider==='public'?'eastmoney-history':'sina');
 assert.equal(value.bars.length,1);assert.equal(value.bars[0].c,1.25);
 assert.equal(value.bars[0].v,null,'Unverified source volume must remain unknown for funds');
});

const chart=type=>({source:'fixture',meta:{symbol,currency:'CNY',exchangeName:'SHZ',exchangeTimezoneName:'Asia/Shanghai',instrumentType:type,instrumentTypeSource:'provider',dataGranularity:'1d'},timestamp:[Date.parse('2026-09-30T04:00:00Z')/1000],indicators:{quote:[{open:[1.2],high:[1.3],low:[1.1],close:[1.25],volume:[100]}]}});
test('Confirmed EQUITY response still conflicts with the resolved MUTUALFUND listing',async t=>{
 const source=createHistorySource({now,getQuote:()=>quote,resolveInstrument,primary:async()=>chart('EQUITY')});
 const history=createHistoryService({now,fetchChart:source});t.after(()=>{history.close();source.close();});
 await assert.rejects(history.get(symbol,'daily',{count:1}),{code:'HISTORY_IDENTITY_CONFLICT'});
});
test('Adding MUTUALFUND does not permit unsupported history instrument types',async t=>{
 const history=createHistoryService({now,fetchChart:async()=>chart('CURRENCY')});t.after(()=>history.close());
 await assert.rejects(history.get(symbol,'daily',{count:1}),{code:'HISTORY_UNSUPPORTED'});
});
