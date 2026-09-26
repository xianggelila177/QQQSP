import {publishQuote} from '../quote-contract.js';
import {instrumentMeta,validWeek52Range} from '../instruments.js';
import {marketStateFor,timezoneOffsetFor} from '../../mkt.mjs';
import {priceSessionFor} from '../sessions.js';
import {decodeGbkSmart} from './tx.js';
import {providerRetryAt} from './provider-retry.js';
const n=v=>v==null||String(v).trim()===''?null:Number.isFinite(Number(v))?Number(v):null;
export function sinaCode(symbol){
 const cn=/^(\d{6})\.(SS|SZ|BJ)$/.exec(symbol);
 if(cn)return ({SS:'sh',SZ:'sz',BJ:'bj'})[cn[2]]+cn[1];
 const hk=/^(\d{4,5})\.HK$/.exec(symbol);if(hk)return 'rt_hk'+hk[1].padStart(5,'0');
 return /^[A-Z][A-Z0-9-]{0,12}$/.test(symbol)?'gb_'+symbol.toLowerCase():null;
}
export function wallTimestamp(text,symbol){
 const m=/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text||'');
 if(!m||+m[2]<1||+m[2]>12||+m[3]<1||+m[3]>31||+m[4]>23||+m[5]>59||+(m[6]||0)>59)return null;
 const t=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
 return t-timezoneOffsetFor(symbol,t)*1000;
}
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function sinaExtendedTime(text,anchor){
 // Format has a month but often no year. Select the nearest year around the
 // regular trade, and honor explicit EST/EDT rather than the server's timezone.
 const m=/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+(EST|EDT)$/.exec(text||'');
 if(!m||!anchor||+m[2]<1||+m[2]>31||+m[3]<1||+m[3]>12||+m[4]>59)return null;
 const month=MONTHS.indexOf(m[1]);if(month<0)return null;
 const y=new Date(anchor).getUTCFullYear(),h=(+m[3]%12)+(m[5]==='PM'?12:0),off=m[6]==='EDT'?4:5;
 return [y-1,y,y+1].map(year=>Date.UTC(year,month,+m[2],h+off,+m[4])).sort((a,b)=>Math.abs(a-anchor)-Math.abs(b-anchor))[0];
}
export function parseSinaQuotes(body,symbols,{now=Date.now(),pollMs=1000}={}){
 const lookup=new Map(symbols.map(s=>[sinaCode(s),s]).filter(([c])=>c)),out=[];
 // Response is data, never executed as JavaScript.
 for(const [,code,text] of decodeGbkSmart(body).matchAll(/(?:var\s+)?hq_str_([a-zA-Z0-9_]+)\s*=\s*"([^"\r\n]*)"\s*;?/g)){
  const symbol=lookup.get(code);if(!symbol)continue;
  const f=text.split(','),us=code.startsWith('gb_'),hk=code.startsWith('rt_hk');
  if(f.length<(us?27:hk?19:32))continue;
  const rawAt=us?f[3]:hk?`${f[17]} ${f[18]}`:`${f[30]} ${f[31]}`;
  const providerUpdatedAt=us?wallTimestamp(rawAt,'000001.SS'):null;
  const regularAt=us?sinaExtendedTime(f[25],providerUpdatedAt):wallTimestamp(rawAt,symbol);
  let price=n(f[us?1:hk?6:3]),quoteAt=regularAt;
  if(!(price>0)||!quoteAt||quoteAt>now+5000)continue;
  const regularPrice=price,prevClose=n(f[us?26:hk?3:2]);
  let priceSession=us?priceSessionFor(symbol,quoteAt):'REGULAR',ext=null;
  if(us){
   const extAt=sinaExtendedTime(f[24],regularAt),extPrice=n(f[21]);
   if(extAt>regularAt&&extAt<=now+5000&&extPrice>0){
    const state=priceSessionFor(symbol,extAt);
    if(state==='PRE'||state==='POST'){price=extPrice;quoteAt=extAt;priceSession=state;ext={[state==='PRE'?'pre':'post']:{price:extPrice,t:extAt/1000,change:extPrice-regularPrice,changePct:(extPrice/regularPrice-1)*100}};}
   }
  }
  const meta=instrumentMeta(symbol),open=n(f[us?5:hk?2:1]),high=n(f[us?6:hk?4:4]),low=n(f[us?7:hk?5:5]);
  out.push(publishQuote({symbol,...meta,displayName:hk?f[1]:f[0],name:meta.exchangeName,currency:us?'USD':hk?'HKD':'CNY',
   price,quoteAt,ts:quoteAt,quoteTimePrecision:us||hk?'minute':'second',providerUpdatedAt,sourceCheckedAt:now,fetchedAt:now,regularPrice,regularQuoteAt:regularAt,priceSession,
   prevClose:prevClose>0?prevClose:null,regularPreviousClose:prevClose>0&&priceSessionFor(symbol,regularAt)==='REGULAR'?prevClose:null,regularPreviousCloseQuoteAt:regularAt,
   change:prevClose>0?price-prevClose:null,changePct:prevClose>0?(price/prevClose-1)*100:null,
   open,dayHigh:high,dayLow:low,volume:n(f[us?10:hk?12:8]),volumeUnit:'shares',turnoverAmount:us?null:n(f[hk?11:9]),ohlcSession:'REGULAR',ohlcConsistent:priceSession==='REGULAR'&&low!=null&&high!=null&&low<=price&&price<=high,
   ...validWeek52Range(us?n(f[8]):null,us?n(f[9]):null),ext,marketState:marketStateFor(symbol,null,now),gmtoff:timezoneOffsetFor(symbol,now),
   src:'sina-batch',feedCoverage:'公开网站快照；覆盖与固定延迟未经供应商承诺',feedDelayMinutes:null,priceBasis:'website-last-trade',
   pollAfterMs:pollMs,checkIntervalMs:pollMs,fxMap:null,fxStale:true}));
 }
 return out;
}
export function createSinaQuotes({httpsGet,now=Date.now,pollMs=1000}={}){
 return async symbols=>{
  const codes=symbols.map(sinaCode).filter(Boolean);if(!codes.length)return [];
  const r=await httpsGet('https://hq.sinajs.cn/list='+codes.join(','),{Referer:'https://finance.sina.com.cn/'},{encoding:'latin1',timeout:2500});
  if(r.status!==200)throw Object.assign(new Error('Sina HTTP '+r.status),{status:r.status,retryAfterMs:providerRetryAt(r.headers,now(),30000)-now()});
  return parseSinaQuotes(r.body,symbols,{now:now(),pollMs});
 };
}
