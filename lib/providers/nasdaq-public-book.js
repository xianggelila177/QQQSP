import {instrumentTypeFor,marketKeyFor,nasdaqAssetClass} from '../instruments.js';
import {providerRetryAt} from './provider-retry.js';
import {createSharedTasks} from '../shared-task.js';

const SOURCE='nasdaq-public-book',MAX_RETAIN_MS=86400000;
const blankSide=()=>({price:null,size:null,exchange:null});
const unavailable=(symbol,reason,extra={})=>({symbol,status:'unavailable',reason,source:SOURCE,
  sourceLabel:'Nasdaq 公开买卖报价',currency:'USD',bid:blankSide(),ask:blankSide(),spread:null,
  asOf:null,checkedAt:null,timeBasis:'source-snapshot-time-unavailable',sizeUnit:null,
  coverage:'source-website-top-of-book-unverified',depth:1,delayMinutes:null,stale:false,...extra});
function numeric(value,{price=false}={}){
  if(typeof value==='string'){
    const raw=value.trim();
    if(!/^(?:\$\s*)?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)||!price&&raw.includes('$'))return null;
    value=Number(raw.replace(/[$,\s]/g,''));
  }
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||price&&value===0)return null;
  return price||Number.isSafeInteger(value)?value:null;
}

// Nasdaq's public /info payload has separate bid/ask fields but no verified
// independent book timestamp. lastTradeTimestamp and response time cannot
// substitute for it. Size units and consolidated venue coverage are unverified.
export function parseNasdaqBook(payload,{symbol,assetClass,now=Date.now()}={}){
  const data=payload?.data,checked={checkedAt:now,lastAttemptAt:now};
  if(payload?.status?.rCode!==200||!data)return unavailable(symbol,'PUBLIC_BOOK_UNAVAILABLE',checked);
  if(data.symbol!==symbol)return unavailable(symbol,'BOOK_IDENTITY_MISMATCH',checked);
  if(!assetClass||String(data.assetClass||'').toLowerCase()!==assetClass)
    return unavailable(symbol,'BOOK_IDENTITY_MISMATCH',checked);
  const quote=data.primaryData;
  if(!quote||typeof quote!=='object')return unavailable(symbol,'PUBLIC_BOOK_EMPTY',checked);
  if(quote.currency!=null&&quote.currency!=='USD')return unavailable(symbol,'BOOK_IDENTITY_MISMATCH',checked);
  const side=prefix=>({price:numeric(quote[prefix+'Price'],{price:true}),size:numeric(quote[prefix+'Size']),exchange:null});
  const bid=side('bid'),ask=side('ask');
  if(bid.price===null&&ask.price===null)return unavailable(symbol,'PUBLIC_BOOK_EMPTY',{...checked,marketStatus:data.marketStatus||null});
  // A size without a valid price is not a usable level.
  if(bid.price===null)bid.size=null;if(ask.price===null)ask.size=null;
  const crossed=bid.price!==null&&ask.price!==null&&bid.price>ask.price;
  return {...unavailable(symbol,crossed?'CROSSED_BOOK':'BOOK_TIME_UNAVAILABLE',checked),status:'partial',bid,ask,
    spread:!crossed&&bid.price!==null&&ask.price!==null?+(ask.price-bid.price).toPrecision(12):null,
    marketStatus:data.marketStatus||null,snapshotCheckedAt:now,
    quality:['BOOK_TIME_UNAVAILABLE','BOOK_SIZE_UNIT_UNVERIFIED','BOOK_COVERAGE_UNVERIFIED','DELAY_UNVERIFIED']};
}

