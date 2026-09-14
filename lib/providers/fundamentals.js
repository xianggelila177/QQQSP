import {financialNumber,fact} from '../fundamentals.js';
import {providerRetryAt} from './provider-retry.js';
const at=value=>{const n=financialNumber(value);return n!=null&&n>0?n*1000:null;};
const baseCurrency=currency=>currency==='GBp'||currency==='GBX'?'GBP':currency==='ZAc'||currency==='ZAC'?'ZAR':currency;
function put(fields,key,value,metadata,{positive=false,nonnegative=false}={}){
  const n=financialNumber(value);if(n==null||positive&&n<=0||nonnegative&&n<0)return;
  fields[key]=fact(n,metadata);
}
export function normalizeYahooFundamentals(symbol,payload,{now=Date.now()}={}) {
  const row=payload?.quoteSummary?.result?.[0];
  if(!row||String(row.price?.symbol||row.quoteType?.symbol||'').toUpperCase()!==symbol)throw Object.assign(new Error('Financial identity mismatch'),{code:'FUNDAMENTALS_IDENTITY'});
  const p=row.price||{},d=row.summaryDetail||{},k=row.defaultKeyStatistics||{};
  const source='yahoo-summary',currency=baseCurrency(p.currency||d.currency||null),asOf=at(p.regularMarketTime),fields={};
  // A quote timestamp is not evidence of the individual financial field date.
  const meta={source,asOf:null,quoteReferenceAt:asOf};
  for(const [key,value] of Object.entries({sharesOutstanding:k.sharesOutstanding,floatShares:k.floatShares}))put(fields,key,value,{source,asOf:null,unit:'shares'},{positive:true});
  put(fields,'marketCap',p.marketCap??d.marketCap,{...meta,unit:'money',currency},{positive:true});
  put(fields,'priceToBook',k.priceToBook,{...meta,unit:'ratio',basis:'latest-book'});
  put(fields,'peTTM',d.trailingPE,{...meta,unit:'ratio',basis:'trailing-twelve-months'});
  if(!fields.peTTM&&financialNumber(k.trailingEps)!=null&&financialNumber(k.trailingEps)<0)fields.peTTM={...meta,value:null,status:'loss',reason:'negative-earnings',basis:'trailing-twelve-months'};
  if(!fields.priceToBook&&financialNumber(k.bookValue)!=null&&financialNumber(k.bookValue)<=0)fields.priceToBook={...meta,value:null,status:'nonpositive-book',reason:'nonpositive-book'};
  put(fields,'psTTM',d.priceToSalesTrailing12Months??k.priceToSalesTrailing12Months,{...meta,unit:'ratio',basis:'trailing-twelve-months'},{positive:true});
  put(fields,'dividendTTM',d.trailingAnnualDividendRate,{...meta,unit:'money-per-share',currency,basis:'trailing-twelve-months'},{nonnegative:true});
  const dy=financialNumber(d.trailingAnnualDividendYield);
  if(dy!=null)put(fields,'dividendYieldTTM',dy*100,{...meta,unit:'percent',basis:'trailing-twelve-months'},{nonnegative:true});
  // forwardPE/dividendRate/dividendYield are forward-looking, not annual PE or TTM dividends.
  if(!Object.keys(fields).length)throw Object.assign(new Error('No usable financial fields'),{code:'FUNDAMENTALS_EMPTY'});
  const period=at(k.mostRecentQuarter);
  return {symbol,source,fetchedAt:now,financialPeriod:period?new Date(period).toISOString().slice(0,10):null,instrumentType:p.quoteType||row.quoteType?.quoteType||null,fields};
}
export function normalizeFinnhubFundamentals(symbol,payload,{now=Date.now()}={}) {
  if(String(payload?.symbol||'').toUpperCase()!==symbol||!payload.metric)throw Object.assign(new Error('Financial identity mismatch'),{code:'FUNDAMENTALS_IDENTITY'});
  const m=payload.metric,source='finnhub-metric',fields={};
  // Only explicit documented metric names, no guessing of adjusted EPS or fiscal PE.
  for(const [key,value,basis] of [['priceToBook',m.pbQuarterly,'latest-book'],['peTTM',m.peTTM,'trailing-twelve-months'],['peLYR',m.peAnnual,'last-fiscal-year'],['psTTM',m.psTTM,'trailing-twelve-months']])put(fields,key,value,{source,asOf:null,unit:'ratio',basis});
  if(!Object.keys(fields).length)throw Object.assign(new Error('No usable financial fields'),{code:'FUNDAMENTALS_EMPTY'});
  return {symbol,source,fetchedAt:now,financialPeriod:null,fields};
}
export function createFundamentalsProvider({fetchYahooSummary,httpsGet,finnhubToken='',now=Date.now}={}) {
  async function finnhub(symbol,{signal}={}){
    const response=await httpsGet('https://finnhub.io/api/v1/stock/metric?symbol='+encodeURIComponent(symbol)+'&metric=all',{'X-Finnhub-Token':finnhubToken},{signal,timeout:8000});
    if(response.status!==200)throw Object.assign(new Error('Financial source unavailable'),{code:'FUNDAMENTALS_SOURCE',retryAt:providerRetryAt(response.headers,now(),300000)});
    return normalizeFinnhubFundamentals(symbol,JSON.parse(response.body),{now:now()});
  }
  return async function fetchFundamentals(symbol,{signal}={}){
    let primary,error;
    try{primary=normalizeYahooFundamentals(symbol,await fetchYahooSummary(symbol,{signal}),{now:now()});}catch(e){error=e;}
    signal?.throwIfAborted();
    if(finnhubToken&&/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)&&(!primary||!primary.fields.priceToBook||!primary.fields.peLYR)){
      try{
        const fallback=await finnhub(symbol,{signal});
        if(!primary)return fallback;
        return {...primary,source:'yahoo-summary+finnhub-metric',fields:{...fallback.fields,...primary.fields}};
      }catch(e){signal?.throwIfAborted();if(!primary)throw e;}
    }
    if(primary)return primary;
    throw error||Object.assign(new Error('Financial source unavailable'),{code:'FUNDAMENTALS_SOURCE'});
  };
}
