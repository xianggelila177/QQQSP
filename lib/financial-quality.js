// Acquisition time is not the financial fact's effective date. These generous
// age windows detect clearly obsolete reports; they do not certify that no
// newer filing exists, or replace an issuer's fiscal/disclosure calendar.
export const PRICE_SENSITIVE_FIELDS=new Set(['priceToBook','peTTM','peLYR','psTTM','marketCap','floatMarketCap','dividendYieldTTM']);
export const REPORT_FIELDS=new Set(['priceToBook','peTTM','peLYR','psTTM','trailingEps','annualEps','revenueTTM','bookValue','netIncomeTTM','netIncomeAnnual']);
const DAY=86400000;
function periodTime(value){
  const quarter=/^(\d{4})Q([1-4])$/.exec(value||'');
  if(quarter)return Date.UTC(+quarter[1],+quarter[2]*3,0);
  const match=/^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value||'');
  if(!match||+match[2]<1||+match[2]>12)return null;
  const time=match[3]?Date.UTC(+match[1],+match[2]-1,+match[3]):Date.UTC(+match[1],+match[2],0);
  return new Date(time).toISOString().slice(0,match[3]?10:7)===value?time:null;
}
export function financialContentFreshness(key,field,now){
  const report=REPORT_FIELDS.has(key),hasPeriod=typeof field.financialPeriod==='string'&&!!field.financialPeriod;
  const effective=typeof field.asOf==='number'&&Number.isFinite(field.asOf)&&field.asOf>0?(field.asOf<1e12?field.asOf*1000:field.asOf):null;
  const referenceAt=hasPeriod?periodTime(field.financialPeriod):report?null:effective;
  const annual=field.basis==='last-fiscal-year'||['peLYR','annualEps','netIncomeAnnual'].includes(key);
  const quarterly=/^\d{4}Q[1-4]$/.test(field.financialPeriod||'')||field.basis==='trailing-twelve-months'||['peTTM','psTTM','trailingEps','revenueTTM','netIncomeTTM'].includes(key);
  const maxAgeDays=hasPeriod?(annual?550:quarterly?240:550):report?null:PRICE_SENSITIVE_FIELDS.has(key)?14:550;
  const base={referenceAt,ageDays:referenceAt==null?null:Math.max(0,(now-referenceAt)/DAY),maxAgeDays,basis:hasPeriod?'report-period-age-screen':'source-effective-date',latestReportVerified:false};
  if(referenceAt==null)return {...base,status:hasPeriod?'invalid':'unverified',reason:hasPeriod?'invalid-report-period':report?'report-period-unknown':'effective-date-unknown'};
  if(referenceAt>now+5000)return {...base,status:'invalid',reason:hasPeriod?'future-report-period':'future-effective-date'};
  if(base.ageDays>maxAgeDays)return {...base,status:'stale',reason:hasPeriod?'report-period-old':'effective-date-old'};
  if(PRICE_SENSITIVE_FIELDS.has(key)&&effective==null)return {...base,status:'unverified',reason:'valuation-effective-date-unknown'};
  if(effective>now+5000)return {...base,referenceAt:effective,ageDays:0,basis:'source-effective-date',status:'invalid',reason:'future-effective-date'};
  if(PRICE_SENSITIVE_FIELDS.has(key)&&!field.historical&&(now-effective)/DAY>14)return {...base,referenceAt:effective,ageDays:(now-effective)/DAY,maxAgeDays:14,basis:'valuation-effective-date',status:'stale',reason:'valuation-effective-date-old'};
  return {...base,status:'within-age-window',reason:'latest-report-not-independently-verified'};
}

// A comparison is meaningful only when both providers declare the same
// economic definition. Null/null metadata is not proof of an equal basis.
function comparable(key,a,b){
  if(!a.basis||a.basis!==b.basis||!a.unit||a.unit!==b.unit)return false;
  if(['money','price','money-per-share'].includes(a.unit)&&(!a.currency||a.currency!==b.currency))return false;
  if((a.currency||b.currency)&&a.currency!==b.currency)return false;
  if(REPORT_FIELDS.has(key)&&(!a.financialPeriod||a.financialPeriod!==b.financialPeriod))return false;
  if(REPORT_FIELDS.has(key)&&(!a.accountingBasis||a.accountingBasis!==b.accountingBasis))return false;
  for(const name of ['adjustment','shareBasis'])if((a[name]||b[name])&&a[name]!==b[name])return false;
  if(PRICE_SENSITIVE_FIELDS.has(key)||!REPORT_FIELDS.has(key)){
    if(!Number.isFinite(a.asOf)||!Number.isFinite(b.asOf)||Math.abs(a.asOf-b.asOf)>60000)return false;
  }
  return true;
}
export function financialComparison(key,selected,alternatives){
  if(typeof selected.value!=='number'||!Number.isFinite(selected.value))return {status:'not-comparable',reason:'numeric-value-required',thresholdFraction:null,candidates:[]};
  const seen=new Set([selected.source]),rows=[];
  for(const field of alternatives){
    if(seen.has(field.source)||field.stale||typeof field.value!=='number'||!Number.isFinite(field.value))continue;
    seen.add(field.source);rows.push(field);
  }
  const matches=rows.filter(field=>comparable(key,selected,field));
  const thresholdFraction=.1;
  const describe=field=>({source:field.source,value:field.value,asOf:field.asOf??null,financialPeriod:field.financialPeriod??null});
  if(!matches.length)return {status:rows.length?'not-comparable':'single-source',reason:rows.length?'compatible-basis-period-and-time-required':'no-independent-comparable-candidate',thresholdFraction:null,candidates:[]};
  const comparableRows=[selected,...matches];
  const disagreement=matches.some(field=>Math.abs(field.value-selected.value)/Math.max(Math.abs(field.value),Math.abs(selected.value),1e-12)>thresholdFraction);
  return {status:disagreement?'disagreement':'consistent',reason:disagreement?'comparable-source-values-differ':'within-comparison-tolerance',thresholdFraction,candidates:comparableRows.slice(0,8).map(describe)};
}
