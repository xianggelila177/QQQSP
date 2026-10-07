import {fact,financialNumber} from '../financial-values.js';
import {twseListingFor} from './twse-listings.js';
import {createSharedTasks} from '../shared-task.js';
import {providerRetryAt} from './provider-retry.js';

const BASE='https://openapi.twse.com.tw/v1';
const unavailable=code=>Object.assign(new Error('TWSE financial data unavailable'),{code});
// BWIBBU_d methodology: close / reference earnings from the last four
// reported quarters; PB uses the latest reported quarter's reference book.
// DividendYield includes stock dividends and is NOT our paid-cash TTM yield.
export const TWSE_FINANCIAL_METHOD='https://www.twse.com.tw/zh/trading/historical/bwibbu-day.html';
function dateOf(value,{roc=false}={}){
  const raw=String(value||'').trim(),size=roc?7:8;
  if(!new RegExp('^\\d{'+size+'}$').test(raw))return null;
  const year=Number(raw.slice(0,size-4))+(roc?1911:0),month=raw.slice(-4,-2),day=raw.slice(-2);
  const date=`${year}-${month}-${day}`,at=Date.parse(date+'T00:00:00+08:00');
  return Number.isFinite(at)&&new Date(at+28800000).toISOString().slice(0,10)===date?{date,at}:null;
}
function uniqueRow(symbol,rows,key){
  const listing=twseListingFor(symbol);
  if(!listing||listing.instrumentType!=='EQUITY')throw unavailable('FUNDAMENTALS_UNSUPPORTED');
  if(!Array.isArray(rows))throw unavailable('FUNDAMENTALS_SOURCE');
  const matches=rows.filter(row=>row?.[key]===listing.code);
  if(matches.length!==1)throw unavailable(matches.length?'FUNDAMENTALS_IDENTITY':'FUNDAMENTALS_EMPTY');
  return matches[0];
}
export function normalizeTwseValuations(symbol,rows,{now=Date.now()}={}){
  const row=uniqueRow(symbol,rows,'Code'),date=dateOf(row.Date),source='twse-valuations';
  if(!date||date.at>now)throw unavailable('FUNDAMENTALS_DATE');
  const period=/^\d{4}Q[1-4]$/.test(row.FiscalYearQuarter||'')?row.FiscalYearQuarter:null;
  if(period){
    const end=Date.UTC(Number(period.slice(0,4)),Number(period.slice(-1))*3,0)-28800000;
    if(end>date.at)throw unavailable('FUNDAMENTALS_DATE');
  }
  const fields={};
  for(const [key,column,basis] of [['peTTM','PEratio','twse-reference-four-quarters-daily-close'],['priceToBook','PBratio','twse-reference-latest-quarter-daily-close']]){
    const value=financialNumber(row[column]);
    if(value>0)fields[key]=fact(value,{source,currency:'TWD',unit:'ratio',asOf:date.at,
      financialPeriod:period,basis,identityBasis:'twse-listing-code',datePrecision:'day',dateBasis:'valuation-business-date',businessDate:date.date});
  }
  return {symbol,source,instrumentType:'EQUITY',fields};
}
export function normalizeTwseCompany(symbol,rows,{now=Date.now()}={}){
  const row=uniqueRow(symbol,rows,'公司代號'),date=dateOf(row['出表日期'],{roc:true}),source='twse-company';
  if(!date||date.at>now)throw unavailable('FUNDAMENTALS_DATE');
  const shares=financialNumber(row['已發行普通股數或TDR原股發行股數']);
  // Restricted to verified ordinary TWSE listings. A US ADR's share count
  // cannot be substituted with its issuer's Taiwan ordinary shares.
  return {symbol,source,instrumentType:'EQUITY',fields:shares>0&&Number.isSafeInteger(shares)?{
    sharesOutstanding:fact(shares,{source,unit:'shares',asOf:null,basis:'twse-issued-ordinary-shares',
      identityBasis:'twse-listing-code',datePrecision:'day',dateBasis:'dataset-publication',sourcePublishedAt:date.at,businessDate:date.date})}:{}};
}
export function createTwseFinancialSources({httpsGet,now=Date.now}={}){
  const tasks=createSharedTasks(),cache=new Map();
  async function dataset(path,ttlMs,{signal}={}){
    signal?.throwIfAborted();const cached=cache.get(path);
    if(cached&&now()-cached.at<ttlMs)return cached.rows;
    return tasks.run(path,async taskSignal=>{
      const response=await httpsGet(BASE+path,{Accept:'application/json',Referer:'https://www.twse.com.tw/'},{signal:taskSignal,timeout:12000});
      if(response.status!==200)throw Object.assign(unavailable(response.status===429?'RATE_LIMITED':'FUNDAMENTALS_SOURCE'),{retryAt:providerRetryAt(response.headers,now(),60000)});
      let rows;try{rows=JSON.parse(response.body);}catch{throw unavailable('FUNDAMENTALS_SOURCE');}
      if(!Array.isArray(rows)||!rows.length||rows.length>20000)throw unavailable('FUNDAMENTALS_SOURCE');
      taskSignal.throwIfAborted();cache.set(path,{rows,at:now()});return rows;
    },{signal});
  }
  const match=q=>q.instrumentType==='EQUITY'&&q.currency==='TWD'&&!!twseListingFor(q.symbol);
  return [
    {id:'twse-valuations',priority:10,ttlMs:300000,fields:['peTTM','priceToBook'],match,
      load:async(symbol,{signal})=>normalizeTwseValuations(symbol,await dataset('/exchangeReport/BWIBBU_d',300000,{signal}),{now:now()})},
    {id:'twse-company',priority:10,ttlMs:21600000,lane:'slow',fields:['sharesOutstanding'],match,
      load:async(symbol,{signal})=>normalizeTwseCompany(symbol,await dataset('/opendata/t187ap03_L',21600000,{signal}),{now:now()})}
  ];
}
