import {instrumentTypeFor,marketKeyFor} from '../instruments.js';
import {localDateAt,validDate} from '../history-contract.js';
import {tradingDayInfo,localInstant} from '../market-calendar-api.js';
import {normalizeNasdaqTime} from './nasdaq-time.js';
import {providerRetryAt} from './provider-retry.js';
import {createSharedTasks} from '../shared-task.js';

const SOURCE='nasdaq-public-trades',ZONE='America/New_York';
const positive=value=>{const n=Number(String(value??'').replace(/[$,\s]/g,''));return Number.isFinite(n)&&n>0?n:null;};
const unavailable=(reason,session,tradeDate,extra={})=>({status:'unavailable',reason,source:SOURCE,
  sourceLabel:'Nasdaq 公开成交',session,tradeDate,events:[],coverage:null,delayMinutes:null,stale:false,...extra});
function sourceTime(data,session){
  const table=session==='regular'?data?.topTable:data?.tradeDetailTable;
  const labels=[table?.asOf,...(Array.isArray(data?.lastUpdateInfo)?data.lastUpdateInfo:[]),
    ...(Array.isArray(data?.message)?data.message:[])];
  for(const label of labels){
    if(typeof label!=='string'||/resume/i.test(label))continue;
    const text=label.replace(/^Data last updated\s+/i,'').replace(/\.$/,'').trim();
    const time=normalizeNasdaqTime({dateTime:text});
    if(time?.basis==='source-label')return time.at;
  }
  return null;
}
// Each response replaces one window. There are no provider IDs, so identical
// rows remain distinct and successive windows must never be accumulated.
export function parseNasdaqTrades(payload,{symbol,session='regular',tradeDate,now=Date.now()}={}){
  const data=payload?.data,checked={sourceCheckedAt:now};
  if(!data||payload?.status?.rCode!==200)return unavailable('PUBLIC_TRADES_UNAVAILABLE',session,tradeDate,checked);
  if(data.symbol&&String(data.symbol).toUpperCase()!==symbol)return unavailable('SOURCE_IDENTITY_MISMATCH',session,tradeDate,checked);
  const asOf=sourceTime(data,session),sourceTradeDate=asOf==null?null:localDateAt(asOf,ZONE);
  const meta={...checked,asOf,sourceTradeDate};
  if(asOf==null)return unavailable('SOURCE_DATE_MISSING',session,tradeDate,meta);
  if(asOf>now+1000)return unavailable('SOURCE_TIME_INVALID',session,tradeDate,meta);
  if(!validDate(tradeDate)||sourceTradeDate!==tradeDate)return unavailable('SOURCE_DATE_MISMATCH',session,tradeDate,meta);
  const day=tradingDayInfo(symbol,tradeDate);
  if(!day.known||!day.is_open)return unavailable('REGULAR_SESSION_UNKNOWN',session,tradeDate,meta);
  const table=session==='regular'?data:data.tradeDetailTable,rows=table?.rows;
  if(!Array.isArray(rows)||!rows.length)return unavailable('PUBLIC_TRADES_EMPTY',session,tradeDate,meta);
  const fields=session==='regular'?['nlsTime','nlsPrice','nlsShareVolume']:['time','price','shareVolume'];
  const headers=table.headers||{};
  if(!/\(ET\)/i.test(headers[fields[0]]||'')||!/share|volume/i.test(headers[fields[2]]||''))
    return unavailable('SOURCE_SCHEMA_MISMATCH',session,tradeDate,meta);
  const open=day.regular_sessions[0].open_at_ms,close=day.regular_sessions.at(-1).close_at_ms;
  const start=session==='pre'?localInstant(symbol,tradeDate,240):session==='post'?close:open;
  const end=session==='pre'?open:session==='post'?localInstant(symbol,tradeDate,1200):close;
  let rejected=0;
  const events=rows.slice(0,100).reverse().flatMap(row=>{
    const time=normalizeNasdaqTime({dateTime:tradeDate+' '+String(row?.[fields[0]]??'')+' ET'});
    const price=positive(row?.[fields[1]]),size=positive(row?.[fields[2]]),at=time?.at;
    if(!price||!Number.isSafeInteger(size)||!at||at>now+1000||at<start||at>=end||session==='post'&&at===close){rejected++;return [];}
    return [{symbol,source:SOURCE,price,size,at,sizeUnit:'shares',currency:'USD',receivedAt:now,
      eventId:null,exchange:null,side:null,reportState:'reported'}];
  }).sort((a,b)=>a.at-b.at);
  const result={...meta,rejectedRows:rejected,quality:['NO_TRADE_IDS','CORRECTIONS_UNAVAILABLE','DELAY_UNVERIFIED'],
    identityBasis:data.symbol?'source-symbol':'requested-symbol-path'};
  if(!events.length)return unavailable('PUBLIC_TRADES_EMPTY',session,tradeDate,result);
  return {...unavailable('PUBLIC_TRADE_WINDOW',session,tradeDate,result),status:'partial',events,
    coverage:{firstAt:events[0].at,lastAt:events.at(-1).at,count:events.length,
      scope:'public-trade-window',complete:false,marketCoverage:'source-website-window-unverified'}};
}

