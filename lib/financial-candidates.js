import {financialNumber,BASIC_FIELDS} from './fundamentals.js';
import {currencyUnitInfo} from './currency.js';

export const INPUT_FIELDS=['trailingEps','annualEps','revenueTTM','bookValue','netIncomeTTM','netIncomeAnnual'];
export const FINANCIAL_FIELDS=[...BASIC_FIELDS,'week52High','week52Low',...INPUT_FIELDS];
const positiveKeys=new Set(['sharesOutstanding','floatShares','lotSize','marketCap','floatMarketCap','week52High','week52Low','revenueTTM']);
export function usableFinancialField(key,field){
  if(!field||typeof field!=='object')return false;
  if(['loss','nonpositive-book'].includes(field.status))return ['peTTM','peLYR','priceToBook'].includes(key);
  const value=financialNumber(field.value);
  return value!=null&&(!positiveKeys.has(key)||value>0)&&(!['dividendTTM','dividendYieldTTM'].includes(key)||value>=0);
}
export function normalizeFinancialRecord(symbol,value,{source,now,ttlMs,maxAgeMs,previous}={}){
  if(value?.symbol!==symbol||!value.fields)throw Object.assign(new Error('Financial identity mismatch'),{code:'FUNDAMENTALS_IDENTITY'});
  const fields={...previous?.fields};let received=0;
  for(const key of FINANCIAL_FIELDS){
    const item=value.fields[key];if(!usableFinancialField(key,item))continue;
    fields[key]={...item,value:financialNumber(item.value),source:item.source||source,providerId:source,fetchedAt:now,freshUntil:now+ttlMs,expiresAt:now+maxAgeMs};received++;
  }
  if(!received)throw Object.assign(new Error('No usable financial fields'),{code:'FUNDAMENTALS_EMPTY'});
  return {...value,source,fields,fetchedAt:now,statistics:value.statistics??previous?.statistics};
}
export const financialPriority=(source,key)=>source.priorities?.[key]??source.priority??source.order??0;
export function selectFinancialRecord(symbol,entries,sources,{now,maxAgeMs}={}){
  const candidates=new Map(),fields={},sourceMap=new Map(sources.map((s,i)=>[s.id,{order:i,...s}]));
  for(const entry of entries){
    const record=entry?.data;if(record?.symbol!==symbol)continue;
    const spec=sourceMap.get(entry.id)||{id:entry.id,order:-1};
    for(const key of FINANCIAL_FIELDS){
      const field=record.fields?.[key],fetchedAt=field?.fetchedAt??record.fetchedAt;
      if(!usableFinancialField(key,field)||!Number.isFinite(fetchedAt)||fetchedAt>now+5000||now>=Math.min(field.expiresAt??Infinity,fetchedAt+maxAgeMs))continue;
      const stale=!!entry.failure||!!field.stale||now>=(field.freshUntil??fetchedAt+(spec.ttlMs||60000));
      const normalized={...field,source:field.source||record.source,providerId:entry.id,fetchedAt,stale,backup:spec.order>0,financialPeriod:field.financialPeriod??record.financialPeriod??null};
      const list=candidates.get(key)||[];list.push({field:normalized,rank:financialPriority(spec,key),record});candidates.set(key,list);
    }
  }
  const sort=(a,b)=>Number(a.field.stale)-Number(b.field.stale)||a.rank-b.rank||(b.field.asOf||0)-(a.field.asOf||0)||b.field.fetchedAt-a.field.fetchedAt;
  for(const [key,list] of candidates)fields[key]=list.sort(sort)[0].field;
  // Both ends of a 52-week range must come from one definition and observation.
  const pairs=(candidates.get('week52High')||[]).flatMap(high=>{const low=(candidates.get('week52Low')||[]).find(v=>v.field.providerId===high.field.providerId&&v.field.value<=high.field.value&&['currency','unit','basis','asOf','fetchedAt'].every(key=>(v.field[key]??null)===(high.field[key]??null)));return low?[{...high,low:low.field}]:[];}).sort(sort);
  delete fields.week52High;delete fields.week52Low;
  if(pairs.length){fields.week52High=pairs[0].field;fields.week52Low=pairs[0].low;}
  const stamps=Object.values(fields).map(f=>f.fetchedAt);
  const identity=entries.find(e=>e.data?.symbol===symbol&&['ETF','MUTUALFUND','EQUITY'].includes(e.data.instrumentType)&&now-(e.data.fetchedAt||0)<maxAgeMs)?.data.instrumentType;
  return stamps.length?{symbol,instrumentType:identity,source:[...new Set(Object.values(fields).map(f=>f.source))].join('+'),fetchedAt:Math.max(...stamps),fields}:null;
}
export function deriveFinancialFields(quote,record){
  if(!record)return record;
  const fields={...record.fields},unit=quote.currency?currencyUnitInfo(quote.currency):{currency:null,scale:1},base=[unit.currency,unit.scale];
  const price=financialNumber(quote.regularPrice??quote.regularMarketPrice??quote.price),at=quote.regularQuoteAt??quote.tradingStats?.asOf??(quote.priceSession==='REGULAR'?quote.quoteAt??quote.ts:null);
  function ratio(key,input,denominator,numerator,formula,basis){
    const replaceAnnual=key==='peLYR'&&(fields[key]?.historical||!fields[key]?.financialPeriod&&input?.financialPeriod);
    if(usableFinancialField(key,fields[key])&&!replaceAnnual||!input||input.currency!==base[0]||denominator==null||!(numerator>0))return;
    const capBased=formula.startsWith('market-cap');
    fields[key]={...input,value:denominator>0?numerator/denominator:null,status:denominator>0?'available':denominator<0&&key.startsWith('pe')?'loss':key==='priceToBook'?'nonpositive-book':'unavailable',
      reason:denominator>0?undefined:denominator<0&&key.startsWith('pe')?'negative-earnings':'nonpositive-denominator',unit:'ratio',basis,asOf:capBased?fields.marketCap?.asOf:at,estimated:true,calculated:true,formula,stale:!!(input.stale||quote.stale||capBased&&fields.marketCap?.stale),
      inputs:[{name:'denominator',value:denominator,source:input.source,asOf:input.asOf,period:input.financialPeriod},{name:'numerator',value:numerator,source:capBased?fields.marketCap?.source:quote.src,asOf:capBased?fields.marketCap?.asOf:at}]};
  }
  if(price>0){ratio('peTTM',fields.trailingEps,financialNumber(fields.trailingEps?.value),price*base[1],'regular-price / trailing-EPS','trailing-twelve-months');ratio('peLYR',fields.annualEps,financialNumber(fields.annualEps?.value),price*base[1],'regular-price / fiscal-year-EPS','last-fiscal-year');ratio('priceToBook',fields.bookValue,financialNumber(fields.bookValue?.value),price*base[1],'regular-price / book-value-per-share','latest-book');}
  if(fields.marketCap?.currency===base[0])ratio('psTTM',fields.revenueTTM,financialNumber(fields.revenueTTM?.value),fields.marketCap?.value,'market-cap / trailing-revenue','trailing-twelve-months');
  if(fields.marketCap?.currency===base[0]){ratio('peTTM',fields.netIncomeTTM,financialNumber(fields.netIncomeTTM?.value),fields.marketCap.value,'market-cap / trailing-common-income','trailing-twelve-months');ratio('peLYR',fields.netIncomeAnnual,financialNumber(fields.netIncomeAnnual?.value),fields.marketCap.value,'market-cap / annual-common-income','last-fiscal-year');}
  if(!usableFinancialField('dividendYieldTTM',fields.dividendYieldTTM)&&fields.dividendTTM?.currency===base[0]&&fields.dividendTTM.value>=0&&price>0)fields.dividendYieldTTM={...fields.dividendTTM,value:fields.dividendTTM.value/(price*base[1])*100,unit:'percent',calculated:true,formula:'paid-dividends-12m / regular-price * 100',asOf:at,stale:!!(fields.dividendTTM.stale||quote.stale)};
  return {...record,fields};
}
