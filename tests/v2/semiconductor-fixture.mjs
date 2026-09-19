export const semiNow=Date.parse('2026-09-18T14:16:00Z');
export const soxExchange={code:'NSQ',zoneId:'EST5EDT',nationCode:'USA',delayTime:0};
export const soxBasic={stockEndType:'index',reutersCode:'.SOX',stockExchangeType:soxExchange,indexType:{symbolCode:'SOX',currencyType:null}};
export const soxRow={reutersCode:'.SOX',symbolCode:'SOX',stockExchangeType:soxExchange,closePrice:'11,752.61',compareToPreviousClosePrice:'153.11',compareToPreviousPrice:{name:'RISING'},openPrice:'11,691.00',highPrice:'11,788.78',lowPrice:'11,686.09',marketStatus:'OPEN',localTradedAt:'2026-09-18T10:15:34-04:00'};
export const soxIntraday={code:'.SOX',infoType:'index',periodType:'day',stockExchangeType:'NASDAQ',lastClosePrice:11599.492,priceInfos:[{localDateTime:'20260918093000',currentPrice:11692.841},{localDateTime:'20260918101500',currentPrice:11751.495}]};
export const soxDaily=[{localDate:'20260115160000'.slice(0,8),openPrice:6500,highPrice:6700,lowPrice:6400,closePrice:6600},{localDate:'20260918',openPrice:11691.004,highPrice:11788.783,lowPrice:11686.093,closePrice:11751.491}];
export const json=body=>({status:200,headers:{},body:JSON.stringify(body)});
export function semiUpstream(raw){
 const u=new URL(raw);
 if(u.hostname==='polling.finance.naver.com'&&u.pathname.endsWith('/index/.SOX'))return json({pollingInterval:7000,datas:[soxRow]});
 if(u.hostname==='api.stock.naver.com'){
  if(u.pathname==='/index/.SOX/basic')return json(soxBasic);
  if(u.pathname==='/chart/foreign/index/.SOX')return json(soxIntraday);
  if(u.pathname==='/chart/foreign/index/.SOX/day')return json(soxDaily);
 }
 if(u.hostname==='api.nasdaq.com'&&u.pathname.startsWith('/api/quote/SOXX/')){
  if(u.searchParams.get('assetclass')!=='etf')return json({data:null,status:{rCode:400,bCodeMessage:[{errorMessage:'Symbol not exists.'}]}});
  return json({data:u.pathname.endsWith('/chart')?{symbol:'SOXX',chart:[{x:Date.parse('2026-09-18T09:30:00Z'),y:523.61,z:{dateTime:'9:30 AM ET'}},{x:Date.parse('2026-09-18T10:15:00Z'),y:525.45,z:{dateTime:'10:15 AM ET'}}]}:{symbol:'SOXX',tradesTable:{rows:[{date:'09/17/2026',open:'517.09',high:'520.4192',low:'514.80',close:'519.10',volume:'6,790,710'}]}}});
 }
 throw Error('Unexpected fixture '+u.origin+u.pathname);
}
