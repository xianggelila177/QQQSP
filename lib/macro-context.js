import {validPrice as priceIsValid} from './price-values.js';
import {instrumentTypeFor} from './instruments.js';
// Sampling is server-owned. Source timestamps are never replaced by request times.
export const MACRO_FACTORS=Object.freeze([
 {id:'nq',symbol:'NQ00Y.FUT',name:'纳指100期货',unit:'点',changeMode:'percent'},
 {id:'wti',symbol:'CL00Y.FUT',name:'WTI原油',unit:'美元/桶',changeMode:'percent'},
 {id:'brent',symbol:'BZ=F',name:'布伦特原油',unit:'美元/桶',changeMode:'percent'},
 {id:'rates',symbol:'^TNX',name:'美债10年指标',unit:'来源数值',changeMode:'absolute'},
 {id:'dollar',symbol:'DX-Y.NYB',name:'美元指数',unit:'点',changeMode:'percent'},
]);
const WINDOWS=[900000,300000,60000],MAX_AGE=120000,RETENTION=1800000;
const validPrice=q=>q&&priceIsValid(q.price,q.instrumentType||instrumentTypeFor(q.symbol));
const stamp=n=>typeof n==='number'&&Number.isFinite(n)&&n>0?n:null;
const quoteTime=q=>stamp(q?.quoteAt);
const fields=['symbol','instrumentType','price','quoteAt','sourceCheckedAt','src','source','currency','priceBasis','contractSymbol','quoteTradingDate','tradingDate','feedDelayMinutes','feedCoverage','stale','recovery','pollAfterMs','nextPollAt','unit','displayName','observationDate','daily','proxy','providerSymbol','sourceTimeText','sourceTimeZone','sourceUrl','sourcePollAfterMs','selectedSource','diagnostics','delayed','declaredRealtime','marketState','quoteTimePrecision'];
export function createMacroContext({readQuote,now=Date.now,pollMs=30000}={}){
 const states=new Map(MACRO_FACTORS.map(f=>[f.id,{quote:null,error:null,nextAt:0,samples:[],observations:[],identity:null,diagnostics:[],attemptAt:null}]));
 const tasks=new Map(),listeners=new Set();let closed=false,epoch=0;
 function notify(){if(!closed)for(const fn of listeners)try{fn(snapshot());}catch{ /* UI subscriber cannot stop collection */ }}
 function accept(f,s,value){
  if(!validPrice(value))throw Object.assign(new Error('来源没有有效价格'),{code:'MACRO_EMPTY'});
  const q=Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
  s.diagnostics=q.diagnostics||[];
  const identity=[q.symbol||f.symbol,q.providerSymbol||'',q.src||q.source||'',q.currency||'',q.unit||f.unit,q.priceBasis||'',q.contractSymbol||'',q.quoteTradingDate||q.tradingDate||''].join('|');
  if(!q.stale&&!q.recovery&&s.identity===identity&&quoteTime(s.quote)&&quoteTime(q)&&q.quoteAt<s.quote.quoteAt){
   s.diagnostics=[...s.diagnostics,{source:q.src||q.source||f.symbol,status:'ignored',code:'MACRO_OLD_QUOTE',message:'丢弃较旧报价，保留最新有效价格及原始时点'}];
   s.error=null;return;
  }
  if(s.quote&&((q.stale||q.recovery)&&((q.quoteAt||q.sourceCheckedAt||0)<(s.quote.quoteAt||s.quote.sourceCheckedAt||0))||
    s.identity===identity&&quoteTime(s.quote)&&quoteTime(q)&&q.quoteAt<s.quote.quoteAt)){
   s.error='来源返回较旧缓存，保留已有报价';return;
  }
  if(identity!==s.identity){s.identity=identity;s.samples=[];s.observations=[];}
  s.quote=q;s.error=null;const t=quoteTime(q),clock=now(),checked=stamp(q.sourceCheckedAt);
  if(q.stale||q.recovery||q.daily||q.feedDelayMinutes>0||q.delayed||q.marketState==='CLOSED')return;
  const add=(array,time)=>{
   if(time&&time<=clock+1000&&clock-time<=MAX_AGE&&(!array.length||time>array.at(-1).t))array.push({t:time,price:q.price});
   return array.filter(p=>p.t>=clock-RETENTION).slice(-180);
  };
  if(t)s.samples=add(s.samples,t);
  // Record both bases when available. Compare only a common basis; never use
  // a read time as quoteAt, and never launder delayed trades as fresh reads.
  if(!t||clock-t<=MAX_AGE&&clock-t>=-1000)s.observations=add(s.observations,checked);
 }
 function windowsFor(f,q,array,end,basis){return WINDOWS.map(ms=>{
  const tolerance=Math.min(60000,ms*.2),target=end-ms;
  const anchor=array.filter(p=>p.t<end&&Math.abs(p.t-target)<=tolerance).sort((a,b)=>Math.abs(a.t-target)-Math.abs(b.t-target))[0];
  if(!basis||!anchor||f.changeMode==='percent'&&anchor.price===0)return {windowMs:ms,change:null};
  const change=f.changeMode==='percent'?(q.price/anchor.price-1)*100:q.price-anchor.price;
  return {windowMs:ms,change:+change.toFixed(4),windowStart:anchor.t,windowEnd:end,basis};
 });}
 function snapshot(){
  const clock=now();
  const factors=MACRO_FACTORS.map(f=>{
   const s=states.get(f.id),q=s.quote,t=quoteTime(q),checked=stamp(q?.sourceCheckedAt);
   const clean=validPrice(q)&&!(q.feedDelayMinutes>0)&&!q.delayed&&q.marketState!=='CLOSED'&&!q.stale&&!q.recovery&&!q.daily&&!s.error;
   const fresh=!!(clean&&t&&clock-t>=-1000&&clock-t<=MAX_AGE);
   const observed=!!(clean&&checked&&clock-checked>=-1000&&clock-checked<=MAX_AGE&&(!t||fresh));
   const basis=fresh?'source':observed?'observation':null,array=fresh?s.samples:observed?s.observations:[],end=fresh?t:checked;
   const windows=windowsFor(f,q,array,end,basis),observationWindows=windowsFor(f,q,s.observations,checked,observed?'observation':null);
   const selected=windows.find(w=>w.change!==null),loading=tasks.has(f.id);
   const dailyExpired=q?.daily&&(q.stale||q.recovery||Number.isFinite(Date.parse(q.observationDate||''))&&clock-Date.parse(q.observationDate)>14*864e5);
   const checkedRecently=checked&&clock-checked>=-1000&&clock-checked<=MAX_AGE;
   const currentDelayed=(q?.delayed||q?.feedDelayMinutes>0)&&checkedRecently&&!q.stale&&!q.recovery&&(!t||clock-t>=-1000&&clock-t<=(Math.max(0,q.feedDelayMinutes||0)*60000+MAX_AGE));
   const status=s.error?'error':!q?(loading?'loading':'unavailable'):q.daily?(dailyExpired?'stale':'daily'):q.marketState==='CLOSED'&&checkedRecently?'closed':currentDelayed?'delayed':!basis?'stale':selected?'ready':'warming';
   const unavailableCached=status==='stale'&&s.diagnostics.some(d=>['error','cooldown'].includes(d.status));
   const availability=unavailableCached?'来源暂不可用，保留旧价；按冷却时间重试':status==='error'?'请求失败，已保留可用缓存；按冷却时间重试':status==='daily'?'日度参考，不用于分钟比较':status==='delayed'?(q.feedDelayMinutes>0?'来源声明延迟 '+q.feedDelayMinutes+' 分钟；仍按计划更新':'来源声明为延迟报价，未给出分钟数；仍按计划更新'):status==='closed'?'来源显示休市，保留最后报价并继续检查':status==='stale'?'来源陈旧、延迟或时间未知':basis==='observation'?'服务器观察采样，非成交时间':basis==='source'?'按来源时间采样':loading?'正在请求候选来源':'尚未取得来源';
   return {...f,name:q?.displayName||f.name,unit:q?.unit||f.unit,symbol:q?.symbol||f.symbol,requestedSymbol:f.symbol,
    price:validPrice(q)?q.price:null,quoteAt:t,sourceCheckedAt:checked,source:q?.src||q?.source||null,sourceUrl:q?.sourceUrl||null,contractSymbol:q?.contractSymbol||null,ageMs:t?Math.max(0,clock-t):null,
    fresh,observed,status,loading,error:s.error,feedDelayMinutes:Number.isFinite(q?.feedDelayMinutes)?q.feedDelayMinutes:null,
    feedCoverage:q?.feedCoverage||'来源授权及延迟未核验',priceBasis:q?.priceBasis||null,proxy:!!q?.proxy,daily:!!q?.daily,
    observationDate:q?.observationDate||null,sourceTimeText:q?.sourceTimeText||null,sourceTimeZone:q?.sourceTimeZone||null,
    delayed:!!(q?.delayed||q?.feedDelayMinutes>0),marketState:q?.marketState||null,declaredRealtime:q?.declaredRealtime??null,
    comparisonBasis:basis,change:selected?.change??null,changeUnit:f.changeMode==='percent'?'%':q?.unit==='%'?'百分点':'来源数值差',
    windowMs:selected?.windowMs??60000,windowStart:selected?.windowStart??null,windowEnd:selected?.windowEnd??null,windows,observationWindows,
    nextCheckAt:s.nextAt,attemptAt:s.attemptAt,samples:s.samples.length,observationSamples:s.observations.length,
    sampledMs:array.length>1?array.at(-1).t-array[0].t:0,diagnostics:s.diagnostics||[],availability};
  });
  const by=Object.fromEntries(factors.map(f=>[f.id,f]));let pair=null;
  // Prefer the longest common event window. Only then try a common read window.
  for(const basis of ['source','observation']){
   for(const ms of WINDOWS){
    const select=f=>(basis==='source'?f.windows:f.observationWindows).find(x=>x.windowMs===ms&&x.basis===basis);
    const a=select(by.nq),b=select(by.wti),tolerance=Math.min(60000,ms*.2);
    if(a?.change!=null&&b?.change!=null&&Math.abs(a.windowStart-b.windowStart)<=tolerance&&Math.abs(a.windowEnd-b.windowEnd)<=tolerance){pair={nq:a,wti:b,windowMs:ms,basis};break;}
   }
   if(pair)break;
  }
  const parts=[];
  if(pair){
   const lead=`近${pair.windowMs/60000}分钟${pair.basis==='observation'?'服务器观察':'来源时间'}窗口：`;
   if(pair.wti.change<-.1&&pair.nq.change>.1)parts.push(lead+'WTI回落、纳指走高；与成本缓和假设相容，但不能确认资金由原油转入纳指。');
   else if(pair.wti.change<-.1&&pair.nq.change<-.1)parts.push(lead+'原油与纳指同跌，需求或避险冲击也可能解释；油价下跌不自动构成利多。');
   else parts.push(lead+'未观察到“油跌、纳指涨”组合；不作资金流向判断。');
   if(pair.basis==='observation')parts.push('观察时间不是成交时间，可能包含网站延迟，不能称作同步市场反应。');
  }else{
   const missing=[by.nq,by.wti].filter(x=>!x.comparisonBasis);
   parts.push(missing.length?'跨资产比较暂停：'+missing.map(x=>x.name+'（'+x.availability+'）').join('、')+'。日度参考不会补成分钟行情。':'后台正在积累观察窗口，约1分钟开始提供短窗，随后扩展为5分钟、15分钟；仅比较相同时间基础。');
  }
  return {schemaVersion:2,refreshing:tasks.size>0,observedAt:clock,pollMs,windowMs:pair?.windowMs??60000,
   comparison:pair?(pair.basis==='source'?'comparable':'observations'):'waiting',comparisonBasis:pair?.basis??null,factors,observations:parts,
   limitations:['价格共变不证明资金转移。','替代观察源与期货合约不是同一个序列，切换后重建采样窗口。','缺少发布前预期或利率响应，不把条件解释当交易结论。'],nextCheckAt:Math.min(...[...states.values()].map(s=>s.nextAt))};
 }
 function startDue(){
  if(closed)return;
  for(const f of MACRO_FACTORS){const s=states.get(f.id);if(tasks.has(f.id)||now()<s.nextAt)continue;
   const started=now(),owner=epoch;s.attemptAt=started;s.nextAt=started+pollMs;
   const task=Promise.resolve().then(()=>readQuote(f.symbol)).then(q=>{
    if(closed||owner!==epoch)return;accept(f,s,q);const due=Number(q?.nextPollAt);s.nextAt=Math.max(s.nextAt,started+Number(q?.pollAfterMs||0),Number.isFinite(due)&&due>started&&due<=started+86400000?due:0);
   }).catch(e=>{if(!closed&&owner===epoch){s.error=String(e?.message||e).slice(0,240);s.diagnostics=e.diagnostics||[{source:f.symbol,status:'error',code:e.code||'NETWORK',message:s.error,retryAt:e.retryAt}];s.nextAt=Math.max(now()+60000,Number(e?.retryAt)||0);}}
   ).finally(()=>{if(tasks.get(f.id)===task)tasks.delete(f.id);if(owner===epoch)notify();});
   tasks.set(f.id,task);
  }
 }
 async function settled(){await Promise.allSettled([...tasks.values()]);return snapshot();}
 async function getContext({wait=true}={}){startDue();return wait?settled():snapshot();}
 function restore(data){if(!data||data.version!==1||!Array.isArray(data.states))return;
  for(const [id,value]of data.states){const s=states.get(id);if(!s||!validPrice(value?.quote))continue;
   s.quote=value.quote;s.identity=String(value.identity||'');s.error=null;s.nextAt=0;s.diagnostics=value.diagnostics||[];
   const valid=arr=>Array.isArray(arr)?arr.filter(p=>p&&stamp(p.t)&&p.t<=now()+1000&&p.t>=now()-RETENTION&&priceIsValid(p.price,value.quote.instrumentType||instrumentTypeFor(value.quote.symbol))).slice(-180):[];
   s.samples=valid(value.samples);s.observations=valid(value.observations);
  }
 }
 return {getContext,settled,snapshot,exportState:()=>({version:1,states:[...states]}),restore,
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  requestContext(){startDue();return snapshot();},close(){closed=true;epoch++;tasks.clear();},reopen(){closed=false;},
  clear(){epoch++;tasks.clear();for(const s of states.values())Object.assign(s,{quote:null,samples:[],observations:[],error:null,nextAt:0,identity:null,diagnostics:[]});}};
}
export function macroIndexQuote(data,symbol,now=Date.now()){
 const m=data?.meta;
 if(!m||m.symbol!==symbol||!['INDEX','CURRENCY'].includes(m.instrumentType)||typeof m.regularMarketPrice!=='number'||!Number.isFinite(m.regularMarketPrice))throw new Error('指标来源身份或价格无效');
 return {symbol,price:m.regularMarketPrice,quoteAt:typeof m.regularMarketTime==='number'?m.regularMarketTime*1000:null,sourceCheckedAt:now,src:'Yahoo 指标',currency:m.currency||null,
  priceBasis:'Yahoo来源原始指标值，不进行比例猜测',feedDelayMinutes:Number.isFinite(m.exchangeDataDelayedBy)?m.exchangeDataDelayedBy:null,feedCoverage:'指标来源口径；延迟及单位以来源为准'};
}
