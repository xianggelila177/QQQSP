import {createHash} from 'node:crypto';
import {contextError} from './api-error.js';
/** Merge case-insensitive Vary tokens without losing auth when adding CORS. */
export function authenticatedCors(cors={}){
 const out={},vary=new Map([['authorization','Authorization'],['origin','Origin']]);
 for(const [key,value] of Object.entries(cors)){
  if(key.toLowerCase()==='vary')for(const token of String(value).split(',').map(v=>v.trim()).filter(Boolean))vary.set(token.toLowerCase(),token);
  else out[key]=value;
 }
 return {...out,Vary:vary.has('*')?'*':[...vary.values()].join(', ')};
}
export function semanticEtag(value){
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>!['request_id','generated_at_ms'].includes(k)&&!(v.policy==='published_within_7_days'&&['checked_at_ms','cutoff_ms'].includes(k))).map(k=>[k,stable(v[k])])):v;
 return 'W/"'+createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')+'"';
}
export function etagMatches(header,tag){
 if(!header)return false;
 const values=String(header).split(',').map(v=>v.trim());
 return values.includes('*')||values.some(v=>v.replace(/^W\//,'')===tag.replace(/^W\//,''));
}
export function lifecycleHeaders({deprecation='',sunset=''}={}){
 if(!deprecation)return {};
 return {Deprecation:'@'+Math.floor(Date.parse(deprecation)/1000),Link:'</api-lifecycle.md>; rel="deprecation"; type="text/markdown"',...(sunset?{Sunset:new Date(sunset).toUTCString()}:{})};
}
export function encodeCsv(context){
 const entries=Object.entries(context.sections||{});if(entries.length!==1||!Array.isArray(entries[0][1]?.rows))throw contextError('BAD_CONTEXT_QUERY');
 const [name,section]=entries[0],{rows,...meta}=section;
 const cell=v=>{
  if(v===null||v===undefined)return '';
  if(typeof v==='number')return String(v);
  let text=typeof v==='string'?v:JSON.stringify(v);
  if(/^[\s]*[=+\-@]|^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
 };
 const metadata={schema_version:context.schema_version,request_id:context.request_id,generated_at_ms:context.generated_at_ms,status:context.status,instrument:context.instrument,section:name,metadata:meta,sources:context.sources,quality:context.quality,
  csv:{null:'empty cell',string_escape:'leading apostrophe neutralizes spreadsheet formulas; JSON has unmodified source values'}};
 const header=Buffer.from(JSON.stringify(metadata)).toString('base64url');
 if(Buffer.byteLength(header)>12000)throw contextError('CSV_METADATA_TOO_LARGE',422);
 return {body:section.columns.map(cell).join(',')+'\r\n'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+(rows.length?'\r\n':''),headers:{'Content-Type':'text/csv; charset=utf-8; header=present','Content-Disposition':'attachment; filename="'+context.instrument.symbol.replace(/[^A-Za-z0-9_.-]/g,'_')+'-'+name+'.csv"','X-QQQSP-Metadata':header,'X-QQQSP-Metadata-Encoding':'base64url-json'}};
}
