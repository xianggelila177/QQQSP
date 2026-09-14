import {financialNumber,fact} from '../fundamentals.js';
import {tencentCodeFor} from '../instruments.js';
import {providerRetryAt} from './provider-retry.js';
const failure=(code='FUNDAMENTALS_EMPTY')=>Object.assign(new Error('Public financial data unavailable'),{code});
const korean=symbol=>/^\d{6}\.(KS|KQ)$/.test(symbol);
const record=(symbol,source,fields,now,extra={})=>({symbol,source,fields,fetchedAt:now,refreshAfterMs:60000,...extra});

export function normalizeNaverKoreanFundamentals(symbol,payload,{now=Date.now()}={}) {
  if(!korean(symbol)||payload?.itemCode!==symbol.slice(0,6))throw failure('FUNDAMENTALS_IDENTITY');
  const pbr=payload.totalInfos?.find(row=>row.code==='pbr');
  const text=String(pbr?.value||'').trim();
  const value=/^[+-]?\d+(?:\.\d+)?(?:배)?$/.test(text)?financialNumber(text.replace(/배$/,'')):null;
  if(value==null)throw failure();
  const source='naver-financial',period=/^(\d{4})\.(\d{2})\.$/.exec(pbr.valueDesc||'');
  return record(symbol,source,{priceToBook:fact(value,{source,asOf:null,unit:'ratio',basis:'latest-book'})},now,
    {financialPeriod:period?period[1]+'-'+period[2]:null});
}

export function normalizeNaverCompanyShares(symbol,html,{now=Date.now()}={}) {
  const identity=String(html).match(/<input\b[^>]*\bid="hd_cmp_cd"[^>]*\bvalue="(\d{6})"[^>]*>/)?.[1];
  if(!korean(symbol)||identity!==symbol.slice(0,6))throw failure('FUNDAMENTALS_IDENTITY');
  // Read the labelled issued-share row, never market cap / last price or a
  // rounded free-float percentage. The provider gives no share effective date.
  const cell=String(html).match(/<th\b[^>]*>\s*발행주식수\/유동비율\s*<\/th>\s*<td\b[^>]*>([\s\S]{0,500}?)<\/td>/)?.[1];
  const digits=cell?.trim().match(/^((?:\d{1,3}(?:,\d{3})+)|\d+)주\s*\//)?.[1];
  const value=financialNumber(digits?.replaceAll(',',''));
  if(!Number.isSafeInteger(value)||value<=0)throw failure();
  const source='naver-company';
  return record(symbol,source,{sharesOutstanding:fact(value,{source,asOf:null,unit:'shares'})},now);
}

export function createPublicFundamentalsProvider({httpsGet,fetchTencent,now=Date.now}={}) {
  async function request(url,signal){
    const response=await httpsGet(url,{Referer:'https://m.stock.naver.com/'},{signal,timeout:6000});
    if(response.status!==200)throw Object.assign(failure('FUNDAMENTALS_SOURCE'),{retryAt:providerRetryAt(response.headers,now(),60000)});
    return response.body;
  }
  return async function fetchPublicFundamentals(symbol,{signal}={}){
    signal?.throwIfAborted();
    const taskSignal=AbortSignal.any([AbortSignal.timeout(7000),...(signal?[signal]:[])]);
    if(korean(symbol)){
      const code=symbol.slice(0,6);
      const jobs=await Promise.allSettled([
        request('https://m.stock.naver.com/api/stock/'+code+'/integration',taskSignal).then(body=>normalizeNaverKoreanFundamentals(symbol,JSON.parse(body),{now:now()})),
        request('https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd='+code,taskSignal).then(body=>normalizeNaverCompanyShares(symbol,body,{now:now()}))
      ]);
      taskSignal.throwIfAborted();
      const records=jobs.filter(job=>job.status==='fulfilled').map(job=>job.value);
      if(!records.length)throw jobs.find(job=>job.status==='rejected').reason;
      return record(symbol,records.map(r=>r.source).join('+'),Object.assign({},...records.map(r=>r.fields)),now(),{financialPeriod:records.find(r=>r.financialPeriod)?.financialPeriod||null});
    }
    if(!tencentCodeFor(symbol)||symbol.endsWith('.HK')||!fetchTencent)return null;
    const rows=await fetchTencent([symbol],{signal:taskSignal});taskSignal.throwIfAborted();
    return rows.find(row=>row.symbol===symbol)?.financials||null;
  };
}
