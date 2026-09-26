// Synthetic OHLC for deterministic adapter/aggregation tests; live endpoints are verified separately.
const dailyRows=Array.from({length:360},(_,i)=>{
 const date=new Date(Date.UTC(1999+Math.floor(i/12),i%12,15));
 return {date:date.toISOString().slice(0,10),open:'186.00',high:'188.00',low:'185.00',close:'187.67',volume:'6,535,157'};
});
export function nasdaqXlkResponse(raw){
 const url=new URL(raw);
 if(url.searchParams.get('assetclass')!=='etf')return {status:200,body:JSON.stringify({data:null,status:{rCode:400,bCodeMessage:[{code:1001,errorMessage:'Symbol not exists.'}]}})};
 const from=url.searchParams.get('fromdate')||'1900-01-01',through=url.searchParams.get('todate')||'2100-01-01';
 const data=url.pathname.endsWith('/chart')?{symbol:'XLK',chart:[{x:Date.parse('2026-09-11T15:59:00Z'),y:187.65,z:{dateTime:'3:59 PM ET'}},{x:Date.parse('2026-09-11T20:00:00Z'),y:187.67,z:{dateTime:'8:00 PM ET'}}]}:
  {symbol:'XLK',tradesTable:{rows:dailyRows.filter(row=>row.date>=from&&row.date<=through).slice(-Number(url.searchParams.get('limit')||dailyRows.length))}};
 return {status:200,body:JSON.stringify({data,status:{rCode:200}})};
}
