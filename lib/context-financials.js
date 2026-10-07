import {FINANCIAL_FIELDS} from './financial-candidates.js';
import {METRIC_CATALOG,applicableMetric} from './metric-catalog.js';
import {number,text,list,legacyTime,timestamp,max,common,failureCode} from './context-values.js';

// Whitelist every evidence field. Never expose raw payloads, provider errors or keys.
export function buildContextFinancials({quote,type,source,error}) {
  const f=quote?.fundamentals,fields={};
  for (const key of FINANCIAL_FIELDS) {
    const applicable=applicableMetric(key,type);
    const item=applicable?(f?.fields?.[key]||{}):{};
    const value=number(item.value);
    const status=!applicable?'not-applicable':text(item.status)||(value!==null?'available':'unavailable');
    const freshness=item.contentFreshness||{},comparison=item.comparison||{};
    fields[key]={value,status,unit:text(item.unit)||METRIC_CATALOG[key].unit,currency:text(item.currency),
      source_id:source(item.source),as_of_ms:legacyTime(item.asOf),source_checked_at_ms:timestamp(item.fetchedAt),
      financial_period:text(item.financialPeriod),basis:text(item.basis),stale:!!item.stale,
      business_date:text(item.businessDate),date_precision:text(item.datePrecision),date_basis:text(item.dateBasis),source_published_at_ms:timestamp(item.sourcePublishedAt),
      cache_stale:!!item.cacheStale,identity_basis:text(item.identityBasis),quality_warnings:list(item.qualityWarnings).map(text).filter(Boolean).slice(0,16),
      content_freshness:{status:text(freshness.status)||'unverified',reason:text(freshness.reason)||'freshness-metadata-unavailable',reference_at_ms:timestamp(freshness.referenceAt),age_days:number(freshness.ageDays),max_age_days:number(freshness.maxAgeDays),basis:text(freshness.basis),latest_report_verified:false},
      comparison:{status:text(comparison.status)||'unverified',reason:text(comparison.reason)||'comparison-metadata-unavailable',threshold_fraction:number(comparison.thresholdFraction),candidates:list(comparison.candidates).slice(0,8).map(candidate=>({source_id:source(candidate.source),value:number(candidate.value),as_of_ms:legacyTime(candidate.asOf),financial_period:text(candidate.financialPeriod)}))},
      calculated:!!item.calculated,estimated:!!item.estimated,formula:text(item.formula),
      missing_reason:value===null?(!applicable?'INSTRUMENT_TYPE':text(item.reason)||failureCode(error,'SOURCE_FIELD_UNAVAILABLE')):null,
      denominator:number(item.denominator),share_source_id:source(item.shareSource),share_as_of_ms:legacyTime(item.shareAsOf),
      quote_reference_at_ms:legacyTime(item.quoteReferenceAt),depth:number(item.depth),historical:!!item.historical,backup:!!item.backup,
      inputs:list(item.inputs).slice(0,16).map(input=>({name:text(input.name),value:number(input.value),source_id:source(input.source),as_of_ms:legacyTime(input.asOf),financial_period:text(input.period||input.financialPeriod)})),
      attempts:list(item.attempts).slice(0,16).map(a=>({source_id:source(a.source),state:text(a.state),code:failureCode(a.code,null),last_success_at_ms:timestamp(a.lastSuccessAt),retry_at_ms:timestamp(a.retryAt)}))};
  }
  const applicable=Object.values(fields).filter(v=>v.status!=='not-applicable');
  const available=applicable.filter(v=>(v.value!==null&&!['unavailable','conflict','expired'].includes(v.status))||['loss','nonpositive-book'].includes(v.status));
  const notApplicable=!['EQUITY','ETF','MUTUALFUND'].includes(type);
  const incomplete=available.length<applicable.length;
  const unverified=available.filter(v=>v.content_freshness.status==='unverified'),conflicting=available.filter(v=>v.comparison.status==='disagreement');
  const status=notApplicable?'not_applicable':!available.length?'unavailable':incomplete||f?.stale||f?.loading||error||unverified.length||conflicting.length||applicable.some(v=>v.stale)?'partial':'ready';
  return {...common({status,sources:Object.values(fields).flatMap(v=>[v.source_id,...v.comparison.candidates.map(c=>c.source_id)]),
    asOf:max(Object.values(fields).map(v=>v.as_of_ms)),checkedAt:max(Object.values(fields).map(v=>v.source_checked_at_ms)),
    coverage:{expected_fields:FINANCIAL_FIELDS.length,applicable_fields:applicable.length,available_fields:available.length,
      freshness_unverified_fields:Object.entries(fields).filter(([,v])=>unverified.includes(v)).map(([k])=>k),conflicting_fields:Object.entries(fields).filter(([,v])=>conflicting.includes(v)).map(([k])=>k),
      missing_fields:Object.entries(fields).filter(([,v])=>v.status!=='not-applicable'&&!available.includes(v)).map(([k])=>k)},
    adjustment:'field_specific',reason:notApplicable?'INSTRUMENT_TYPE':error?failureCode(error,'SOURCE_UNAVAILABLE'):!available.length?'NO_FUNDAMENTALS':incomplete?'PARTIAL_DATA':null}),
    data:{financial_period:text(f?.financialPeriod),fields}};
}
