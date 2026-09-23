import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchProvider} from '../../lib/providers/batch-snapshot.js';
import {publishQuote} from '../../lib/quote-contract.js';
import {buildMarketContext} from '../../lib/market-context-format.js';

const now=Date.parse('2026-09-22T13:15:00Z');
const batch=createBatchProvider({now:()=>now,httpsGet:async()=>{throw new Error('unexpected I/O');}});
const cases=[['LITE',930.91,954.49,940.01,-1.5170405137822307],
  ['AAOI',105.17,108.67,107.15,-1.398730100303669],
  ['NVDA',222.27,227.38,226.08,-0.5717301433723176]];

function row(symbol,older,regular,pre){
  return {symbolCode:symbol,stockName:symbol,stockExchangeType:{code:'NSQ',nameEng:'NASDAQ',delayTime:0},
    currencyType:{code:'USD'},closePriceRaw:String(regular),
    compareToPreviousClosePriceRaw:String(regular-older),localTradedAt:'2026-09-21T16:00:00-04:00',
    overMarketPriceInfo:{tradingSessionType:'PRE_MARKET',overPrice:String(pre),localTradedAt:'2026-09-22T09:12:00-04:00'}};
}
function context(symbol,quote){return buildMarketContext({query:{symbol,include:['quote'],sample_trading_days:1},
  requestId:'test',generatedAt:now,quote});}

test('the three observed premarket regressions use the immediately prior regular close',()=>{
  for(const [symbol,older,regular,pre,expectedPct] of cases){
    const q=batch.parseNaverQuote(row(symbol,older,regular,pre),symbol,2000);
    assert.equal(q.price,pre);
    assert.equal(q.prevClose,regular);
    assert.equal(q.providerPrevClose,older);
    assert.equal(q.previousCloseTradeDate,'2026-09-21');
    assert.equal(q.previousCloseStatus,'regular-close');
    assert.ok(Math.abs(q.changePct-expectedPct)<1e-9);
    assert.ok(Math.abs(q.ext.pre.changePct-expectedPct)<1e-9);
    const api=context(symbol,q);
    assert.equal(api.sections.quote.data.previous_close,regular);
    assert.equal(api.sections.quote.data.previous_close_trade_date,'2026-09-21');
    assert.ok(Math.abs(api.sections.quote.data.change_percent-expectedPct)<1e-9);
  }
});

test('an unconfirmed earlier regular price leaves the headline price but no fabricated change',()=>{
  const q=batch.parseNaverQuote({...row('AAOI',105.17,108.67,107.15),
    localTradedAt:'2026-09-21T15:00:00-04:00'},'AAOI',2000);
  assert.equal(q.price,107.15);
  assert.equal(q.prevClose,null);
  assert.equal(q.changePct,null);
  assert.equal(q.ext.pre.changePct,null);
  assert.equal(context('AAOI',q).sections.quote.status,'partial');
});

test('an explicitly dated stale reference cannot be carried into the new trading day',()=>{
  const q=publishQuote({symbol:'NVDA',instrumentType:'EQUITY',currency:'USD',src:'test',
    price:226.08,quoteAt:Date.parse('2026-09-22T13:12:00Z'),priceSession:'PRE',
    prevClose:222.27,previousCloseTradeDate:'2026-09-18'});
  assert.equal(q.prevClose,null);
  assert.equal(q.previousCloseMissingReason,'PREVIOUS_CLOSE_DATE_MISMATCH');
});
