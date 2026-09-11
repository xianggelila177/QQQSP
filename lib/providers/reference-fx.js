import {validateXmlDocument} from '../xml-structure.js';
import {REFERENCE_CURRENCIES,usableFxRates} from '../currency.js';
// Daily ECB reference data. Frankfurter is a second transport for the SAME
// underlying source, not a second independent market quote provider.
export const REFERENCE_FX_URLS=Object.freeze({
  ecb:'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  frankfurter:'https://api.frankfurter.dev/v2/rates?base=USD&quotes='+REFERENCE_CURRENCIES.join(',')+'&providers=ECB&expand=providers',
});
const DAY=86400000,MAX_AGE=7*DAY,MAX_BODY=256*1024;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
function observation(date,now) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('Invalid reference date');
  const at=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==date||at>now||now-at>MAX_AGE)throw new Error('Reference rate date unavailable or expired');
  return at;
}
function body(value){if(typeof value!=='string'||Buffer.byteLength(value)>MAX_BODY)throw new Error('Invalid reference response size');return value;}
function complete(rates){if(!usableFxRates(rates))throw new Error('Incomplete reference rates');return Object.freeze(rates);}
function ecbDocument(text){
  const root=validateXmlDocument(text,{tree:true});
  if(!['Envelope','gesmes:Envelope'].includes(root.name))throw new Error('Invalid ECB root');
  const containers=root.children.filter(n=>n.name==='Cube');
  if(containers.length!==1||containers[0].text.some(t=>t.trim()))throw new Error('Invalid ECB container');
  const dates=containers[0].children;
  if(dates.length!==1||dates[0].name!=='Cube'||!dates[0].attrs.time||dates[0].text.some(t=>t.trim()))throw new Error('Ambiguous ECB date');
  const observation=dates[0],values={};
  for(const node of observation.children){
    const {currency,rate}=node.attrs;
    if(node.name!=='Cube'||node.children.length||node.text.some(t=>t.trim())||!/^[A-Z]{3}$/.test(currency||'')||!/^\d+(?:\.\d+)?$/.test(rate||'')||Object.hasOwn(values,currency))throw new Error('Invalid ECB currency node');
    values[currency]=Number(rate);
    if(!positive(values[currency]))throw new Error('Invalid ECB rate');
  }
  return {date:observation.attrs.time,values};
}
export function parseEcbRates(text,now=Date.now()) {
  text=body(text);if(/<!DOCTYPE|<!ENTITY/i.test(text)||!/<(?:gesmes:)?Envelope\b/.test(text))throw new Error('Invalid ECB XML');
  const {date,values}=ecbDocument(text),observationAt=observation(date,now);
  if(!['USD','CNY'].every(k=>positive(values[k])))throw new Error('ECB currency missing or invalid');
  const usd=values.USD;
  const rates={USD:values.CNY/usd,EUR:1/usd};
  for(const currency of REFERENCE_CURRENCIES)if(currency!=='CNY'&&positive(values[currency]))rates[currency]=values[currency]/usd;
  return {date,observationAt,rates:complete(rates)};
}
export function parseFrankfurterRates(text,now=Date.now()) {
  let rows;try{rows=JSON.parse(body(text));}catch{throw new Error('Invalid Frankfurter JSON');}if(!Array.isArray(rows)||!rows.length||rows.length>REFERENCE_CURRENCIES.length)throw new Error('Invalid Frankfurter rates');
  const values={},dates=new Set();
  for(const row of rows){
    const provider=row?.providers?.[0];
    if(row?.base!=='USD'||!REFERENCE_CURRENCIES.includes(row.quote)||Object.hasOwn(values,row.quote)||!positive(row.rate)||!Array.isArray(row.providers)||row.providers.length!==1||provider?.key!=='ECB'||provider.date!==row.date||provider.rate!==row.rate)throw new Error('Frankfurter identity or rate mismatch');
    dates.add(row.date);values[row.quote]=row.rate;
  }
  if(dates.size!==1)throw new Error('Mixed reference dates');
  const date=[...dates][0],rates={USD:values.CNY};
  for(const [currency,rate] of Object.entries(values))if(currency!=='CNY')rates[currency]=rate;
  return {date,observationAt:observation(date,now),rates:complete(rates)};
}
export function createReferenceFx({httpsGet,now=Date.now,ttlMs=3600000,cooldownMs=300000}={}) {
  let cached=null,inflight=null,attemptAt=null,error=null;const sources={};
  async function getRates(){
    const valid=cached&&now()-cached.observationAt<=MAX_AGE;
    if(valid&&attemptAt!=null&&now()-attemptAt<(error?cooldownMs:ttlMs))return cached;
    if(!valid&&error&&attemptAt!=null&&now()-attemptAt<cooldownMs)throw new Error('Reference FX cooldown');
    if(inflight)return inflight;
    inflight=(async()=>{
      attemptAt=now();
      for(const [name,url]of Object.entries(REFERENCE_FX_URLS)){
        try{
          const response=await httpsGet(url,{}, {timeout:4500});
          if(response?.status!==200)throw new Error('Reference HTTP '+response?.status);
          const parsed=(name==='ecb'?parseEcbRates:parseFrankfurterRates)(response.body,now());
          cached=Object.freeze({...parsed,source:'ECB',transport:name==='ecb'?'ecb-xml':'frankfurter-ecb',retrievedAt:now()});
          sources[name]={ok:true,checkedAt:now(),date:parsed.date};error=null;return cached;
        }catch(cause){sources[name]={ok:false,checkedAt:now(),error:String(cause?.message||cause).slice(0,120)};}
      }
      error='All reference FX transports unavailable';
      if(cached&&now()-cached.observationAt<=MAX_AGE)return cached;
      throw new Error(error);
    })().finally(()=>{inflight=null;});return inflight;
  }
  return Object.freeze({getRates,diagnostics:()=>({underlyingSource:'ECB',date:cached?.date||null,transport:cached?.transport||null,lastAttemptAt:attemptAt,error,sources:{...sources}})});
}
