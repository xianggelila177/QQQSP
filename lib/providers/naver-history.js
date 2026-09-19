import {MAX_WATCHLIST_SYMBOLS} from '../watchlist-limits.js';
import {providerRetryAt} from './provider-retry.js';
import {instrumentMeta} from '../instruments.js';
export const koreanSymbol=symbol=>/^(\d{6})\.(KS|KQ)$/.exec(symbol)?.[1]||null;
const n=v=>v==null||v===''||v==='null'?null:Number.isFinite(Number(v))?Number(v):null;
export function parseNaverHistory(xml,symbol,{minute=false,now=Date.now()}={}){
 const code=koreanSymbol(symbol);if(!code)throw new Error('Not a Korean listing');
 const identity=/\b(?:symbol|code)="([^"]+)"/.exec(xml)?.[1];
 if(identity&&identity!==code)throw new Error('Naver history identity mismatch');
 const rows=[];
 for(const [,raw] of String(xml).matchAll(/<item\s+[^>]*\bdata="([^"]+)"[^>]*\/?\s*>/g)){
  const a=raw.split('|'),d=a[0];if(!new RegExp(minute?'^\\d{12}$':'^\\d{8}$').test(d)||a.length<6)continue;
  const iso=`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${minute?d.slice(8,10):'09'}:${minute?d.slice(10,12):'00'}:00+09:00`;
  const t=Date.parse(iso)/1000,c=n(a[4]);if(!Number.isFinite(t)||t*1000>now||!(c>0))continue;
  const volume=n(a[5]);const row={t,c,v:volume!=null&&volume>=0?volume:null};
  if(!minute){row.o=n(a[1]);row.h=n(a[2]);row.l=n(a[3]);if(![row.o,row.h,row.l].every(x=>x>0)||row.h<Math.max(row.o,c)||row.l>Math.min(row.o,c))continue;}
  rows.push(row);
 }
 rows.sort((a,b)=>a.t-b.t);
 if(minute){let previous=null,date='';for(const row of rows){const day=Math.floor((row.t+32400)/86400),cumulative=row.v;row.v=day===date&&previous!=null&&cumulative!=null&&cumulative>=previous?cumulative-previous:null;previous=cumulative;date=day;}}
 const bars=minute?rows.filter(b=>Math.floor((b.t+32400)/86400)===Math.floor(((rows.at(-1)?.t||0)+32400)/86400)):rows;
 if(!bars.length)throw Object.assign(new Error('Naver returned no usable history'),{code:'HISTORY_EMPTY'});
 const last=bars.at(-1),meta=instrumentMeta(symbol);
 return {source:'naver-fchart',retrievalLimited:true,meta:{symbol,currency:'KRW',exchangeName:symbol.endsWith('.KS')?'KOSPI':'KOSDAQ',exchangeTimezoneName:'Asia/Seoul',gmtoffset:32400,instrumentType:meta.instrumentType,dataGranularity:minute?'1m':'1d',regularMarketPrice:last.c,regularMarketTime:last.t},timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o??null),high:bars.map(b=>b.h??null),low:bars.map(b=>b.l??null),close:bars.map(b=>b.c),volume:bars.map(b=>b.v)}]}};
}
export function createNaverHistory({httpsGet,now=Date.now}={}){
 const cache=new Map(),inflight=new Map();
 return async function fetchChart(symbol,query,options={}){
  const code=koreanSymbol(symbol);if(!code)throw new Error('Unsupported Naver history symbol');
  const minute=new URLSearchParams(query).get('interval')!=='1d',key=symbol+':'+minute,ttl=minute?60000:300000;
  const old=cache.get(key);if(old&&old.until>now()){if(old.error)throw old.error;return old.data;}
  if(inflight.has(key))return inflight.get(key);
  const job=(async()=>{
   try{
    const r=await httpsGet(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=${minute?'minute':'day'}&count=${minute?2500:10000}&requestType=0`,{Referer:'https://finance.naver.com/'},{encoding:'latin1',timeout:6000,signal:options.signal});
    if(r.status!==200)throw Object.assign(new Error('Naver history HTTP '+r.status),{status:r.status,retryAt:providerRetryAt(r.headers,now())});
    const text=new TextDecoder('euc-kr').decode(Buffer.from(r.body,'latin1'));
    const data=parseNaverHistory(text,symbol,{minute,now:now()});cache.set(key,{data,until:now()+ttl});return data;
   }catch(error){cache.set(key,{error,until:Math.max(now()+60000,error.retryAt||0)});throw error;}
   finally{inflight.delete(key);while(cache.size>MAX_WATCHLIST_SYMBOLS*2)cache.delete(cache.keys().next().value);}
  })();inflight.set(key,job);return job;
 };
}
