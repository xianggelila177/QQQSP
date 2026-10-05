import {marketKeyFor,instrumentTypeFor} from '../instruments.js';
import {historyError,validDate,localDateAt,addDays} from '../history-contract.js';
import {createSharedTasks} from '../shared-task.js';
import {createTaskQueue} from '../task-queue.js';
import {matchesNaverIdentity} from './naver-identity.js';
import {providerRetryAt} from './provider-retry.js';

const DAY=86400000,ZONE='America/New_York';
const EXCHANGES={NSQ:'NASDAQ',NYS:'NYSE',AMX:'AMEX'};
const stopped=()=>historyError('STOPPED','Naver daily history stopped',503);
const supports=symbol=>marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol))&&/^[A-Z][A-Z0-9-]{0,15}$/.test(symbol);
const empty=()=>Object.assign(historyError('HISTORY_EMPTY','Naver 请求窗口没有日线',502),{emptyRange:true});

// The official ChartIQ feed uses foreign/item/{resolved Reuters code}/day.
// Rows carry localDate, not a trade timestamp or listing identity. A separately
// verified /basic response is mandatory before accepting this bare array.
export function parseNaverWorldDaily(payload,{from,through,now=Date.now()}={}){
  if(!validDate(from)||!validDate(through)||from>through||!Array.isArray(payload)||payload.length>10000)
    throw historyError('HISTORY_BAD_RESPONSE','Naver 日线响应或范围无效',502);
  const today=localDateAt(now,ZONE),rows=new Map();
  for(const row of payload){
    if(!/^\d{8}$/.test(row?.localDate||''))throw historyError('HISTORY_BAD_RESPONSE','Naver 日线日期无效',502);
    const date=row.localDate.slice(0,4)+'-'+row.localDate.slice(4,6)+'-'+row.localDate.slice(6,8);
    if(!validDate(date))throw historyError('HISTORY_BAD_RESPONSE','Naver 日线日期无效',502);
    if(date<from||date>through||date>today)throw historyError('HISTORY_RANGE_CONFLICT','Naver 日线超出交易日期范围',422);
    const {openPrice:o,highPrice:h,lowPrice:l,closePrice:c}=row;
    if(![o,h,l,c].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)||h<Math.max(o,c)||l>Math.min(o,c)||l>h)
      throw historyError('HISTORY_BAD_RESPONSE','Naver 日线 OHLC 无效',502);
    const v=row.accumulatedTradingVolume;
    if(v!=null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))throw historyError('HISTORY_BAD_RESPONSE','Naver 来源成交量无效',502);
    // Noon UTC encodes the same New York session date in both DST regimes;
    // this is explicitly a daily date marker, never an actual quote time.
    const bar={sessionDate:date,t:Date.parse(date+'T12:00:00Z')/1000,o,h,l,c,sourceVolume:v??null};
    const old=rows.get(date);
    if(old&&JSON.stringify(old)!==JSON.stringify(bar))throw historyError('HISTORY_CONFLICT','Naver 同交易日日线冲突',422);
    rows.set(date,bar);
  }
  if(!rows.size)throw empty();
  return [...rows.values()].sort((a,b)=>a.sessionDate.localeCompare(b.sessionDate));
}

function requestWindow(query,{pageBefore,maxWindowDays,at}){
  const p=new URLSearchParams(query);
  if(p.get('interval')!=='1d')throw historyError('HISTORY_UNSUPPORTED','Naver 此适配器只读取日线',422);
  const dateFromEpoch=(key,exclusive=false)=>{
    const value=Number(p.get(key));
    if(!Number.isFinite(value)||!Number.isSafeInteger(value))throw historyError('BAD_HISTORY_QUERY','日线时间参数无效',400);
    try{return new Date(value*1000-(exclusive?1:0)).toISOString().slice(0,10);}catch{throw historyError('BAD_HISTORY_QUERY','日线时间参数无效',400);}
  };
  const today=localDateAt(at,ZONE),years=/^(\d+)y$/.exec(p.get('range')||'')?.[1];
  const requestedFrom=p.has('period1')?dateFromEpoch('period1'):addDays(today,-Math.min(45,Number(years)||2)*366);
  if(!validDate(requestedFrom)||requestedFrom<'1900-01-01')throw historyError('BAD_HISTORY_QUERY','日线起始日期无效',400);
  let through=p.has('period2')?dateFromEpoch('period2',true):today;
  if(!validDate(through))throw historyError('BAD_HISTORY_QUERY','日线截止日期无效',400);
  if(through>today)through=today;
  if(pageBefore!=null){if(!validDate(pageBefore))throw historyError('BAD_HISTORY_QUERY','日线翻页日期无效',400);through=[through,addDays(pageBefore,-1)].sort()[0];}
  if(requestedFrom>through)throw empty();
  const from=[requestedFrom,addDays(through,-maxWindowDays+1)].sort().at(-1);
  return {requestedFrom,from,through};
}

