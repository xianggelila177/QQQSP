// Synthetic, offline-only values. Never import this fixture in production.
import {normalizeYahooFundamentals} from '../../lib/providers/fundamentals.js';
import {buildBasicMetrics} from '../../lib/fundamentals.js';
export const NOW=Date.UTC(2026,8,14,14,0,0);
export function summary(symbol='AAOI',overrides={}) {
  return {quoteSummary:{result:[{
    price:{symbol,currency:'USD',quoteType:'EQUITY',regularMarketTime:{raw:NOW/1000},marketCap:{raw:8946000000}},
    summaryDetail:{trailingPE:{raw:25.4},priceToSalesTrailing12Months:{raw:14.42},trailingAnnualDividendRate:{raw:0},trailingAnnualDividendYield:{raw:0}},
    defaultKeyStatistics:{sharesOutstanding:{raw:84906300},floatShares:{raw:80880800},priceToBook:{raw:5.33},mostRecentQuarter:{raw:Date.UTC(2026,5,30)/1000}},
    ...overrides
  }]}};
}
export function record(symbol='AAOI',now=NOW) {return normalizeYahooFundamentals(symbol,summary(symbol),{now});}
export function quote(symbol='AAOI',overrides={}) {
  return {symbol,displayName:'离线测试 '+symbol,currency:'USD',instrumentType:'EQUITY',instrumentTypeSource:'provider',market:'美股',exchangeName:'NASDAQ',
    marketState:'REGULAR',calendarCoverage:{known:true},price:105.36,quoteAt:NOW,ts:NOW,sourceCheckedAt:NOW,regularQuoteAt:NOW,regularPrice:105.36,
    priceSession:'REGULAR',ohlcSession:'REGULAR',open:104.51,prevClose:103.29,dayHigh:108.669,dayLow:104.08,volume:5001400,volumeUnit:'shares',
    week52High:233.67,week52Low:18.5,change:2.07,changePct:2.004,src:'fixture',quoteKind:'snapshot',feedDelayMinutes:0,feedCoverage:'离线测试',
    fxMap:{USD:7.1,CNY:1,GBP:0.78},currency2cny:7.1,fxStale:false,fxKind:'reference',pollAfterMs:1000,gmtoff:-14400,...overrides};
}
export function browserQuotes(now=Date.now()-60000) {
  return ['AAOI','NVDA','XLK'].map(symbol=>{
    const q=quote(symbol,{quoteAt:now,ts:now,sourceCheckedAt:now,regularQuoteAt:now,...(symbol==='XLK'?{instrumentType:'ETF'}:{})});
    const r=record(symbol,now);
    if(symbol==='AAOI'){r.fields.peTTM={value:null,status:'loss',source:'fixture',reason:'negative-earnings',asOf:null};}
    if(symbol==='NVDA'){r.fields.marketCap.value=4500000000000;r.fields.sharesOutstanding.value=24400000000;r.fields.floatShares.value=23300000000;}
    q.fundamentals=buildBasicMetrics(q,r,{now});return q;
  });
}