export function createNasdaqPublicBook({httpsGet,resolveInstrument,now=Date.now,maxEntries=60}={}){
  const cache=new Map(),tasks=createSharedTasks();let closed=false,generation=0;
  const supports=(symbol,type)=>marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol,type))&&/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol);
  const usable=value=>value?.bid?.price!=null||value?.ask?.price!=null;
  const retained=value=>usable(value)&&now()-(value.snapshotCheckedAt??value.checkedAt??0)<=MAX_RETAIN_MS;
  function refresh(symbol,assetClass,key,hit,signal){
    return tasks.run(key,async taskSignal=>{
      const owner=generation,requestSignal=AbortSignal.any([taskSignal,AbortSignal.timeout(10000)]);
      let value,retryAt=0;
      try{
        const response=await httpsGet('https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol)+'/info?assetclass='+assetClass,
          {Accept:'application/json',Referer:'https://www.nasdaq.com/'},{signal:requestSignal,timeout:6000,priority:1});
        if(response.status!==200)throw Object.assign(new Error('Public book unavailable'),{
          code:response.status===429?'SOURCE_COOLDOWN':'PUBLIC_BOOK_UNAVAILABLE',
          retryAt:providerRetryAt(response.headers,now(),response.status===429?300000:60000)});
        value=parseNasdaqBook(JSON.parse(response.body),{symbol,assetClass,now:now()});
      }catch(error){
        if(taskSignal.aborted)throw error;
        retryAt=Math.max(now()+60000,Number(error.retryAt)||0);
        value=unavailable(symbol,error.code==='SOURCE_COOLDOWN'?'SOURCE_COOLDOWN':'PUBLIC_BOOK_UNAVAILABLE',
          {lastAttemptAt:now(),retryAt});
      }
      taskSignal.throwIfAborted();
      if(closed||owner!==generation)throw Object.assign(new Error('Public book stopped'),{code:'STOPPED'});
      if(!usable(value)&&['PUBLIC_BOOK_EMPTY','PUBLIC_BOOK_UNAVAILABLE','SOURCE_COOLDOWN'].includes(value.reason)&&retained(hit?.value))
        value={...hit.value,status:'partial',reason:'RETAINED_BOOK',stale:true,refreshReason:value.reason,
          lastAttemptAt:value.lastAttemptAt,retryAt:retryAt||null};
      const until=retryAt||now()+(value.marketStatus==='Closed'?300000:usable(value)?30000:60000);
      cache.delete(key);cache.set(key,{value,until});
      while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
      return value;
    },{signal});
  }
  async function read(symbol,{instrumentType,currency,signal}={}){
    if(signal?.aborted)throw signal.reason;
    if(closed)return unavailable(symbol,'PUBLIC_BOOK_UNAVAILABLE');
    const owner=generation;
    if(currency&&currency!=='USD')return unavailable(symbol,'PUBLIC_BOOK_UNSUPPORTED');
    try{if(resolveInstrument)instrumentType=(await resolveInstrument(symbol,{instrumentType,signal})).type;}
    catch(error){if(signal?.aborted)throw signal.reason;return unavailable(symbol,'PUBLIC_BOOK_UNAVAILABLE');}
    if(signal?.aborted)throw signal.reason;
    if(closed||owner!==generation)return unavailable(symbol,'PUBLIC_BOOK_UNAVAILABLE');
    if(!supports(symbol,instrumentType))return unavailable(symbol,'PUBLIC_BOOK_UNSUPPORTED');
    const assetClass=nasdaqAssetClass(symbol,{instrumentType});
    if(!assetClass)return unavailable(symbol,'INSTRUMENT_TYPE_UNVERIFIED');
    const key=symbol+':'+assetClass,hit=cache.get(key);
    if(hit&&hit.until>now())return hit.value;
    if(retained(hit?.value)){
      void refresh(symbol,assetClass,key,hit).catch(()=>{});
      return {...hit.value,status:'partial',reason:'RETAINED_BOOK',stale:true};
    }
    return refresh(symbol,assetClass,key,hit,signal);
  }
  return {read,supports,close(){closed=true;generation++;tasks.close();cache.clear();},reopen(){closed=false;},
    diagnostics:()=>({entries:cache.size,inflight:tasks.size(),source:SOURCE})};
}
