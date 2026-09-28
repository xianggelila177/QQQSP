import {historyError,localDateAt} from '../history-contract.js';
import {regularChartTarget} from '../regular-chart-service.js';
import {createSharedTasks} from '../shared-task.js';
import {providerRetryAt} from './provider-retry.js';
import {twseListingFor} from './twse-listings.js';

// The Taiwan quote page embeds a native-currency minute chart independently
// of the rate-limited Yahoo chart API. Read JSON only, never execute page code.
function chartStore(html){
  if(typeof html!=='string'||Buffer.byteLength(html)>2*1024*1024)throw new Error('Invalid Taiwan page size');
  const root=html.indexOf('root.App.main = '),marker='"MarketChartStore":';
  const key=root<0?-1:html.indexOf(marker,root);
  if(key<0)throw new Error('Taiwan chart store missing');
  let start=key+marker.length;while(/\s/.test(html[start]||'x'))start++;
  if(html[start]!=='{')throw new Error('Invalid Taiwan chart store');
  let depth=0,string=false,escape=false;
  for(let i=start;i<html.length;i++){
    const c=html[i];
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c==='"')string=true;
    else if(c==='{')depth++;
    else if(c==='}'&&!--depth)return JSON.parse(html.slice(start,i+1));
  }
  throw new Error('Incomplete Taiwan chart store');
}

export function parseYahooTwChart(html,symbol,now=Date.now()){
  if(!twseListingFor(symbol))throw historyError('HISTORY_UNSUPPORTED','未确认的台股证券',422);
  let chart;
  try{chart=chartStore(html)?.libra?.[symbol];}catch{throw historyError('HISTORY_BAD_RESPONSE','Yahoo 台股分时响应不完整',502);}
  const m=chart?.meta,q=chart?.indicators?.quote?.[0],ts=chart?.timestamp;
  if(m?.symbol!==symbol||m.currency!=='TWD'||m.exchange!=='TAI'||m.quoteType!=='EQUITY'||
     m.exchangeTimezoneName!=='Asia/Taipei'||m.gmtoffset!==28800||m.dataGranularity!=='1m')
    throw historyError('HISTORY_IDENTITY_CONFLICT','台股分时证券、币种或交易所不匹配',422);
  if(!Array.isArray(ts)||ts.length<2||ts.length>400||!q||
     !['open','high','low','close','volume'].every(k=>Array.isArray(q[k])&&q[k].length===ts.length))
    throw historyError('HISTORY_BAD_RESPONSE','台股分时序列不完整',502);
  const target=regularChartTarget(symbol,now),period=m.currentTradingPeriod?.regular,session=target.regularSessions?.[0];
  if(!session||period?.start*1000!==session.open_at_ms||period?.end*1000!==session.close_at_ms||
     !Number.isFinite(m.regularMarketTime)||m.regularMarketTime*1000>now||
     localDateAt(m.regularMarketTime*1000,'Asia/Taipei')!==target.targetDate)
    throw historyError('HISTORY_TARGET_DAY_MISSING','台股分时未覆盖目标交易日',503);
  const rows=[];
  for(let i=0;i<ts.length;i++){
    const t=ts[i],c=q.close[i];
    if(!Number.isInteger(t)||(i&&t<=ts[i-1])||t<period.start||t>period.end)
      throw historyError('HISTORY_BAD_RESPONSE','台股分时日期或顺序无效',502);
    if(c===null||t*1000>now)continue;
    const o=q.open[i],h=q.high[i],l=q.low[i];
    if(![o,h,l,c].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)||h<Math.max(o,c)||l>Math.min(o,c))
      throw historyError('HISTORY_BAD_RESPONSE','台股分时价格无效',502);
    rows.push({t,o,h,l,c});
  }
  if(!rows.length)throw historyError('HISTORY_EMPTY','台股分时尚无成交价格',503);
  if(rows.at(-1).t===period.end&&rows.at(-1).c!==m.regularMarketPrice)
    throw historyError('HISTORY_CLOSE_CONFLICT','台股分时收盘不一致',502);
  return {source:'yahoo-tw-chart',retrievalLimited:true,
    coverage:{firstTradingDate:target.targetDate,lastTradingDate:target.targetDate,scope:'latest regular session; source minute close prices'},
    meta:{symbol,currency:'TWD',sourceCurrency:'TWD',priceScale:1,exchangeName:'TAI',exchangeTimezoneName:'Asia/Taipei',
      gmtoffset:28800,instrumentType:'EQUITY',dataGranularity:'1m',chartTimeBasis:'price-point',
      chartIntervalSeconds:60,sourceVolumeUnit:'source-unit-unverified',adjustmentStatus:'source-unverified'},
    timestamp:rows.map(r=>r.t),indicators:{quote:[{open:rows.map(r=>r.o),high:rows.map(r=>r.h),low:rows.map(r=>r.l),
      close:rows.map(r=>r.c),volume:rows.map(()=>null)}]}};
}

export function createYahooTwHistory({httpsGet,now=Date.now}={}){
  const cache=new Map(),shared=createSharedTasks(),versions=new Map();let closed=false;
  const stopped=()=>historyError('STOPPED','Taiwan history stopped',503);
  const fetch=async(symbol,query,{signal}={})=>{
    if(closed)throw stopped();signal?.throwIfAborted();
    if(!fetch.supports(symbol,query))throw historyError('HISTORY_UNSUPPORTED','台股网页仅提供最近交易日分时',422);
    const target=regularChartTarget(symbol,now()).targetDate,key=symbol+':'+target,old=cache.get(key);
    if(old?.until>now()){if(old.error)throw old.error;return old.value;}
    const version=versions.get(symbol)||0;
    return shared.run(key+':'+version,async taskSignal=>{
      try{
        const response=await httpsGet('https://tw.stock.yahoo.com/quote/'+encodeURIComponent(symbol),
          {Accept:'text/html'},{timeout:4500,signal:taskSignal});
        taskSignal.throwIfAborted();
        if(response?.status!==200)throw Object.assign(historyError('HISTORY_SOURCE_UNAVAILABLE','台股网页暂不可用',503),
          {retryAt:providerRetryAt(response?.headers,now(),60000)});
        const value=parseYahooTwChart(response.body,symbol,now());
        if((versions.get(symbol)||0)===version)cache.set(key,{value,until:now()+60000});
        return value;
      }catch(error){
        if(!taskSignal.aborted&&(versions.get(symbol)||0)===version)cache.set(key,{error,until:Math.max(now()+60000,error.retryAt||0)});
        throw error;
      }finally{while(cache.size>8)cache.delete(cache.keys().next().value);}
    },{signal});
  };
  fetch.supports=(symbol,query='?interval=5m&range=1d')=>{
    const p=new URLSearchParams(query);
    return !!twseListingFor(symbol)&&['1m','5m'].includes(p.get('interval'))&&!p.has('period1')&&!p.has('period2');
  };
  fetch.invalidate=symbol=>{versions.set(symbol,(versions.get(symbol)||0)+1);for(const key of cache.keys())if(key.startsWith(symbol+':'))cache.delete(key);};
  fetch.close=()=>{closed=true;shared.close(stopped());cache.clear();};
  fetch.reopen=()=>{closed=false;};
  return fetch;
}
