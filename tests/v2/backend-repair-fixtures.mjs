export const fixtureAt=Date.parse('2026-09-30T20:10:00Z');
export const turn=()=>new Promise(setImmediate);
export function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export function historyData(symbol,{start='2024-01-01',end='2026-09-30',count=Infinity,source='yahoo',price=100}={}){
 const timestamp=[];
 for(let at=Date.parse(start+'T16:00:00Z');at<=Date.parse(end+'T23:00:00Z')&&timestamp.length<count;at+=86400000)
  if(![0,6].includes(new Date(at).getUTCDay()))timestamp.push(at/1000);
 return {source,meta:{symbol,exchangeName:'NMS',exchangeTimezoneName:'America/New_York',currency:'USD',instrumentType:'EQUITY',dataGranularity:'1d'},timestamp,
  indicators:{quote:[{open:timestamp.map(()=>price),high:timestamp.map(()=>price+2),low:timestamp.map(()=>price-1),close:timestamp.map(()=>price+1),volume:timestamp.map(()=>1000)}]}};
}
export function rangeSource(calls,{start='1986-01-02',...config}={}){
 return async(symbol,query,options)=>{const params=new URLSearchParams(query),from=Number(params.get('period1')),through=Number(params.get('period2'));
  calls.push({symbol,from,through,options});
  return historyData(symbol,{...config,start:new Date(Math.max(from*1000,Date.parse(start))).toISOString().slice(0,10),end:new Date(through*1000).toISOString().slice(0,10)});
 };
}
export const quote=(symbol='NVDA')=>({symbol,price:100,currency:'USD',instrumentType:'EQUITY',marketState:'POST',quoteAt:fixtureAt-1000,sourceCheckedAt:fixtureAt,src:'fixture'});
