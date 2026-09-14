import {financialNumber,fact} from '../fundamentals.js';
import {normalizeNaverCompanyShares} from './public-fundamentals.js';
const error=code=>Object.assign(new Error('Financial source validation failed'),{code});
export function sourceNumber(value){
  if(typeof value==='number')return financialNumber(value);
  if(typeof value!=='string')return null;
  const s=value.trim();if(!/^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?:배|원|%)?$/.test(s))return null;
  return financialNumber(s.replaceAll(',','').replace(/[배원%]$/,''));
}
const money=v=>typeof v==='string'?sourceNumber(v.replace(/^([+-]?)\$/,'$1')):sourceNumber(v);
const date=text=>{const m=/^(\d{4})[.-](\d{2})[.-](\d{2})\.?$/.exec(text||'');if(!m)return null;const t=Date.UTC(+m[1],+m[2]-1,+m[3]);return new Date(t).toISOString().slice(0,10)===m.slice(1).join('-')?t:null;};
const usDate=text=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text||'');return m?date(m[3]+'-'+m[1]+'-'+m[2]):null;};
function put(fields,key,value,metadata,{positive=false}={}){const n=sourceNumber(value);if(n==null||positive&&n<=0)return;fields[key]=fact(n,metadata);}
const currencyOf=raw=>raw==='GBp'||raw==='GBX'?'GBP':raw==='ZAc'||raw==='ZAC'?'ZAR':/^[A-Z]{3}$/.test(raw||'')?raw:null;
export function normalizeNaverBasic(symbol,payload,{now=Date.now()}={}){
  if(String(payload?.symbolCode||'').toUpperCase()!==symbol)throw error('FUNDAMENTALS_IDENTITY');
  const source='naver-basic',currency=currencyOf(payload.currencyType?.code),rows=Object.fromEntries((payload.stockItemTotalInfos||[]).map(r=>[r.code,r])),fields={};
  const kind=payload.isEtf===true?'ETF':'EQUITY',meta={source,asOf:null,quoteReferenceAt:Date.parse(payload.localTradedAt)||null};
  put(fields,'sharesOutstanding',payload.countOfListedStock,{...meta,unit:'shares'},{positive:true});
  const high=sourceNumber(rows.highPriceOf52Weeks?.value),low=sourceNumber(rows.lowPriceOf52Weeks?.value);
  if(high>0&&low>0&&high>=low&&currency)for(const [key,value] of [['week52High',high],['week52Low',low]])put(fields,key,value,{...meta,currency,unit:'price',basis:'provider-52-week-range'});
  if(kind==='EQUITY'){
    put(fields,'priceToBook',rows.pbr?.value,{...meta,unit:'ratio',basis:'latest-book'});
    if(currency){put(fields,'marketCap',payload.marketValueFullRaw,{...meta,currency,unit:'money'},{positive:true});put(fields,'bookValue',rows.bps?.value,{...meta,currency,unit:'money-per-share',basis:'latest-book'});}
  }
  return {symbol,source,instrumentType:kind,fetchedAt:now,fields};
}
function actualPeriods(titles,now){
  const rows=(titles||[]).filter(r=>r.isConsensus==='N').map(r=>({key:r.key,time:date(r.key)})).filter(r=>r.time!=null&&r.time<=now).sort((a,b)=>a.time-b.time);
  return [...new Map(rows.map(r=>[r.key,r])).values()];
}
function consecutive(periods){return periods.length===4&&periods.slice(1).every((p,i)=>{const days=(p.time-periods[i].time)/86400000;return days>=70&&days<=110;});}
export function normalizeNaverStatements(symbol,summary,quarter,annual,basic,{now=Date.now()}={}){
  if(summary?.reutersCode!==basic?.reutersCode||basic?.symbolCode!==symbol)throw error('FUNDAMENTALS_IDENTITY');
  const source='naver-statements',currency=currencyOf(basic.currencyType?.code),fields={},eps=summary.chartEps;
  const period=actualPeriods(eps?.trTitleList,now).slice(-4),columns=eps?.columns||[],dates=columns.find(r=>r[0]==='x'),values=columns.find(r=>r[0]==='EPS');
  const amounts=period.map(p=>sourceNumber(values?.[dates?.indexOf(p.key)])),baseRows=Object.fromEntries((basic.stockItemTotalInfos||[]).map(r=>[r.code,r]));
  // The summary chart has a generic Korean unit label even for US EPS. Require
  // a native-currency statement and reconcile four reported EPS quarters with
  // the provider's basic EPS before trusting that per-share currency/basis.
  const nativeCurrency=String(quarter?.unit||'').match(/^([A-Z]{3})\(백만\)/)?.[1];
  const lastReported=actualPeriods(eps?.trTitleList,now).at(-1)?.key;
  const referenceDate=String(baseRows.eps?.keyDesc||'').slice(0,7),reference=sourceNumber(baseRows.eps?.value);
  const total=amounts.every(v=>v!=null)?amounts.reduce((a,b)=>a+b,0):null;
  if(currency&&currency===nativeCurrency&&consecutive(period)&&period.at(-1)?.key===lastReported&&referenceDate===lastReported?.slice(0,7)&&reference!=null&&total!=null&&Math.abs(total-reference)<=.030001){
    put(fields,'trailingEps',total,{source,asOf:null,currency,unit:'money-per-share',basis:'trailing-twelve-months',financialPeriod:lastReported.replaceAll('.','-'),periods:period.map(p=>p.key),calculated:true,estimated:true,formula:'sum of four reported quarterly EPS; reconciled to provider EPS'});
  }
  const quarters=actualPeriods(quarter?.trTitleList,now).slice(-4),revenue=quarter?.rowList?.find(r=>r.title==='매출액'),sales=quarters.map(p=>sourceNumber(revenue?.columns?.[p.key]?.value));
  if(currency===nativeCurrency&&currency&&consecutive(quarters)&&sales.every(v=>v!=null&&v>=0))put(fields,'revenueTTM',sales.reduce((a,b)=>a+b,0)*1e6,{source,asOf:null,currency,unit:'money',financialPeriod:quarters.at(-1).key.replaceAll('.','-'),periods:quarters.map(p=>p.key),basis:'trailing-twelve-months',calculated:true,formula:'sum of four reported native-currency revenues * 1000000'},{positive:true});
  const year=actualPeriods(annual?.trTitleList,now).at(-1),annualCurrency=String(annual?.unit||'').match(/^([A-Z]{3})\(백만\)/)?.[1];
  if(year&&currency&&currency===annualCurrency){
    const row=annual.rowList?.find(r=>r.title==='EPS');
    put(fields,'annualEps',row?.columns?.[year.key]?.value,{source,asOf:null,currency,unit:'money-per-share',financialPeriod:year.key.replaceAll('.','-'),basis:'last-fiscal-year'});
    // Historical annual PER is not silently recalculated as today's fiscal PE.
    const per=annual.rowList?.find(r=>r.title==='PER');
    put(fields,'peLYR',per?.columns?.[year.key]?.value,{source,asOf:year.time,unit:'ratio',financialPeriod:year.key.replaceAll('.','-'),basis:'last-fiscal-year',historical:true,priceBasis:'provider-fiscal-year-snapshot'});
  }
  return {symbol,source,fetchedAt:now,fields};
}
export function normalizeNasdaqSummary(symbol,payload,{currency='USD',now=Date.now()}={}){
  if(payload?.data?.symbol!==symbol)throw error('FUNDAMENTALS_IDENTITY');
  const source='nasdaq-summary',fields={},data=payload.data.summaryData||{},range=data.FiftTwoWeekHighLow?.value?.split('/');
  if(range?.length===2){const hi=money(range[0]),lo=money(range[1]);if(hi>0&&lo>0&&hi>=lo)for(const [key,value] of [['week52High',hi],['week52Low',lo]])put(fields,key,value,{source,currency,unit:'price',asOf:null,basis:'provider-52-week-range'});}
  if(payload.data.assetClass==='STOCKS')put(fields,'marketCap',money(data.MarketCap?.value),{source,currency,unit:'money',asOf:null},{positive:true});
  return {symbol,source,fetchedAt:now,fields};
}
export function normalizeNasdaqDividends(symbol,payload,{currency='USD',now=Date.now()}={}){
  if(payload?.data?.symbol&&payload.data.symbol!==symbol)throw error('FUNDAMENTALS_IDENTITY');
  if(/Dividend History for Non-Nasdaq symbols is not available/i.test(payload?.message||''))throw error('FUNDAMENTALS_UNSUPPORTED');
  const rows=payload?.data?.dividends?.rows;if(!Array.isArray(rows)||!rows.length)throw error('FUNDAMENTALS_EMPTY');
  const source='nasdaq-dividends',cutoff=new Date(now);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1);
  const history=rows.filter(r=>r.type==='Cash').map(r=>({...r,time:usDate(r.paymentDate),value:money(r.amount)}));
  if(!history.some(r=>r.time!=null&&r.time<=cutoff.getTime()))throw error('FUNDAMENTALS_INCOMPLETE');
  // Invalid recent rows are not equivalent to an omitted payment. Fail closed.
  const lastPaid=usDate(payload.data.dividendPaymentDate);
  if(history.some(r=>r.time==null&&!(lastPaid!=null&&lastPaid<=cutoff.getTime()&&usDate(r.exOrEffDate)!=null&&usDate(r.exOrEffDate)<=cutoff.getTime())||r.time>cutoff.getTime()&&r.time<=now&&(r.value==null||r.value<0)))throw error('FUNDAMENTALS_INCOMPLETE');
  const payments=history.filter(r=>r.time>cutoff.getTime()&&r.time<=now);
  if(payments.some(r=>r.currency?r.currency!==currency:currency!=='USD'||!String(r.amount).startsWith('$')))throw error('FUNDAMENTALS_CURRENCY');
  const unique=[...new Map(payments.map(r=>[r.paymentDate+'|'+r.exOrEffDate+'|'+r.amount,r])).values()];
  const value=unique.reduce((sum,r)=>sum+r.value,0);
  return {symbol,source,fetchedAt:now,fields:{dividendTTM:fact(value,{source,currency,unit:'money-per-share',asOf:now,basis:'trailing-twelve-months',calculated:true,formula:'sum of cash payments in the past 12 months',paymentCount:unique.length,windowStart:cutoff.getTime(),windowEnd:now,identityBasis:'requested-symbol-route'})}};
}
export function normalizeNasdaqStatements(symbol,quarter,annual,{now=Date.now()}={}){
  const source='nasdaq-statements',fields={};
  for(const [payload,kind] of [[quarter,'quarter'],[annual,'annual']]){
    if(!payload)continue;if(payload.data?.symbol!==symbol)throw error('FUNDAMENTALS_IDENTITY');
    const table=payload.data.incomeStatementTable;
    if(!table||table.headers?.value1!==(kind==='quarter'?'Quarterly Ending:':'Period Ending:'))continue;
    const periods=Object.entries(table.headers).filter(([key])=>key!=='value1').map(([key,value])=>{const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);return {key,time:m?date(m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0')):null};}).filter(p=>p.time!=null&&p.time<=now).sort((a,b)=>a.time-b.time).slice(kind==='quarter'?-4:-1);
    if(kind==='quarter'&&!consecutive(periods)||!periods.length)continue;
    // Nasdaq explicitly labels its financial tables "In USD Thousands":
    // https://www.nasdaq.com/market-activity/stocks/amd/financials
    // Use common-shareholder profit, not operating profit or total net income.
    const common=table.rows?.find(r=>r.value1==='Net Income Applicable to Common Shareholders');
    const amounts=periods.map(p=>money(common?.[p.key]));
    if(amounts.some(v=>v==null))continue;
    const key=kind==='quarter'?'netIncomeTTM':'netIncomeAnnual';
    put(fields,key,amounts.reduce((a,b)=>a+b,0)*1000,{source,currency:'USD',unit:'money',asOf:null,basis:kind==='quarter'?'trailing-twelve-months':'last-fiscal-year',financialPeriod:new Date(periods.at(-1).time).toISOString().slice(0,10),periods:periods.map(p=>new Date(p.time).toISOString().slice(0,10)),calculated:true,formula:kind==='quarter'?'sum of four common-shareholder income quarters * 1000':'reported fiscal common-shareholder income * 1000'});
  }
  return {symbol,source,fetchedAt:now,fields};
}
export function normalizeNaverCompanyFinancials(symbol,html,{now=Date.now()}={}){
  const record=normalizeNaverCompanyShares(symbol,html,{now}),fields={...record.fields},source='naver-company';
  const table=[...html.matchAll(/<table\b[^>]*>[\s\S]{0,40000}?<\/table>/g)].map(m=>m[0]).find(t=>/\d{4}\/\d{2}\(A\)/.test(t)&&/<th\b[^>]*>EPS<\/th>/.test(t));
  const headers=table?.match(/<thead>[\s\S]*?<\/thead>/)?.[0]||'',labels=[...headers.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map(m=>m[1]);
  const actual=labels.map((label,index)=>({m:/^(\d{4})\/(\d{2})\(A\)$/.exec(label),index})).filter(x=>x.m&&Number(x.m[2])>=1&&Number(x.m[2])<=12&&Date.UTC(+x.m[1],+x.m[2],0)<=now).sort((a,b)=>a.m[0].localeCompare(b.m[0])).at(-1);
  const row=table?.match(/<th\b[^>]*>EPS<\/th>([\s\S]*?)<\/tr>/)?.[1]||'',values=[...row.matchAll(/<td\b[^>]*>([^<]*)<\/td>/g)].map(m=>sourceNumber(m[1]));
  const annual=actual?values[actual.index-1]:null;
  if(annual!=null)put(fields,'annualEps',annual,{source,currency:'KRW',unit:'money-per-share',asOf:null,basis:'last-fiscal-year',financialPeriod:actual.m[1]+'-'+actual.m[2]});
  const current=sourceNumber(html.match(/<dt>\s*EPS\s*<b\b[^>]*>([^<]+)<\/b>/)?.[1]),explanation=html.match(/<div class="exp">([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]*>|\s/g,'')||'';
  // The provider declares header EPS as TTM, with a fiscal EPS fallback when
  // TTM is absent. A distinct actual fiscal EPS rules out that fallback. Never
  // consume the adjacent (E)/consensus column as historical earnings.
  if(annual!=null&&current!=null&&current!==annual&&explanation.includes('EPS(TTM)')&&explanation.includes('최근4분기합산'))put(fields,'trailingEps',current,{source,currency:'KRW',unit:'money-per-share',asOf:null,basis:'trailing-twelve-months',basisVerification:'provider TTM definition; distinct actual fiscal EPS'});
  return {...record,fields};
}