export function createNasdaqPublicTrades({httpsGet,now=Date.now,maxEntries=60}={}){
  const cache=new Map(),tasks=createSharedTasks();let closed=false;
  const supports=symbol=>marketKeyFor(symbol)==='us'&&['EQUITY','ETF'].includes(instrumentTypeFor(symbol))&&/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol);
  async function read(symbol,{session='regular',tradeDate,signal}={}){
    if(!supports(symbol))return unavailable('PUBLIC_TRADES_UNSUPPORTED',session,tradeDate);
    if(!['regular','pre','post'].includes(session)||!validDate(tradeDate))return unavailable('SOURCE_DATE_MISSING',session,tradeDate);
    if(closed)return unavailable('PUBLIC_TRADES_UNAVAILABLE',session,tradeDate);
    const key=[symbol,session,tradeDate].join(':'),hit=cache.get(key);
    if(hit&&hit.until>now())return hit.value;
    return tasks.run(key,async taskSignal=>{
      // Include time in the shared Nasdaq queue; keep below the 20s detail
      // route deadline so a busy quote/history refresh cannot consume the
      // entire network budget before this request reaches the provider.
      const signal=AbortSignal.any([taskSignal,AbortSignal.timeout(18000)]);
      let value,retryAt=0;
      try{
        const assetclass=instrumentTypeFor(symbol)==='ETF'?'etf':'stocks';
        const url='https://api.nasdaq.com/api/quote/'+encodeURIComponent(symbol)+'/'+
          (session==='regular'?'realtime-trades?assetclass='+assetclass+'&limit=100':
            'extended-trading?assetclass='+assetclass+'&markettype='+session);
        const request=async endpoint=>{
          const response=await httpsGet(endpoint,{Accept:'application/json',Referer:'https://www.nasdaq.com/'},{signal,timeout:6000,priority:1});
          if(response.status!==200)throw Object.assign(new Error('Public trades unavailable'),{
            code:response.status===429?'SOURCE_COOLDOWN':'PUBLIC_TRADES_UNAVAILABLE',
            retryAt:providerRetryAt(response.headers,now(),response.status===429?300000:60000)});
          return JSON.parse(response.body);
        };
        const payload=await request(url);
        value=parseNasdaqTrades(payload,{symbol,session,tradeDate,now:now()});
        // Nasdaq's last pre-market window can contain only opening prints.
        // The official filter selects 09:00-09:29; keep the strict PRE boundary.
        if(session==='pre'&&value.reason==='PUBLIC_TRADES_EMPTY'&&value.asOf>=localInstant(symbol,tradeDate,570)&&
          payload.data?.filterList?.some(f=>f.value===11&&f.name==='9:00 - 9:29'))
          value=parseNasdaqTrades(await request(url+'&time=11'),{symbol,session,tradeDate,now:now()});
      }catch(error){
        if(taskSignal.aborted)throw error;
        retryAt=Math.max(now()+10000,Number(error.retryAt)||0);
        value=unavailable(error.code==='SOURCE_COOLDOWN'?'SOURCE_COOLDOWN':'PUBLIC_TRADES_UNAVAILABLE',session,tradeDate,
          {sourceCheckedAt:now(),retryAt});
      }
      const day=tradingDayInfo(symbol,tradeDate),end=session==='pre'?day.regular_sessions[0]?.open_at_ms:
        session==='post'?localInstant(symbol,tradeDate,1200):day.regular_sessions.at(-1)?.close_at_ms;
      cache.set(key,{value,until:retryAt||now()+(value.events.length?(now()>end?300000:30000):60000)});
      while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
      return value;
    },{signal});
  }
  return {read,supports,close(){closed=true;tasks.close();cache.clear();},reopen(){closed=false;},
    diagnostics:()=>({entries:cache.size,inflight:tasks.size(),source:SOURCE})};
}
