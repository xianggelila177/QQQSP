import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
const NOW=Date.parse('2026-10-07T16:20:00+08:00');
function row({route='hk00700',code='00700',date='2026/10/07 16:08:58',price='420.6',volume='19531838',extra={}}={}){const fields=Array(80).fill('');Object.assign(fields,{1:'Tencent',2:code,3:price,4:'423.2',5:'424.4',6:volume,30:date,33:'424.8',34:'417.4',56:'GP-H',...extra});return `v_${route}="${fields.join('~')}";`;}
const parse=(body,symbols=['0700.HK'],now=NOW)=>createBatchProvider({now:()=>now}).parseTencentBatch(body,symbols);
test('actual HK slash timestamp recovers a closing-auction snapshot with publication basis and unchanged volume',()=>{
 for(const symbol of ['0700.HK','00700.HK']){const [quote]=parse(row(),[symbol]);assert.ok(quote);assert.equal(quote.price,420.6);assert.equal(quote.currency,'HKD');assert.equal(quote.quoteAt,Date.parse('2026-10-07T16:08:58+08:00'));assert.equal(quote.sourceCheckedAt,NOW);assert.equal(quote.priceSession,'REGULAR');assert.equal(quote.quoteTimeBasis,'provider-published');assert.equal(quote.regularQuoteAt,quote.quoteAt);assert.equal(quote.prevClose,423.2);assert.equal(quote.volume,19531838);assert.equal(quote.volumeUnit,'shares');assert.equal(quote.previousCloseTradeDate,'2026-10-06');}
});
test('HK routing checks the returned five-digit security code, not just the requested response variable',()=>{
 for(const options of [{code:'00941'},{code:'0700'},{route:'hk00941'},{code:''}])assert.equal(parse(row(options)).length,0,JSON.stringify(options));
 assert.equal(parse(row({date:'2026/10/07 15:59:58'}))[0].priceSession,'REGULAR');
});
test('invalid or future Tencent wall-clock dates are rejected instead of normalized by Date.UTC',()=>{
 for(const date of ['2026/02/30 16:08:58','2026/13/07 16:08:58','2026/10/07 24:08:58','2026/10/07 16:60:58','2026/10/07 16:08:60','2026/10/08 16:08:58','2026/10/07'])assert.equal(parse(row({date})).length,0,date);
});
test('HK closing-auction publication window respects half days and rejects an ordinary later clock as regular',()=>{
 const later=parse(row({date:'2026/10/07 16:11:00'}))[0];assert.ok(later);assert.notEqual(later.priceSession,'REGULAR');assert.equal(later.regularQuoteAt,null);assert.equal(later.quoteTimeBasis,undefined);
 const half=parse(row({date:'2026/12/24 12:08:58'}),['0700.HK'],Date.parse('2026-12-24T12:20:00+08:00'))[0];assert.ok(half);assert.equal(half.priceSession,'REGULAR');assert.equal(half.quoteTimeBasis,'provider-published');
 const closed=parse(row({date:'2026/10/04 16:08:58'}))[0];assert.ok(closed);assert.notEqual(closed.priceSession,'REGULAR');assert.equal(closed.regularQuoteAt,null);
});
test('US hyphen timestamps and China compact timestamps retain their original timezone and volume semantics',()=>{
 const usAt=Date.parse('2026-10-06T15:59:58-04:00'),us=parse(row({route:'usNVDA',code:'NVDA.OQ',date:'2026-10-06 15:59:58',volume:'1234',extra:{56:'GP'}}),['NVDA'])[0];assert.ok(us);assert.equal(us.quoteAt,usAt);assert.equal(us.currency,'USD');assert.equal(us.volume,1234);assert.equal(us.priceSession,'REGULAR');
 const cn=parse(row({route:'sh600519',code:'600519',date:'20260930150003',volume:'1234',extra:{56:'GP-A'}}),['600519.SS'])[0];assert.ok(cn);assert.equal(cn.quoteAt,Date.parse('2026-09-30T15:00:03+08:00'));assert.equal(cn.currency,'CNY');assert.equal(cn.volume,123400);assert.equal(cn.priceSession,'REGULAR');
});
