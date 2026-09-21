import {MAX_WATCHLIST_SYMBOLS} from './watchlist-limits.js';
import {chartRevision} from './chart-revision.js';
export {chartRevision};
export function parseCv(raw) {
  const map=new Map(); if(!raw) return map;
  const segments=String(raw).split(';'); if(segments.length>MAX_WATCHLIST_SYMBOLS) return map;
  for(const segment of segments) {
    const m=/^([A-Z0-9.\-^=&]{1,16}):(\d+):(\d+)$/.exec(segment);
    if(!m || !Number.isSafeInteger(Number(m[2])) || !Number.isSafeInteger(Number(m[3]))) return new Map();
    map.set(m[1],{iVer:Number(m[2]),dVer:Number(m[3])});
  }
  return map;
}
export function applyChartVersions(list,cvMap) {
  return list.map(q=>{
    if(!q || typeof q!=='object') return q;
    const intra=Array.isArray(q.charts?.intraday)?q.charts.intraday:null;
    const daily=Array.isArray(q.charts?.daily30)?q.charts.daily30:null;
    const iVer=chartRevision(intra),dVer=chartRevision(daily),last=intra?.at(-1),want=cvMap.get(String(q.symbol||'').toUpperCase());
    const out={...q,intradayVer:iVer,daily30Ver:dVer,intradayLast:last?[last.t,last.c]:null,daily30Version:dVer};
    if(q.charts) {
      out.charts={...q.charts};
      if(want && iVer>0 && want.iVer===iVer) out.charts.intraday='same';
      if(want && dVer>0 && want.dVer===dVer) out.charts.daily30='same';
    }
    return out;
  });
}
