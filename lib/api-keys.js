import fs from 'node:fs';
import {createHash,timingSafeEqual,randomBytes,randomUUID} from 'node:crypto';
import {atomicWriteFile} from './atomic-file.js';
import {contextError} from './api-error.js';
export const API_SCOPES=Object.freeze(['quote-only','history','macro']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const scopeMap={quote:'quote-only',fundamentals:'quote-only',intraday:'history',daily:'history',samples:'history',corporate_actions:'history',news:'macro',macro:'macro'};
export function requireScopes(principal,sections){if(sections.some(s=>!principal.scopes.includes(scopeMap[s]||s)))throw contextError('INSUFFICIENT_SCOPE',403);}
const constantEqual=(a,b)=>timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export function createApiKeys({apiKey='',file='',now=Date.now}={}){
 let records=[],serial=Promise.resolve();
 if(file){
  try{
   const st=fs.lstatSync(file);if(!st.isFile()||st.size>131072)throw Error('unsafe');
   const state=JSON.parse(fs.readFileSync(file,'utf8'));
   if(state.schemaVersion!==1||!Array.isArray(state.keys)||state.keys.length>256)throw Error('schema');
   const ids=new Set(),hashes=new Set();
   for(const k of state.keys){
    if(!k||typeof k.id!=='string'||k.id.length>80||ids.has(k.id)||typeof k.family!=='string'||k.family.length>80||!/^([0-9a-f]{64})$/.test(k.digest)||hashes.has(k.digest)||!Array.isArray(k.scopes)||!k.scopes.length||k.scopes.some(s=>!API_SCOPES.includes(s))||!['active','rotating','revoked'].includes(k.status)||typeof k.label!=='string'||k.label.length>80||!Number.isFinite(k.createdAt)||k.createdAt<0||k.expiresAt!==null&&(!Number.isFinite(k.expiresAt)||k.expiresAt<k.createdAt)||k.status==='rotating'&&k.expiresAt===null)throw Error('key');
    ids.add(k.id);hashes.add(k.digest);
   }
   records=state.keys;
  }catch(e){if(e.code!=='ENOENT')throw contextError('KEY_STORE_INVALID',503);}
 }
 const legacy=apiKey?{id:'legacy',family:'legacy',digest:digest(apiKey),label:'环境配置密钥',scopes:[...API_SCOPES],status:'active',createdAt:0,expiresAt:null}:null;
 // Replacing/removing the environment key must not leave its imported old value active.
 // A matching managed key retains its managed scopes; the environment cannot elevate it.
 records=records.map(k=>k.id==='legacy'&&(!legacy||k.digest!==legacy.digest)?{...k,id:'retired-env-'+randomUUID(),label:'已替换的环境配置密钥',status:'revoked'}:k);
 function all(){return legacy&&!records.some(k=>k.digest===legacy.digest||k.id==='legacy')?[legacy,...records]:records;}
 function authenticate(req){
  const auth=String(req.headers.authorization||''),match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth);
  if(!match||(req.rawHeaders||[]).filter((v,i)=>i%2===0&&v.toLowerCase()==='authorization').length>1)throw contextError('UNAUTHORIZED',401);
  const hash=digest(match[1]);let found;
  for(const key of all())if(constantEqual(hash,key.digest))found=key;
  if(!found||found.status==='revoked')throw contextError('UNAUTHORIZED',401);
  if(found.expiresAt!==null&&now()>=found.expiresAt)throw contextError(found.status==='rotating'?'KEY_ROTATED':'KEY_EXPIRED',401);
  return {id:found.id,family:found.family,scopes:[...found.scopes],status:found.status,expiresAt:found.expiresAt};
 }
 const view=k=>({id:k.id,label:k.label,scopes:[...k.scopes],status:k.expiresAt!==null&&now()>=k.expiresAt?'expired':k.status,created_at_ms:k.createdAt,expires_at_ms:k.expiresAt});
 function mutate(input){
  const work=serial.then(async()=>{
   if(!file)throw contextError('KEY_STORE_NOT_CONFIGURED',503);
   if(!input||typeof input!=='object'||Array.isArray(input))throw contextError('BAD_KEY_QUERY');
   const next=structuredClone(all());let secret=null,result;
   const action=input.action;
   const keys=action==='create'?['action','label','scopes']:['action','id'];
   if(Object.keys(input).some(k=>!keys.includes(k)))throw contextError('BAD_KEY_QUERY');
   if(action==='create'||action==='rotate'){
    if(next.length>=256)throw contextError('KEY_CAPACITY_EXCEEDED',409);
    const old=action==='rotate'?next.find(k=>k.id===input.id):null;
    if(action==='rotate'&&(!old||old.status!=='active'))throw contextError('KEY_NOT_ACTIVE',409);
    const scopes=old?.scopes||input.scopes,label=old?.label||input.label;
    if(typeof label!=='string'||!label.trim()||label.length>80||!Array.isArray(scopes)||!scopes.length||scopes.length>3||scopes.some(s=>!API_SCOPES.includes(s))||new Set(scopes).size!==scopes.length)throw contextError('BAD_KEY_QUERY');
    const id=randomUUID(),family=old?.family||id;secret=randomBytes(32).toString('base64url');
    if(old){old.status='rotating';old.expiresAt=now()+86400000;}
    const key={id,family,digest:digest(secret),label,scopes:[...scopes],status:'active',createdAt:now(),expiresAt:null};next.push(key);
    result={...view(key),secret,...(old?{previous_id:old.id,previous_expires_at_ms:old.expiresAt}:{} )};
   }else if(action==='revoke'){
    const key=next.find(k=>k.id===input.id);if(!key)throw contextError('KEY_NOT_FOUND',404);
    // Revoke the rotation family, including every key still in its grace period.
    for(const k of next)if(k.family===key.family)k.status='revoked';result=view(key);
   }else throw contextError('BAD_KEY_QUERY');
   try{await atomicWriteFile(file,JSON.stringify({schemaVersion:1,keys:next}));}catch{throw contextError('KEY_STORE_WRITE_FAILED',503);}
   records=next;return result;
  });serial=work.catch(()=>{});return work;
 }
 return {authenticate,mutate,list:()=>({persistent:!!file,keys:all().map(view),rotation_grace_ms:86400000}),flush:()=>serial};
}
