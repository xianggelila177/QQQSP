import {createCachedResource} from '../cached-resource.js';
import {macroIndexQuote} from '../macro-context.js';
import {providerRetryAt} from './provider-retry.js';
import {decodeGbkSmart} from './tx.js';
import {parseMacroDailyCsv,DAILY_MACRO_SERIES} from './macro-daily.js';
const n=v=>v==null||String(v).trim()===''||v==='-'?null:Number.isFinite(Number(v))?Number(v):null;
// Do not execute the JavaScript response. These are website observation proxies,
// not an alternative identity for any stock-card futures contract.
export function parseSinaMacro(body,checkedAt){
 const result=new Map();
 // Some responses are GBK, others UTF-8. Transport preserves bytes as latin1;
 // decode UTF-8 only when valid, then use the existing GBK/escaped decoder.
 let decoded=String(body||'');
 if(/[\u0080-\u00ff]/.test(decoded)&&!/[\u0100-\uffff]/.test(decoded)){
  try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(decoded,'latin1'));}catch{ /* GBK below */ }
 }
 decoded=decodeGbkSmart(decoded);
 const recentDay=v=>/^\d{4}-\d\d-\d\d$/.test(v)&&Math.abs(checkedAt-Date.parse(v+'T12:00:00Z'))<=36*3600e3;
 for(const [,code,text] of decoded.matchAll(/(?:var\s+)?hq_str_([A-Za-z0-9_]+)\s*=\s*"([^"\r\n]*)"/g)){
  const fields=text.split(',').map(value=>value.trim());
  if(['hf_CL','hf_OIL','hf_NQ'].includes(code)&&fields.length>=14&&n(fields[0])>0&&recentDay(fields[12])){
   const desc={hf_CL:['WTI原油（新浪观察源）','美元/桶'],hf_OIL:['布伦特原油（新浪观察源）','美元/桶'],hf_NQ:['纳指100（新浪差价合约参考）','点']}[code];
   result.set(code,{symbol:code,providerSymbol:code,displayName:desc[0],unit:desc[1],price:n(fields[0]),quoteAt:null,sourceCheckedAt:checkedAt,src:'新浪外盘观察源',currency:'USD',proxy:true,
    sourceTimeText:fields[12]+' '+fields[6],sourceTimeZone:'未核验',feedDelayMinutes:null,
    priceBasis:'网站原始报价，不乘合约乘数；缺少可核验时区，使用服务器观察采样',feedCoverage:'公开网站/差价合约参考，不是原自选合约，也不是交易所全市场成交',pollAfterMs:30000});
  }
  if(code==='DINIW'&&fields.length>=11&&n(fields[1])>0&&recentDay(fields[10])&&/美元指数|Dollar|DINIW/i.test(fields[9])){
   result.set(code,{symbol:'DINIW',displayName:'美元指数（新浪观察源）',price:n(fields[1]),unit:'点',quoteAt:null,sourceCheckedAt:checkedAt,src:'新浪美元指数',proxy:true,
    sourceTimeText:fields[10]+' '+fields[0],sourceTimeZone:'未核验',feedDelayMinutes:null,priceBasis:'新浪DINIW原值；观察时点不冒充成交时间',feedCoverage:'网站指数参考；与Yahoo指数序列不拼接',pollAfterMs:30000});
  }
 }
 return result;
}
export function parseSinaYield(payload,checkedAt){
 const rows=payload?.result?.data;if(!Array.isArray(rows))throw new Error('美债日线响应结构无效');
 const valid=rows.map(r=>Array.isArray(r)?{date:r[0],close:r[4]}:{date:r.date||r.d||r.day,close:r.close??r.c}).filter(r=>/^\d{4}-\d\d-\d\d/.test(String(r.date))&&n(r.close)>0&&n(r.close)<100&&String(r.date).slice(0,10)<=new Date(checkedAt).toISOString().slice(0,10)&&checkedAt-Date.parse(String(r.date).slice(0,10)+'T00:00:00Z')<10*864e5).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
 const row=valid.at(-1);if(!row)throw new Error('美债日线没有有效数据');
 return {symbol:'US10YT',displayName:'美国10年国债收益率（日度）',price:n(row.close),unit:'%',daily:true,quoteAt:null,sourceCheckedAt:checkedAt,observationDate:String(row.date).slice(0,10),src:'新浪国债日线',
  priceBasis:'US10YT日线收盘收益率，不与Yahoo原始指标比例猜测换算',feedCoverage:'日度参考，不能用于1/5/15分钟利率反应',feedDelayMinutes:null,pollAfterMs:900000};
}
// One reader and one shared text batch per application, never per browser.
export function createMacroQuoteReader({httpsGet,futures,fetchChart,publicSources=null,now=Date.now,candidateTimeoutMs=6500}={}){
 const failures=new Map(),preferred=new Map(),lastGood=new Map(),tasks=new Map();let closed=false,generation=0,lifecycle=new AbortController();
 async function get(url,headers={},opts={}){
  const r=await httpsGet(url,headers,{timeout:5000,...opts});
  if(r.status!==200)throw Object.assign(new Error('HTTP '+r.status),{status:r.status,retryAt:providerRetryAt(r.headers,now(),60000)});
  return r.body;
 }
 const sina=createCachedResource({now,ttlMs:30000,retryMs:60000,maxEntries:1,staleOnError:false,loader:async()=>{
  const rows=parseSinaMacro(await get('https://hq.sinajs.cn/?list=hf_NQ,hf_CL,hf_OIL,DINIW',{Referer:'https://finance.sina.com.cn/'},{encoding:'latin1'}),now());
  if(!rows.size)throw Object.assign(new Error('新浪批量响应没有近期有效品种'),{code:'MACRO_BATCH_EMPTY'});return rows;
 }});
 const yields=createCachedResource({now,ttlMs:900000,retryMs:300000,maxEntries:1,staleOnError:false,loader:async()=>parseSinaYield(JSON.parse(await get('https://bond.finance.sina.com.cn/hq/gb/daily?symbol=US10YT',{Referer:'https://finance.sina.com.cn/'})),now())});
 const daily=createCachedResource({now,ttlMs:900000,retryMs:300000,maxEntries:1,staleOnError:false,loader:async()=>{
  const query=new URLSearchParams({id:Object.keys(DAILY_MACRO_SERIES).join(','),cosd:new Date(now()-21*864e5).toISOString().slice(0,10)});
  return parseMacroDailyCsv(await get('https://fred.stlouisfed.org/graph/graph.csv?'+query,{Accept:'text/csv'}),now());
 }});
 const missing=label=>Object.assign(new Error(label),{code:'MACRO_SYMBOL_EMPTY'});
 const proxy=code=>async()=>{const q=(await sina.get('batch')).get(code);if(!q)throw missing('新浪未返回该品种或其日期过旧');return q;};
 const reference=code=>async()=>{const q=(await daily.get('daily')).get(code);if(!q)throw missing('日度参考缺少 '+code);return q;};
 const yahoo=symbol=>()=>symbol.endsWith('=F')?futures.getQuote(symbol):fetchChart(symbol,'?interval=5m&range=1d').then(r=>macroIndexQuote(r,symbol,now()));
 const routes={
  'NQ00Y.FUT':[['eastmoney:NQ',()=>futures.getQuote('NQ00Y.FUT')],['yahoo:NQ',yahoo('NQ=F')],['sina:NQ',proxy('hf_NQ')]],
  'CL00Y.FUT':[['eastmoney:CL',()=>futures.getQuote('CL00Y.FUT')],['sina:CL',proxy('hf_CL')],['yahoo:CL',yahoo('CL=F')],['fred:WTI',reference('DCOILWTICO')]],
  'BZ=F':[['sina:OIL',proxy('hf_OIL')],['yahoo:BZ',yahoo('BZ=F')],['fred:BRENT',reference('DCOILBRENTEU')]],
  '^TNX':[['yahoo:TNX',yahoo('^TNX')],['sina:US10YT',()=>yields.get('yield')],['fred:DGS10',reference('DGS10')]],
  'DX-Y.NYB':[['sina:DINIW',proxy('DINIW')],['yahoo:DX',yahoo('DX-Y.NYB')],['fred:DOLLAR',reference('DTWEXBGS')]],
 };
 for(const [symbol,extra]of Object.entries(publicSources?.routes||{})){
  if(!routes[symbol])continue;const index=routes[symbol].findIndex(([id])=>id.startsWith('fred:')||id==='sina:US10YT');routes[symbol].splice(index<0?routes[symbol].length:index,0,...extra);
 }
 function bounded(id,load){
  // A timed-out shared operation is not duplicated on the next caller.
  let job=tasks.get(id);
  if(!job){job=Promise.resolve().then(load).finally(()=>{if(tasks.get(id)===job)tasks.delete(id);});tasks.set(id,job);}
  const signal=lifecycle.signal;let timer,abort;
  return Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('候选来源超时'),{code:'MACRO_SOURCE_TIMEOUT'})),candidateTimeoutMs);}),new Promise((_,reject)=>{abort=()=>reject(Object.assign(new Error('宏观来源已停止'),{code:'STOPPED'}));signal.addEventListener('abort',abort,{once:true});})]).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);});
 }
 function quality(q){
  if(!(Number.isFinite(q?.price)&&q.price>0))return 0;
  if(q.stale||q.recovery)return 1;
  if(q.daily){const day=Date.parse(q.observationDate||'');return Number.isFinite(day)&&now()-day>14*864e5?1:2;}
  const checked=Number(q.sourceCheckedAt),age=typeof q.quoteAt==='number'?now()-q.quoteAt:null;
  if(!(checked>0)||now()-checked>120000||now()-checked< -5000)return 1;
  if(q.marketState==='CLOSED')return 2.5;
  if(q.delayed||q.feedDelayMinutes>0)return age!==null&&(age< -5000||age>(Math.max(0,q.feedDelayMinutes||0)*60000+120000))?3:age!==null&&q.feedDelayMinutes>0?3.75:3.5;
  if(age!==null&&(age>120000||age< -5000)||q.feedDelayMinutes>0)return 3;
  return age!==null?6:q.proxy?5:4;
 }
 async function readQuote(symbol){
  if(closed)throw Object.assign(new Error('来源读取已停止'),{code:'STOPPED'});
  const owner=generation;
  const candidates=routes[symbol];if(!candidates)throw new Error('未知宏观因子');
  const choice=preferred.get(symbol);
  const ordered=choice&&choice.quality>=4&&now()<choice.until?[...candidates.filter(c=>c[0]===choice.id),...candidates.filter(c=>c[0]!==choice.id)]:candidates;
  let best=null;const diagnostic=[];
  const consider=(q,id)=>{const score=quality(q);if(score>0&&(!best||score>best.score||score===best.score&&(q.quoteAt||q.sourceCheckedAt||0)>(best.q.quoteAt||best.q.sourceCheckedAt||0)))best={q,id,score};return score;};
  for(const [id,load]of ordered){
   if(best?.score>=3.5&&(id.startsWith('fred:')||id==='sina:US10YT'))continue;
   const failure=failures.get(id);
   if(failure?.retryAt>now()){diagnostic.push({...failure,source:id,status:'cooldown'});continue;}
   try{
    const q=await bounded(id,load);if(closed||owner!==generation)throw Object.assign(new Error('来源读取已停止'),{code:'STOPPED'});if(!quality(q))throw missing('来源未返回有效价格');
    failures.delete(id);const score=consider(q,id);
    diagnostic.push({source:id,status:score>=5?'selected':score===4?'observation':score>=3&&score<4?'delayed':score===2.5?'closed':score===2?'daily':'stale',checkedAt:q.sourceCheckedAt});
    if(score>=4)break;
    // A usable untimestamped catalogue is better than a daily reference.
    // Do not pin daily/reference results ahead of a recovering fast source.
   }catch(e){
    if(closed||owner!==generation||e.code==='STOPPED')throw Object.assign(new Error('来源读取已停止'),{code:'STOPPED'});
    const retryAt=Math.max(now()+60000,Number(e.retryAt)||0),info={retryAt,code:e.code||e.status||'NETWORK',message:String(e.message).slice(0,160)};
    failures.set(id,info);diagnostic.push({source:id,status:'error',...info});
   }
  }
  const previous=lastGood.get(symbol);if(previous)consider({...previous.q,recovery:true},previous.id);
  if(best){
   const {q,id,score}=best;
   if(score>=4)preferred.set(symbol,{id,quality:score,until:now()+300000});else preferred.delete(symbol);
   if(score>1)lastGood.set(symbol,{q,id});
   // Cache TTL for a DAILY feed must not prevent probing fast feeds for 15m.
   // Each underlying adapter still owns its request limit and cache.
   return {...q,stale:score===1||!!q.stale,sourcePollAfterMs:q.pollAfterMs||30000,pollAfterMs:30000,selectedSource:id,diagnostics:diagnostic};
  }
  const retryAt=Math.min(...diagnostic.map(x=>x.retryAt||now()+60000));
  throw Object.assign(new Error('所有候选来源不可用'),{code:'MACRO_ALL_SOURCES_FAILED',retryAt,diagnostics:diagnostic});
 }
 return {readQuote,close(){closed=true;generation++;lifecycle.abort();tasks.clear();sina.close();yields.close();daily.close();publicSources?.close?.();},reopen(){closed=false;if(lifecycle.signal.aborted)lifecycle=new AbortController();sina.reopen();yields.reopen();daily.reopen();publicSources?.reopen?.();},diagnostics:()=>({failures:Object.fromEntries(failures),selected:Object.fromEntries(preferred),inflight:tasks.size})};
}