export function createNaverWorldDailyHistory({httpsGet,resolveCode,invalidateIdentity,now=Date.now,maxEntries=32,maxWindowDays=3660,ttlMs=300000}={}){
  maxWindowDays=Math.min(3660,Math.max(1,Math.floor(maxWindowDays)));
  const cache=new Map(),identities=new Map(),cooldowns=new Map(),shared=createSharedTasks(),queue=createTaskQueue({maxActive:2,maxQueued:8,now});
  let closed=false,generation=0;
  const remember=(map,key,value)=>{map.delete(key);map.set(key,value);while(map.size>maxEntries)map.delete(map.keys().next().value);return value;};
  async function request(url,signal,priority){
    signal.throwIfAborted();
    const r=await httpsGet(url,{Accept:'application/json',Referer:'https://m.stock.naver.com/'},{signal,priority,timeout:8000});
    signal.throwIfAborted();
    if(r?.status!==200)throw Object.assign(historyError(r?.status===429?'HISTORY_RATE_LIMITED':'HISTORY_SOURCE_UNAVAILABLE','Naver 日线 HTTP '+(r?.status||503),r?.status===429?429:503),
      {status:r?.status,retryAt:providerRetryAt(r?.headers,now(),60000)});
    try{return JSON.parse(r.body);}catch{throw historyError('HISTORY_BAD_RESPONSE','Naver 日线响应不是 JSON',502);}
  }
  const fetch=async(symbol,query,options={})=>{
    if(closed)throw stopped();
    if(!supports(symbol))throw historyError('HISTORY_UNSUPPORTED','Naver 无已核验美股日线身份',422);
    const window=requestWindow(query,{pageBefore:options.pageBefore,maxWindowDays,at:now()});
    const timeout=AbortSignal.timeout(Math.min(15000,Math.max(1000,Number(options.deadlineMs)||12000)));
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout,owner=generation;
    signal.throwIfAborted();
    const wait=cooldowns.get(symbol);if(wait?.retryAt>now())throw wait;
    let identity=await resolveCode?.(symbol,{signal,priority:options.priority});
    signal.throwIfAborted();
    if(closed||owner!==generation)throw stopped();
    if(!identity||typeof identity!=='object'||identity.exchange!=null&&!EXCHANGES[identity.exchange]||!['EQUITY','ETF'].includes(identity.instrumentType)||
      typeof identity.code!=='string'||!new RegExp('^'+symbol+'(?:\\.[A-Z])?$').test(identity.code))
      throw historyError('HISTORY_IDENTITY_UNRESOLVED','Naver 日线证券身份未核验',422);
    const identityKey=[symbol,identity.code,identity.exchange,identity.instrumentType].join(':');
    const valid=identities.get(identityKey);
    try{
      identity=valid?.until>now()?valid.identity:await shared.run('identity:'+identityKey,taskSignal=>queue.run(async queueSignal=>{
        const basic=await request('https://api.stock.naver.com/stock/'+encodeURIComponent(identity.code)+'/basic',queueSignal,options.priority);
        // Existing verified-static routes resolve a Reuters code and type, but
        // may omit exchange. Complete it from /basic, never from a code suffix.
        // A supplied exchange remains binding and must agree with /basic.
        const verified={...identity,exchange:identity.exchange??basic.stockExchangeType?.code,
          provenance:(identity.provenance||'resolved-naver')+'+naver-basic'};
        if(!EXCHANGES[verified.exchange]||!matchesNaverIdentity(basic,symbol,verified)||basic.stockEndType!==(identity.instrumentType==='ETF'?'etf':'stock')||
          basic.isEtf!=null&&basic.isEtf!==(identity.instrumentType==='ETF')){
          invalidateIdentity?.(symbol,identity,'NAVER_DAILY_IDENTITY_CONFLICT');
          throw historyError('HISTORY_IDENTITY_CONFLICT','Naver 日线证券/币种/交易所身份不符',422);
        }
        queueSignal.throwIfAborted();if(closed||owner!==generation)throw stopped();
        remember(identities,identityKey,{until:now()+3600000,identity:verified});return verified;
      },{signal:taskSignal,priority:options.priority}),{signal});
      signal.throwIfAborted();if(closed||owner!==generation)throw stopped();
      const key=JSON.stringify([identityKey,window.requestedFrom,window.from,window.through]),old=cache.get(key);
      if(old?.until>now()){if(old.error)throw old.error;return old.data;}
      return await shared.run(key,taskSignal=>queue.run(async queueSignal=>{
        try{
          const params=new URLSearchParams({startDateTime:window.from.replaceAll('-','')+'0000',endDateTime:window.through.replaceAll('-','')+'2359'});
          const payload=await request('https://api.stock.naver.com/chart/foreign/item/'+encodeURIComponent(identity.code)+'/day?'+params,queueSignal,options.priority);
          const bars=parseNaverWorldDaily(payload,{...window,now:now()});
          queueSignal.throwIfAborted();if(closed||owner!==generation)throw stopped();
          const latest=bars.at(-1),sourceCheckedAt=now(),retrievalLimited=window.from>window.requestedFrom;
          const data={source:'naver-world-daily',retrievalLimited,hasMore:retrievalLimited,requestedFrom:window.requestedFrom,retrievedFrom:bars[0].sessionDate,
            adjustment:'source-default-unverified',sourceCheckedAt,sourceFreshUntil:sourceCheckedAt+ttlMs,sourceTimeBasis:'provider-http-checked',
            coverage:{status:'unknown',requestedFrom:window.requestedFrom,windowFrom:window.from,windowThrough:window.through,firstTradingDate:bars[0].sessionDate,lastTradingDate:latest.sessionDate,
              stopReason:retrievalLimited?'date-window-budget':'requested-window-covered',originProven:false,scope:'source daily OHLC; adjustment and volume basis unverified'},
            meta:{symbol,currency:'USD',sourceCurrency:'USD',priceScale:1,exchangeName:EXCHANGES[identity.exchange],exchangeTimezoneName:ZONE,
              instrumentType:identity.instrumentType,instrumentTypeSource:'naver-basic-verified',identityProvenance:identity.provenance||'resolved-naver-basic',reutersCode:identity.code,
              dataGranularity:'1d',chartTimeBasis:'exchange-session-date',sourceDailyDate:latest.sessionDate,sourceDailyClose:latest.c,adjustmentStatus:'source-unverified',
              sourceVolumeUnit:'source-unit-unverified',sourceVolumeField:'accumulatedTradingVolume',sourceVolumeCoverage:'provider daily field; share unit and adjustment unverified'},
            sourceVolumes:bars.map(b=>({sessionDate:b.sessionDate,value:b.sourceVolume})),
            timestamp:bars.map(b=>b.t),indicators:{quote:[{open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(()=>null)}]}};
          // hasMore describes this requested window budget, never a listing origin.
          remember(cache,key,{data,until:data.sourceFreshUntil});return data;
        }catch(error){
          if(!queueSignal.aborted&&!closed&&owner===generation&&error.code!=='STOPPED')remember(cache,key,{error,until:Math.max(now()+60000,Number(error.retryAt)||0)});
          throw error;
        }
      },{signal:taskSignal,priority:options.priority}),{signal});
    }catch(error){
      if(!signal.aborted&&!closed&&owner===generation&&error.retryAt>now())remember(cooldowns,symbol,error);
      throw error;
    }
  };
  fetch.supports=supports;
  fetch.invalidate=symbol=>{for(const key of identities.keys())if(key.startsWith(symbol+':'))identities.delete(key);for(const key of cache.keys())if(JSON.parse(key)[0].startsWith(symbol+':'))cache.delete(key);cooldowns.delete(symbol);};
  fetch.close=()=>{closed=true;generation++;shared.close(stopped());queue.close();cache.clear();identities.clear();cooldowns.clear();};
  fetch.reopen=()=>{closed=false;queue.reopen();};
  fetch.diagnostics=()=>({cachedRanges:cache.size,cachedIdentities:identities.size,cooldowns:cooldowns.size,inflight:shared.size(),maxWindowDays,queue:queue.diagnostics(),closed});
  return fetch;
}
