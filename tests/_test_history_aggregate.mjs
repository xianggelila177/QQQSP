import assert from 'node:assert/strict';
import {normalizeDailyBar,validSymbol} from '../lib/history-contract.js';
import {aggregateHistory} from '../lib/history-aggregate.js';

assert.equal(normalizeDailyBar({sessionDate:'2025-02-30',o:1,h:2,l:1,c:1.5,v:1}),null);
assert.equal(normalizeDailyBar({sessionDate:'2025-01-01',o:null,h:2,l:1,c:1.5,v:1}),null);
for (const symbol of ['QQQ','^GSPC','7203.T','0700.HK','2330.TW']) assert.equal(validSymbol(symbol),true,symbol);
const rows=['2024-12-30','2024-12-31','2025-01-02','2025-01-03','2025-01-06'].map((sessionDate,i)=>({sessionDate,o:i+1,h:i+2,l:i,c:i+1.5,v:100,source:'fixture',currency:'USD'}));
const weeks=aggregateHistory(rows.slice(0,4),'weekly',{asOf:Date.parse('2025-01-04T00:00:00Z')});
assert.deepEqual(weeks.map(x=>[x.periodStart,x.firstTradingDate,x.lastTradingDate,x.o,x.h,x.l,x.c,x.v]),[['2024-12-30','2024-12-30','2025-01-03',1,5,0,4.5,400]]);
assert.equal(weeks[0].periodState,'unknown'); // No 2025 exchange calendar was supplied.
assert.equal(aggregateHistory(rows,'monthly')[0].periodStart,'2024-12-01');
assert.equal(aggregateHistory(rows,'yearly')[0].periodStart,'2024-01-01');
assert.throws(()=>aggregateHistory([{...rows[0]},{...rows[1],source:'other'}],'weekly'),/mixed history identity/);
console.log('history aggregation contract PASS');
