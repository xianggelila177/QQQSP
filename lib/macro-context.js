// Lazy, bounded cross-asset observations. No subscriptions, timers, database, or extra watchlist slots.
export const MACRO_FACTORS=Object.freeze([
 {id:'nq',symbol:'NQ00Y.FUT',name:'纳指100期货',unit:'点',changeMode:'percent'},
 {id:'wti',symbol:'CL00Y.FUT',name:'WTI原油',unit:'美元/桶',changeMode:'percent'},
 {id:'brent',symbol:'BZ=F',name:'布伦特原油',unit:'美元/桶',changeMode:'percent'},
 {id:'rates',symbol:'^TNX',name:'美债10年指标',unit:'来源数值',changeMode:'absolute'},
 {id:'dollar',symbol:'DX-Y.NYB',name:'美元指数',unit:'点',changeMode:'percent'},
]);
const WINDOW=15*60000,MAX_AGE=120000,TOLERANCE=60000;
function validPrice(q){return q&&typeof q.price==='number'&&Number.isFinite(q.price)&&q.price>0;}
function quoteTime(q){return typeof q?.quoteAt==='number'&&Number.isFinite(q.quoteAt)&&q.quoteAt>0?q.quoteAt:null;}
export function createMacroContext({readQuote,now=Date.now,pollMs=30000}={}){
 const states=new Map(MACRO_FACTORS.map(f=>[f.id,{quote:null,error:null,nextAt:0,samples:[],identity:null}]));
 let inflight=null,closed=false;
 function accept(f,s,q){
  if(!validPrice(q))throw new Error('来源没有有效价格');
  s.quote=q;s.error=null;
  const t=quoteTime(q),clock=now();
  if(!t||t>clock+1000||clock-t>MAX_AGE||q.feedDelayMinutes>0||q.stale||q.recovery)return;
  const identity=[f.symbol,q.src||q.source||'',q.currency||'',q.priceBasis||'',q.contractSymbol||'',q.quoteTradingDate||q.tradingDate||''].join('|');
  if(identity!==s.identity){s.identity=identity;s.samples=[];}
  if(s.samples.length&&t<=s.samples.at(-1).t)return;
  s.samples.push({t,price:q.price});s.samples=s.samples.filter(p=>p.t>=clock-2*WINDOW).slice(-90);
 }
 function factorSnapshot(f){
  const s=states.get(f.id),q=s.quote,t=quoteTime(q),clock=now();
  const fresh=validPrice(q)&&t!==null&&clock-t>=-1000&&clock-t<=MAX_AGE&&!(q.feedDelayMinutes>0)&&!q.stale&&!q.recovery&&!s.error;
  const target=clock-WINDOW;
  const candidates=s.samples.filter(p=>p.t<t&&Math.abs(p.t-target)<=TOLERANCE);
  const anchor=candidates.sort((a,b)=>Math.abs(a.t-target)-Math.abs(b.t-target))[0];
  const change=fresh&&anchor?(f.changeMode==='percent'?(q.price/anchor.price-1)*100:q.price-anchor.price):null;
  return {...f,price:validPrice(q)?q.price:null,quoteAt:t,sourceCheckedAt:q?.sourceCheckedAt??null,source:q?.src||q?.source||null,
   ageMs:t?Math.max(0,clock-t):null,fresh,status:s.error?'error':!q?'unavailable':!fresh?'stale':change===null?'warming':'ready',
   error:s.error,feedDelayMinutes:Number.isFinite(q?.feedDelayMinutes)?q.feedDelayMinutes:null,
   feedCoverage:q?.feedCoverage||'来源延迟及连续合约换月口径未核验',priceBasis:q?.priceBasis||null,
   change:change===null?null:+change.toFixed(4),changeUnit:f.changeMode==='percent'?'%':'来源数值差',windowStart:change===null?null:anchor.t,windowEnd:change===null?null:t,
   nextCheckAt:s.nextAt,samples:s.samples.length};
 }
 function snapshot(){
  const factors=MACRO_FACTORS.map(factorSnapshot),by=Object.fromEntries(factors.map(f=>[f.id,f]));
  const comparable=(a,b)=>a?.status==='ready'&&b?.status==='ready'&&Math.abs(a.windowEnd-b.windowEnd)<=TOLERANCE&&Math.abs(a.windowStart-b.windowStart)<=TOLERANCE;
  const pair=comparable(by.nq,by.wti),parts=[];
  if(pair){
   if(by.wti.change<-.1&&by.nq.change>.1)parts.push('同窗观察到WTI回落、纳指走高；与成本或通胀压力缓和假设相容，但不能确认资金由原油转入纳指。');
   else if(by.wti.change<-.1&&by.nq.change<-.1)parts.push('同窗观察到原油与纳指同跌；需求或避险冲击也是备选解释，油价下跌不自动构成利多。');
   else parts.push('已取得可比时间窗口；没有识别到“油跌、纳指涨”的组合，不作方向归因。');
   if(comparable(by.nq,by.rates))parts.push('美债10年指标'+(by.rates.change<0?'同期下行':by.rates.change>0?'同期上行':'同期持平')+'，仅用于交叉检查，不等于因果证据。');
  }else parts.push('等待约15分钟的有效采样和对齐时间窗口；不混用不同昨收口径推断跨资产轮动。');
  return {schemaVersion:1,refreshing:!!inflight,observedAt:now(),pollMs,windowMs:WINDOW,comparison:pair?'comparable':'waiting',factors,
   observations:parts,limitations:['价格共变不证明资金转移；需要可追溯的资金或持仓证据。','CPI一致预期只有在日历明确记录了发布前采集时间时才有本机时点证据；这仍不证明资金正在押注CPI。','连续合约换月、不同来源延迟及供需原因仍需核验；滚动窗口不是事件研究。'],
   nextCheckAt:Math.min(...[...states.values()].map(s=>s.nextAt))};
 }
 async function getContext(){
  if(closed)return snapshot();if(inflight)return inflight;
  inflight=(async()=>{
   await Promise.all(MACRO_FACTORS.map(async f=>{
    const s=states.get(f.id);if(now()<s.nextAt)return;s.nextAt=now()+pollMs;
    try{accept(f,s,await readQuote(f.symbol));s.nextAt=Math.max(s.nextAt,now()+Number(s.quote?.pollAfterMs||0));}
    catch(e){s.error=String(e?.message||e).slice(0,240);s.nextAt=Math.max(now()+60000,Number(e?.retryAt)||0);}
   }));return snapshot();
  })().finally(()=>{inflight=null;});return inflight;
 }
 return {getContext,snapshot,requestContext(){if(!closed&&!inflight&&[...states.values()].some(s=>now()>=s.nextAt))void getContext();return snapshot();},close(){closed=true;},reopen(){closed=false;},clear(){for(const s of states.values()){s.quote=null;s.samples=[];s.error=null;s.nextAt=0;s.identity=null;}}};
}
// Yahoo's ^TNX value is retained verbatim. No guessed scaling into percent or basis points.
export function macroIndexQuote(data,symbol,now=Date.now()){
 const m=data?.meta;
 if(!m||m.symbol!==symbol||!['INDEX','CURRENCY'].includes(m.instrumentType)||typeof m.regularMarketPrice!=='number'||!Number.isFinite(m.regularMarketPrice))throw new Error('指标来源身份或价格无效');
 return {symbol,price:m.regularMarketPrice,quoteAt:typeof m.regularMarketTime==='number'?m.regularMarketTime*1000:null,sourceCheckedAt:now,src:'Yahoo 指标',currency:m.currency||null,
  priceBasis:'Yahoo来源原始指标值，不进行比例猜测',feedDelayMinutes:Number.isFinite(m.exchangeDataDelayedBy)?m.exchangeDataDelayedBy:null,feedCoverage:'指标来源口径；延迟及单位以来源为准'};
}
