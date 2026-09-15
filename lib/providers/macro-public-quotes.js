import {createCachedResource} from '../cached-resource.js';
import {providerRetryAt} from './provider-retry.js';
const number=value=>{if(typeof value==='number')return Number.isFinite(value)?value:null;if(typeof value!=='string'||!/^\d+(?:,\d{3})*(?:\.\d+)?%?$/.test(value.trim()))return null;return Number(value.trim().replaceAll(',','').replace(/%$/,''));};
const isoTime=(value,now)=>{
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(Date.UTC(year,month-1,day));
 if(calendar.toISOString().slice(0,10)!==value.slice(0,10))return null;
 const time=Date.parse(value);return time>0&&time<=now+5000&&now-time<=7*864e5?time:null;
};
const failure=(message,code='MACRO_PUBLIC_EMPTY')=>Object.assign(new Error(message),{code});
export function parseNaverEnergy(payload,checkedAt=Date.now()){
 const quotes=new Map();if(payload?.isSuccess!==true||!Array.isArray(payload.result?.mainList))return quotes;
 for(const row of payload.result.mainList){
  const expected={CLcv1:['CL','WTI原油'],LCOcv1:['BRN','布伦特原油']}[row.reutersCode];
  if(!expected||row.symbolCode!==expected[0]||row.categoryType!=='energy'||row.unit!=='USD/BBL')continue;
  const price=number(row.closePrice),quoteAt=isoTime(row.localTradedAt,checkedAt),delay=number(row.delayTime);
  if(!(price>0)||!quoteAt||!/^\d{2}\.\d{2}\.$/.test(row.month||''))continue;
  quotes.set(row.reutersCode,{symbol:row.reutersCode,providerSymbol:row.reutersCode,contractSymbol:row.reutersCode+'@'+row.month,
   displayName:expected[1]+'（Naver '+row.month+'）',price,unit:'美元/桶',currency:'USD',quoteAt,sourceCheckedAt:checkedAt,src:'Naver能源报价',
   sourceTimeText:row.localTradedAt,sourceTimeZone:row.localTradedAt.slice(-6),quoteTimePrecision:'second',
   feedDelayMinutes:delay,delayed:row.priceDataType==='DELAYED_PRICE'||delay>0,declaredRealtime:row.priceDataType==='REALTIME'?true:row.priceDataType==='DELAYED_PRICE'?false:null,
   marketState:row.marketStatus==='OPEN'?'REGULAR':row.marketStatus==='CLOSED'||row.priceDataType==='CLOSING_PRICE'?'CLOSED':'UNKNOWN',proxy:true,
   sourceUrl:'https://m.stock.naver.com/marketindex/energy/'+row.reutersCode,priceBasis:'Naver公布的前月期货报价；合约月份与延迟按来源标注，不与其他连续合约拼接',
   feedCoverage:'公开网站报价；来源返回明确时区及延迟，延迟报价不参与实时分钟比较',pollAfterMs:30000});
 }
 return quotes;
}
const CNBC=Object.freeze({
 '@CL.1':{name:'WTI原油（CNBC前月期货）',unit:'美元/桶',type:'DERIVATIVE',subType:'Future'},
 '@LCO.1':{name:'布伦特原油（CNBC前月期货）',unit:'美元/桶',type:'DERIVATIVE',subType:'Future'},
 '@ND.1':{name:'纳指100（CNBC前月期货）',unit:'点',type:'DERIVATIVE',subType:'Future'},
 'US10Y':{name:'美国10年国债收益率（CNBC）',unit:'%',type:'BOND',subType:'Government Bond'},
 '.DXY':{name:'美元指数（CNBC）',unit:'点',type:'INDEX',subType:'Index'}
});
export function parseCnbcMacro(payload,checkedAt=Date.now()){
 const quotes=new Map(),rows=payload?.ITVQuoteResult?.ITVQuote;if(!Array.isArray(rows))return quotes;
 for(const row of rows){
  const def=CNBC[row.symbol];if(!def||String(row.code)!=='0'||row.type!==def.type||row.subType!==def.subType)continue;
  const price=number(row.last);if(!(price>0)||row.symbol==='US10Y'&&!String(row.last).endsWith('%')||row.symbol!=='US10Y'&&row.currencyCode!=='USD')continue;
  const realtime=row.realTime===true||row.realTime==='true'?true:row.realTime===false||row.realTime==='false'?false:null;
  const sourceTimeText=typeof row.last_timedate==='string'?row.last_timedate.slice(0,80):null;
  quotes.set(row.symbol,{symbol:row.symbol,providerSymbol:row.symbol,contractSymbol:def.type==='DERIVATIVE'?String(row.feedSymbol||row.altSymbol||'').slice(0,40):undefined,
   displayName:def.name,price,unit:def.unit,currency:def.unit==='%'?null:'USD',quoteAt:isoTime(sourceTimeText,checkedAt),sourceCheckedAt:checkedAt,
   src:'CNBC公开报价',proxy:true,sourceTimeText,sourceTimeZone:sourceTimeText?.match(/\b(EDT|EST|BST|GMT|UTC)\b/)?.[1]||'未提供完整日期',
   feedDelayMinutes:realtime===true?0:null,delayed:realtime===false,declaredRealtime:realtime,
   marketState:row.curmktstatus==='REG_MKT'?'REGULAR':['CLOSED','MKT_CLOSED','CLOSED_MKT'].includes(row.curmktstatus)?'CLOSED':'UNKNOWN',
   sourceUrl:'https://www.cnbc.com/quotes/'+encodeURIComponent(row.symbol),
   priceBasis:row.symbol==='US10Y'?'直接使用来源的百分比收益率，未使用债券净价或猜测比例':'CNBC网站原始报价，合约与连续序列以来源为准',
   feedCoverage:'来源实时/延迟标记不等于交易所授权；只有时刻而无日期时，保留原文并使用服务器观察时间',pollAfterMs:30000});
 }
 return quotes;
}
export function createPublicMacroSources({httpsGet,now=Date.now}={}){
 async function request(url,referer,signal){const r=await httpsGet(url,{Accept:'application/json',Referer:referer},{signal,timeout:6000});if(r.status!==200)throw Object.assign(failure('公开宏观来源 HTTP '+r.status,'MACRO_PUBLIC_HTTP'),{status:r.status,retryAt:providerRetryAt(r.headers,now(),60000)});return JSON.parse(r.body);}
 const naver=createCachedResource({now,ttlMs:30000,retryMs:60000,maxEntries:1,staleOnError:false,loader:async(_, {signal})=>{
  const rows=parseNaverEnergy(await request('https://m.stock.naver.com/front-api/marketIndex/energy','https://m.stock.naver.com/marketindex/home/energy',signal),now());if(!rows.size)throw failure('Naver没有有效能源报价');return rows;
 }});
 const cnbc=createCachedResource({now,ttlMs:30000,retryMs:60000,maxEntries:1,staleOnError:false,loader:async(_, {signal})=>{
  // partnerId is the public website request identifier, not a private account key.
  const q=new URLSearchParams({symbols:Object.keys(CNBC).join('|'),requestMethod:'itv',noform:'1',partnerId:'2',fund:'1',exthrs:'1',output:'json'});
  const rows=parseCnbcMacro(await request('https://quote.cnbc.com/quote-html-webservice/quote.htm?'+q,'https://www.cnbc.com/',signal),now());if(!rows.size)throw failure('CNBC没有有效宏观报价');return rows;
 }});
 const load=(cache,code)=>async()=>{try{const result=(await cache.get('batch')).get(code);if(!result)throw failure('来源未提供该宏观品种');return {...result,nextPollAt:cache.cache.get('batch').ts+30000};}catch(error){error.retryAt=Math.max(Number(error.retryAt)||0,cache.failures.get('batch')?.retryAt||0);throw error;}};
 return {routes:{
  'NQ00Y.FUT':[['cnbc:NQ',load(cnbc,'@ND.1')]],
  'CL00Y.FUT':[['naver:CL',load(naver,'CLcv1')],['cnbc:CL',load(cnbc,'@CL.1')]],
  'BZ=F':[['naver:BRENT',load(naver,'LCOcv1')],['cnbc:BRENT',load(cnbc,'@LCO.1')]],
  '^TNX':[['cnbc:US10Y',load(cnbc,'US10Y')]],
  'DX-Y.NYB':[['cnbc:DXY',load(cnbc,'.DXY')]]
 },close(){naver.close();cnbc.close();},reopen(){naver.reopen();cnbc.reopen();}};
}
