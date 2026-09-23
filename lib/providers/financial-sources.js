import {normalizeNaverBasic,normalizeNaverStatements,normalizeNasdaqSummary,normalizeNasdaqDividends,normalizeNasdaqStatements,normalizeNaverCompanyFinancials,sourceNumber} from './financial-details.js';
import {normalizeYahooFundamentals,normalizeFinnhubFundamentals} from './fundamentals.js';
import {marketKeyFor,tencentCodeFor} from '../instruments.js';
import {regularTradingStatistics} from '../trading-statistics.js';
import {providerRetryAt} from './provider-retry.js';
import {fact} from '../fundamentals.js';
import {createSharedTasks} from '../shared-task.js';
const unavailable=code=>Object.assign(new Error('Financial provider unavailable'),{code});
export function createFinancialSources({httpsGet,batch,fetchYahooSummary,finnhubRequest=null,finnhubToken='',now=Date.now,statementTtlMs=21600000}={}){
  const basicCache=new Map(),basicTasks=createSharedTasks();
  const us=q=>marketKeyFor(q.symbol)==='us'&&['EQUITY','ETF','MUTUALFUND'].includes(q.instrumentType||'EQUITY');
  const kr=q=>/^\d{6}\.(KS|KQ)$/.test(q.symbol);
  async function request(url,{signal,headers={},text=false}={}){
    signal?.throwIfAborted();const r=await httpsGet(url,{Accept:'application/json',Referer:url.includes('nasdaq.com')?'https://www.nasdaq.com/':'https://m.stock.naver.com/',...headers},{signal,timeout:8000});
    if(r.status!==200)throw Object.assign(unavailable(r.status===429?'RATE_LIMITED':r.status===404?'FUNDAMENTALS_UNSUPPORTED':'FUNDAMENTALS_SOURCE'),{retryAt:providerRetryAt(r.headers,now(),60000)});
    return text?r.body:JSON.parse(r.body);
  }
  const pooledFinnhub=finnhubRequest||(!finnhubToken?null:(path,{signal}={})=>httpsGet('https://finnhub.io/api/v1'+path,{'X-Finnhub-Token':finnhubToken},{signal,timeout:8000}));
  async function finnhubJson(path,{signal}={}){
    const response=await pooledFinnhub(path,{signal});
    if(response.status!==200)throw Object.assign(unavailable(response.status===429?'RATE_LIMITED':'FUNDAMENTALS_SOURCE'),{retryAt:providerRetryAt(response.headers,now(),60000)});
    return JSON.parse(response.body);
  }
  async function basic(symbol,{signal}={}){
    const cached=basicCache.get(symbol);if(cached&&now()-cached.at<60000)return cached.data;
    return basicTasks.run(symbol,async taskSignal=>{
      const code=await batch.resolveNaverCode(symbol,{signal:taskSignal});if(!code)throw unavailable('FUNDAMENTALS_UNSUPPORTED');
      const data=await request('https://api.stock.naver.com/stock/'+encodeURIComponent(code)+'/basic',{signal:taskSignal});
      if(data.symbolCode!==symbol||data.reutersCode!==code)throw unavailable('FUNDAMENTALS_IDENTITY');
      basicCache.set(symbol,{at:now(),data});while(basicCache.size>128)basicCache.delete(basicCache.keys().next().value);return data;
    },{signal});
  }
  const sources=[
    {id:'tencent-financial',priority:10,priorities:{peLYR:35},ttlMs:60000,fields:['priceToBook','peLYR','marketCap','floatMarketCap','sharesOutstanding','floatShares','week52High','week52Low'],match:q=>!q.symbol.endsWith('.HK')&&!!tencentCodeFor(q.symbol),load:async(symbol,{signal})=>{
      const q=(await batch.tencent([symbol],{signal})).find(q=>q.symbol===symbol);
      if(!q?.financials)throw unavailable('FUNDAMENTALS_EMPTY');return {...q.financials,statistics:regularTradingStatistics(q),orderBook:q.orderBook};
    }},
    {id:'naver-basic',priority:20,ttlMs:60000,fields:['priceToBook','marketCap','sharesOutstanding','bookValue','week52High','week52Low'],match:q=>us(q)||kr(q),load:async(symbol,{signal})=>{
      if(!kr({symbol}))return normalizeNaverBasic(symbol,await basic(symbol,{signal}),{now:now()});
      const data=await request('https://m.stock.naver.com/api/stock/'+symbol.slice(0,6)+'/integration',{signal});
      if(data.itemCode!==symbol.slice(0,6))throw unavailable('FUNDAMENTALS_IDENTITY');
      const rows=Object.fromEntries((data.totalInfos||[]).map(r=>[r.code,r])),fields={},source='naver-basic';
      for(const [key,code,unit] of [['priceToBook','pbr','ratio'],['bookValue','bps','money-per-share']]){const value=sourceNumber(rows[code]?.value);if(value!=null)fields[key]=fact(value,{source,asOf:null,unit,currency:'KRW',financialPeriod:rows[code]?.valueDesc?.replaceAll('.','-')?.replace(/-$/,'')||null});}
      const hi=sourceNumber(rows.highPriceOf52Weeks?.value),lo=sourceNumber(rows.lowPriceOf52Weeks?.value);
      if(hi>0&&lo>0&&hi>=lo){fields.week52High=fact(hi,{source,currency:'KRW',unit:'price',asOf:null,basis:'provider-52-week-range'});fields.week52Low=fact(lo,{source,currency:'KRW',unit:'price',asOf:null,basis:'provider-52-week-range'});}
      return {symbol,source,fields};
    }},
    {id:'naver-company',priority:25,ttlMs:statementTtlMs,fields:['sharesOutstanding','trailingEps','annualEps'],match:kr,load:async(symbol,{signal})=>normalizeNaverCompanyFinancials(symbol,await request('https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd='+symbol.slice(0,6),{signal,text:true}),{now:now()})},
    {id:'yahoo-summary',priority:30,priorities:{peTTM:5,peLYR:5,psTTM:5,dividendTTM:5,dividendYieldTTM:5,trailingEps:5},ttlMs:statementTtlMs,lane:'slow',fields:['priceToBook','peTTM','peLYR','psTTM','marketCap','sharesOutstanding','floatShares','dividendTTM','dividendYieldTTM','week52High','week52Low'],load:async(symbol,{signal})=>normalizeYahooFundamentals(symbol,await fetchYahooSummary(symbol,{signal}),{now:now()})},
    {id:'naver-statements',priority:20,ttlMs:statementTtlMs,lane:'slow',fields:['trailingEps','annualEps','revenueTTM','peLYR'],match:q=>us(q)&&q.instrumentType==='EQUITY',load:async(symbol,{signal})=>{
      const b=await basic(symbol,{signal}),path='https://api.stock.naver.com/stock/'+encodeURIComponent(b.reutersCode)+'/finance/';
      const rows=await Promise.allSettled(['summary','quarter','annual'].map(kind=>request(path+kind,{signal})));signal?.throwIfAborted();
      const values=rows.map(r=>r.status==='fulfilled'?r.value:null);
      if(values.every(v=>!v))throw rows[0].reason;
      return normalizeNaverStatements(symbol,values[0]||{reutersCode:b.reutersCode},values[1],values[2],b,{now:now()});
    }},
    {id:'nasdaq-summary',priority:40,ttlMs:60000,fields:['week52High','week52Low','marketCap'],match:us,load:async(symbol,{signal,quote})=>normalizeNasdaqSummary(symbol,await request('https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol)+'/summary?assetclass='+(['ETF','MUTUALFUND'].includes(quote.instrumentType)?'etf':'stocks'),{signal}),{now:now(),currency:quote.currency})},
    {id:'nasdaq-dividends',priority:30,ttlMs:statementTtlMs,lane:'slow',fields:['dividendTTM','dividendYieldTTM'],match:q=>us(q)&&q.currency==='USD',load:async(symbol,{signal,quote})=>normalizeNasdaqDividends(symbol,await request('https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol)+'/dividends?assetclass='+(['ETF','MUTUALFUND'].includes(quote.instrumentType)?'etf':'stocks'),{signal}),{now:now(),currency:quote.currency})},
    {id:'nasdaq-statements',priority:25,ttlMs:statementTtlMs,lane:'slow',fields:['netIncomeTTM','netIncomeAnnual'],match:q=>us(q)&&q.instrumentType==='EQUITY'&&q.currency==='USD',load:async(symbol,{signal})=>{
      const data=await Promise.allSettled([2,1].map(frequency=>request('https://api.nasdaq.com/api/company/'+encodeURIComponent(symbol)+'/financials?frequency='+frequency,{signal})));signal?.throwIfAborted();
      if(data.every(r=>r.status==='rejected'))throw data[0].reason;
      return normalizeNasdaqStatements(symbol,...data.map(r=>r.status==='fulfilled'?r.value:null),{now:now()});
    }}
  ];
  if(pooledFinnhub)sources.push({id:'finnhub-metric',priority:15,ttlMs:statementTtlMs,lane:'slow',fields:['priceToBook','peTTM','peLYR','psTTM'],match:q=>us(q)&&q.instrumentType==='EQUITY',load:async(symbol,{signal})=>normalizeFinnhubFundamentals(symbol,await finnhubJson('/stock/metric?symbol='+encodeURIComponent(symbol)+'&metric=all',{signal}),{now:now()})});
  return sources;
}
