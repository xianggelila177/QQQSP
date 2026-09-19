export const nikkeiNow=Date.parse('2026-09-17T13:40:00Z');
export const nikkeiBasic={stockEndType:'index',reutersCode:'.N225',stockExchangeType:{code:'TYO',zoneId:'Asia/Tokyo',nationCode:'JPN',delayTime:15},indexType:{symbolCode:'N225',currencyType:{code:'JPY'}}};
export function nikkeiSnapshot({price='64,136.25',at='2026-09-17T15:45:03+09:00'}={}){return {pollingInterval:70000,datas:[{reutersCode:'.N225',symbolCode:'N225',indexName:'니케이 225',stockExchangeType:{code:'TYO',zoneId:'Asia/Tokyo',nationCode:'JPN',delayTime:15},closePrice:price,compareToPreviousClosePrice:'213.25',compareToPreviousPrice:{name:'RISING'},openPrice:'64,643.58',highPrice:'64,643.58',lowPrice:'63,824.56',marketStatus:'CLOSE',localTradedAt:at,accumulatedTradingVolumeRaw:'1333997000'}]};}
export const nikkeiIntraday={code:'.N225',infoType:'index',periodType:'day',stockExchangeType:'TOKYO',tradeBaseAt:'20260917',lastClosePrice:63923,priceInfos:[{localDateTime:'20260917090000',currentPrice:64540.16,accumulatedTradingVolume:67163},{localDateTime:'20260917113000',currentPrice:64000},{localDateTime:'20260917123000',currentPrice:64020},{localDateTime:'20260917153000',currentPrice:64136.25,accumulatedTradingVolume:1073867}]};
// Deliberately synthetic OHLC for multi-period aggregation; actual quotes above
// were independently checked against the publisher and the public provider.
export const nikkeiDaily=Array.from({length:120},(_,i)=>({localDate:new Date(Date.UTC(2017+Math.floor(i/12),i%12,10)).toISOString().slice(0,10).replaceAll('-',''),openPrice:60000+i,highPrice:65000+i,lowPrice:59000+i,closePrice:64000+i,accumulatedTradingVolume:1000000}));
export const jsonResponse=body=>({status:200,headers:{},body:JSON.stringify(body)});
export function nikkeiUpstream(url,{snapshot=nikkeiSnapshot(),daily=nikkeiDaily}={}){
 const u=new URL(url);
 if(u.hostname==='polling.finance.naver.com'&&u.pathname==='/api/realtime/worldstock/index/.N225')return jsonResponse(snapshot);
 if(u.hostname==='api.stock.naver.com'&&u.pathname==='/index/.N225/basic')return jsonResponse(nikkeiBasic);
 if(u.hostname==='api.stock.naver.com'&&u.pathname==='/chart/foreign/index/.N225')return jsonResponse(nikkeiIntraday);
 if(u.hostname==='api.stock.naver.com'&&u.pathname==='/chart/foreign/index/.N225/day')return jsonResponse(daily);
 throw Error('Unexpected test upstream '+u.origin+u.pathname);
}
