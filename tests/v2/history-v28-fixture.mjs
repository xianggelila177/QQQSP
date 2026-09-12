// Synthetic daily history for tests only. This file is never installed by ops/install.sh.
export const fixtureNow=Date.parse('2026-09-11T14:16:00Z');
const cache=new Map();
export function dailyData(symbol='NVDA'){
 if(cache.has(symbol))return cache.get(symbol);
 const timestamp=[],open=[],high=[],low=[],close=[],volume=[];
 for(let ms=Date.parse('1988-01-04T16:00:00Z'),i=0;ms<=fixtureNow;ms+=864e5){
  if([0,6].includes(new Date(ms).getUTCDay()))continue;
  const v=50+i++*.012+Math.sin(i/11)*3;timestamp.push(ms/1000);open.push(v);high.push(v+2);low.push(v-1);close.push(v+.5);volume.push(100000+i*2);
 }
 const value={source:'fixture-history',meta:{symbol,currency:'USD',dataGranularity:'1d',instrumentType:'EQUITY',exchangeTimezoneName:'America/New_York',firstTradeDate:timestamp[0]},timestamp,indicators:{quote:[{open,high,low,close,volume}]}};
 cache.set(symbol,value);return value;
}
