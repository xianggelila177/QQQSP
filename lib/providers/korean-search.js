import {createCachedResource} from '../cached-resource.js';
// A six-digit code is ambiguous across countries. Only return a Korean listing
// after the Korean source confirms both its code and KS/KQ market.
export function createKoreanSearch({httpsGet,now=Date.now}={}) {
  const cache=createCachedResource({now,ttlMs:3600000,failureCooldownMs:60000,maxEntries:32,loader:async query=>{
    const match=/^(\d{6})(?:\.(KS|KQ))?$/.exec(query);
    if(!match)return [];
    const response=await httpsGet('https://polling.finance.naver.com/api/realtime/domestic/stock/'+match[1],{Referer:'https://m.stock.naver.com/'},{timeout:2500});
    if(response.status!==200)throw Object.assign(new Error('Korean search unavailable'),{status:response.status});
    const row=(JSON.parse(response.body).datas||[]).find(r=>r.itemCode===match[1]);
    const suffix=row?.stockExchangeType?.code;
    if(!['KS','KQ'].includes(suffix)||match[2]&&match[2]!==suffix)return [];
    return [{symbol:match[1]+'.'+suffix,name:row.stockName||match[1],market:suffix==='KS'?'韩股':'韩股(KOSDAQ)',exch:suffix==='KS'?'KOSPI':'KOSDAQ',type:'EQUITY',currency:'KRW',source:'naver-search'}];
  }});
  return query=>/^\d{6}(?:\.(KS|KQ))?$/.test(String(query).toUpperCase())?cache.get(String(query).toUpperCase()):Promise.resolve([]);
}
