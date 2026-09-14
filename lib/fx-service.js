import { usableFxRates, currencyUnitInfo } from './currency.js';

// Keep whole source snapshots. Selection is per quote currency, and rates plus
// provenance are returned atomically so concurrent USD/GBP reads cannot pair
// Yahoo prices with an ECB timestamp or mix their currencies together.
export function createFxService({getPrimary,primaryMetadata=()=>({}),getReference,canUsePrimary=()=>true,referenceOnly=false,now=Date.now}={}) {
  let primary=null,reference=null,primaryInflight=null,referenceInflight=null;
  let primaryAttemptAt=null,referenceAttemptAt=null,primaryError=null,referenceError=null;
  const emptyRates=Object.freeze({});
  function metadata(snapshot,error){
    if(!snapshot)return {fxAsOf:null,fxKind:null,fxSource:null,fxDate:null,fxStale:true};
    const expired=now()-snapshot.checkedAt>(snapshot.fxKind==='reference'?7*86400000:120000);
    return {fxAsOf:snapshot.fxAsOf,fxFetchedAt:snapshot.fxFetchedAt,fxKind:snapshot.fxKind,fxSource:snapshot.fxSource,fxTransport:snapshot.fxTransport,fxDate:snapshot.fxDate,fxAsOfPrecision:snapshot.fxKind==='reference'?'date':'retrieved-at',fxStale:!!error||expired};
  }
  const contains=(snapshot,currency)=>snapshot&&(currency==='CNY'||currency==='USD'?usableFxRates(snapshot.rates):usableFxRates(snapshot.rates)&&typeof snapshot.rates[currency]==='number'&&Number.isFinite(snapshot.rates[currency])&&snapshot.rates[currency]>0);
  function fxSnapshotFor(raw='USD'){
    const currency=currencyUnitInfo(raw).currency;
    const candidates=[[primary,primaryError],[reference,referenceError]];
    const selected=candidates.find(([s,e])=>contains(s,currency)&&!metadata(s,e).fxStale)||candidates.find(([s])=>contains(s,currency))||candidates.find(([s])=>s);
    return selected?{rates:selected[0].rates,...metadata(...selected)}:{rates:emptyRates,...metadata(null)};
  }
  async function refreshPrimary(){
    if(primaryInflight)return primaryInflight;
    if(primaryAttemptAt!=null&&now()-primaryAttemptAt<60000)return;
    primaryInflight=(async()=>{
      primaryAttemptAt=now();
      try{
        if(!canUsePrimary())throw new Error('Primary FX cooling down');
        const rates=await getPrimary(),meta=primaryMetadata();
        if(!usableFxRates(rates)||meta.fxStale===true)throw new Error('Primary FX incomplete or stale');
        primary={rates:Object.freeze({...rates}),fxAsOf:meta.fxAsOf??now(),fxFetchedAt:now(),fxKind:'market',fxSource:'Yahoo',fxTransport:'yahoo',fxDate:null,checkedAt:now()};primaryError=null;
      }catch(cause){primaryError=String(cause?.message||cause).slice(0,120);}
    })().finally(()=>{primaryInflight=null;});return primaryInflight;
  }
  async function refreshReference(){
    if(referenceInflight)return referenceInflight;
    if(referenceAttemptAt!=null&&now()-referenceAttemptAt<60000)return;
    referenceInflight=(async()=>{
      referenceAttemptAt=now();
      try{
        const ref=await getReference();
        if(!usableFxRates(ref.rates)||!Number.isFinite(ref.observationAt)||now()-ref.observationAt>7*86400000||ref.observationAt>now())throw new Error('Reference FX expired or invalid');
        reference={rates:Object.freeze({...ref.rates}),fxAsOf:ref.observationAt,fxFetchedAt:ref.retrievedAt,fxKind:'reference',fxSource:'ECB',fxTransport:ref.transport,fxDate:ref.date,checkedAt:ref.observationAt};referenceError=null;
      }catch(cause){referenceError=String(cause?.message||cause).slice(0,120);}
    })().finally(()=>{referenceInflight=null;});return referenceInflight;
  }
  async function getFxSnapshot(raw='USD'){
    if(referenceOnly){await refreshReference();return fxSnapshotFor(raw);}
    await refreshPrimary();
    const currency=currencyUnitInfo(raw).currency;
    if(!contains(primary,currency)||metadata(primary,primaryError).fxStale)await refreshReference();
    return fxSnapshotFor(raw);
  }
  const getFxRates=async currency=>(await getFxSnapshot(currency)).rates;
  const fxMetadata=currency=>{const {rates,...meta}=fxSnapshotFor(currency);return meta;};
  return Object.freeze({getFxRates,getFxSnapshot,fxSnapshotFor,fxMetadata,fxFallbackRates:currency=>fxSnapshotFor(currency).rates,diagnostics:()=>({...fxMetadata(),lastAttemptAt:primaryAttemptAt,referenceAttemptAt,error:primaryError||referenceError})});
}
