import {marketKeyFor,instrumentMeta,instrumentTypeFor,quoteDisplayName} from '../instruments.js';
import {catalogInstrumentFor} from '../market-registry.js';
import {publishQuote} from '../quote-contract.js';
import {priceSessionFor} from '../sessions.js';
import {marketStateFor,timezoneOffsetFor} from '../../mkt.mjs';

const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const supported=s=>marketKeyFor(s)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(s))&&/^[A-Z][A-Z0-9-]{0,15}$/.test(s);

export function normalizeFinnhubQuote(symbol,data,{now=Date.now(),pollMs=30000}={}){
  const at=data?.t*1000,session=priceSessionFor(symbol,at);
  if(!supported(symbol)||!positive(data?.c)||!Number.isSafeInteger(data?.t)||at>now+5000||!session)return null;
  const prevClose=positive(data.pc)?data.pc:null,meta=instrumentMeta(symbol),name=quoteDisplayName(symbol,catalogInstrumentFor(symbol)?.name);
  const high=positive(data.h)?data.h:null,low=positive(data.l)?data.l:null;
  return publishQuote({symbol,...meta,displayName:name,name,price:data.c,quoteAt:at,ts:at,
    priceSession:session,prevClose,providerPrevClose:prevClose,regularPrice:session==='REGULAR'?data.c:null,
    regularQuoteAt:session==='REGULAR'?at:null,open:positive(data.o)?data.o:null,dayHigh:high,dayLow:low,
    volume:null,volumeUnit:null,currency:'USD',sourceCurrency:'USD',priceScale:1,
    src:'finnhub-quote',priceBasis:'provider-quote',quoteTimeBasis:'source_time',quoteTimePrecision:'second',
    feedCoverage:'账户授权范围（未核验全市场覆盖）',feedDelayMinutes:null,isDelayed:null,
    sourceCheckedAt:now,fetchedAt:now,marketState:marketStateFor(symbol,null,now),gmtoff:timezoneOffsetFor(symbol,now),
    ohlcSession:null,ohlcConsistent:false,ext:null,pollAfterMs:pollMs,checkIntervalMs:pollMs});
}

export function createFinnhubQuotes({request,now=Date.now,pollMs=30000}={}){
  const cache=new Map(),jobs=new Map();
  return async function getQuotes(symbols,{force=false}={}){
    if(!request)return [];
    const eligible=symbols.filter(supported),due=eligible.filter(s=>!jobs.has(s)&&(force||(cache.get(s)?.until||0)<=now())).slice(0,force?eligible.length:8);
    for(const symbol of due){
      const job=(async()=>{
        let quote=null;
        try{const r=await request('/quote?symbol='+encodeURIComponent(symbol),{timeout:5000});
          if(r.status===200)quote=normalizeFinnhubQuote(symbol,JSON.parse(r.body),{now:now(),pollMs});
        }catch{/* Other sources remain available. */}
        cache.set(symbol,{quote,until:now()+(quote?pollMs:30000)});
        while(cache.size>200)cache.delete(cache.keys().next().value);
      })().finally(()=>jobs.delete(symbol));
      jobs.set(symbol,job);
    }
    if(due.length){
      let timer;
      try{await Promise.race([Promise.allSettled(due.map(s=>jobs.get(s))),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
      finally{clearTimeout(timer);}
    }
    return eligible.map(s=>cache.get(s)?.quote).filter(Boolean);
  };
}
