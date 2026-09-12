// Optional authenticated calendar. Forecast is economist consensus; TEForecast is
// the provider's model and is NEVER substituted for missing consensus.
import {providerRetryAt} from './provider-retry.js';
const DAY=864e5;
const stamp=value=>{const s=String(value||'');if(!/^\d{4}-\d\d-\d\dT/.test(s))return null;const n=Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(s)?s:s+'Z');return Number.isFinite(n)?n:null;};
const pct=(value,unit)=>{const s=String(value??'').trim();if(!/^[+-]?\d+(?:\.\d+)?%?$/.test(s)||(!s.endsWith('%')&&unit!=='%'))return null;return Number(s.replace('%',''));};
const safeLink=value=>{try{const u=new URL(value);return /^https?:$/.test(u.protocol)?u.href:null;}catch{return null;}};
export function createMacroCalendar({httpsGet,key='',now=Date.now}={}){
 let data=[],updatedAt=null,error=null,nextAt=0,inflight=null,closed=false;
 const frozen=new Map();
 function normalize(rows){
  const current=now(),out=[];
  for(const row of rows.slice(0,500)){
   if(row.Country!=='United States'||!/CPI|Inflation Rate|PCE Price Index|Fed Interest Rate|EIA.*(?:Crude|Gasoline)/i.test(row.Event||''))continue;
   const time=stamp(row.Date),reference=String(row.Reference||''),name=String(row.Event||'');
   if(!time||time<current-2*DAY||time>current+3*DAY)continue;
   const identity=[row.CalendarId??row.CalendarID,name,reference,row.ReferenceDate,time].join('|');
   const actual=String(row.Actual??'').trim(),forecast=String(row.Forecast??'').trim(),precise=String(row.DateSpan)==='0';
   if(precise&&time>current&&!actual&&forecast)frozen.set(identity,{value:forecast,capturedAt:current,releaseAt:time});
   const snapshot=frozen.get(identity),consensus=snapshot?.value??forecast;
   const isInflation=/CPI|Inflation Rate|PCE Price Index/i.test(name)&&/MoM|YoY/i.test(name);
   const av=pct(actual,row.Unit),fv=pct(consensus,row.Unit),published=precise&&time<=current&&!!actual;
   const difference=published&&reference&&isInflation&&av!==null&&fv!==null?+(av-fv).toFixed(4):null;
   const direction=difference===null?'unknown':difference<0?'positive':difference>0?'negative':'unknown';
   out.push({id:String(row.CalendarId??row.CalendarID??identity),event:name,reference,releaseAt:time,timePrecision:precise?'exact':'estimated',status:published?'released':'scheduled',
    actual:published?actual:null,consensus:consensus||null,currentConsensus:forecast||null,modelForecast:String(row.TEForecast||'')||null,
    consensusBasis:snapshot?'captured-before-scheduled-release':forecast?'provider-current-unfrozen':'missing',consensusCapturedAt:snapshot?.capturedAt??null,
    previous:String(row.Previous||'')||null,previousBeforeRevision:String(row.Revised||'')||null,unit:String(row.Unit||''),
    importance:[1,2,3].includes(row.Importance)?row.Importance:null,source:String(row.Source||''),link:safeLink(row.SourceURL),lastUpdate:stamp(row.LastUpdate),surprise:difference,
    direction,label:direction==='positive'?'纳指：条件偏利多':direction==='negative'?'纳指：条件偏利空':'方向待验证',
    caveat:difference!==null?'仅通胀意外的条件传导；需核对核心分项、增长与利率反应。不是收益预测。':'尚无可比通胀意外；能源库存、政策决定不能机械套用通胀方向。'});
  }
  for(const [id,v]of frozen)if(v.releaseAt<current-2*DAY)frozen.delete(id);
  while(frozen.size>64)frozen.delete(frozen.keys().next().value);
  return out.sort((a,b)=>Math.abs(a.releaseAt-current)-Math.abs(b.releaseAt-current)).slice(0,12);
 }
 function snapshot(){return {enabled:!!key,status:!key?'disabled':error?'error':inflight?'loading':updatedAt?'ready':'waiting',items:data,updatedAt,nextAt,error,
  note:key?'来源为Trading Economics；服务端在已知发布前记录共识并持久化，未提前取得时不补造历史记录。':'结构化一致预期未配置；仍可使用官方订阅和报道证据，不将模型预测填为市场共识。'};}
 async function refresh(){
  if(!key||closed)return snapshot();if(inflight){await inflight;return snapshot();}if(now()<nextAt)return snapshot();
  nextAt=now()+300000;
  inflight=(async()=>{try{
   const start=new Date(now()-DAY).toISOString().slice(0,10),end=new Date(now()+3*DAY).toISOString().slice(0,10);
   const response=await httpsGet(`https://api.tradingeconomics.com/calendar/country/united%20states/${start}/${end}?f=json`,{Authorization:key,Accept:'application/json'});
   if(response.status!==200)throw Object.assign(new Error('日历接口 HTTP '+response.status),{status:response.status,retryAt:providerRetryAt(response.headers,now())});
   const rows=JSON.parse(response.body);if(!Array.isArray(rows))throw new Error('日历响应格式无效');
   data=normalize(rows);updatedAt=now();error=null;
   const near=data.some(x=>Math.abs(x.releaseAt-now())<15*60000);nextAt=now()+(near?60000:300000);
  }catch(e){error=Number.isInteger(e.status)?'日历接口 HTTP '+e.status:'日历来源暂不可用';nextAt=[401,403].includes(e.status)?Number.MAX_SAFE_INTEGER:Math.max(now()+300000,Number(e.retryAt)||0);}
  finally{inflight=null;}})();await inflight;return snapshot();
 }
 return {getCalendar:refresh,requestCalendar(){if(key&&!closed&&!inflight&&now()>=nextAt)void refresh();return snapshot();},snapshot,exportState:()=>({version:1,frozen:[...frozen]}),restore(state){if(state?.version!==1||!Array.isArray(state.frozen))return;for(const [id,v] of state.frozen.slice(-64)){if(typeof id==='string'&&typeof v?.value==='string'&&Number.isFinite(v.capturedAt)&&Number.isFinite(v.releaseAt)&&v.capturedAt<v.releaseAt&&v.capturedAt<=now()&&v.releaseAt>now()-2*DAY)frozen.set(id,v);}},close(){closed=true;},reopen(){closed=false;},clear(){data=[];frozen.clear();updatedAt=null;error=null;nextAt=0;}};
}
