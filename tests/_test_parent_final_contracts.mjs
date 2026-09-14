import assert from 'node:assert/strict';
import {createYahooAuth} from '../lib/yahoo-auth.js';
import {createQuoteService} from '../lib/quote.js';
import {createNasdaqProvider} from '../lib/providers/nasdaq.js';
import {extSessions} from '../lib/sessions.js';

let authCalls=0;
const auth=createYahooAuth({
  yGated:run=>run(undefined,1000),
  httpsGet:async url=>{
    authCalls++;
    if(url==='https://fc.yahoo.com')return {status:404,headers:{'set-cookie':['a=b; Path=/']},body:''};
    assert.equal(url,'https://query1.finance.yahoo.com/v1/test/getcrumb');
    return {status:200,headers:{},body:'fixture-crumb'};
  },
});
const credentials=await Promise.all(Array.from({length:12},()=>auth.getCrumb()));
assert.equal(authCalls,2,'cold credential handshake must be shared');
assert.ok(credentials.every(x=>x.crumb==='fixture-crumb'&&x.cookie==='a=b'));
console.log('PASS twelve concurrent callers share one credential handshake');

const now=Date.parse('2026-09-05T12:00:00Z');
const t=Date.parse('2026-09-04T16:00:00-04:00')/1000;
const quoteService=createQuoteService({now:()=>now,extSessions,providers:{
  fetchChart:async()=>({meta:{symbol:'QQQ',instrumentType:'ETF',currency:'USD',regularMarketPrice:100,regularMarketTime:t},timestamp:[t],indicators:{quote:[{close:[100]}]}}),
  getDayOhlc:async()=>({open:99,high:101,low:98,prevClose:99}),getFxRates:async()=>({USD:7}),
  getNasdaqDaily:async()=>[{t,o:98,h:101,l:97,c:99}],getYahooDaily:async()=>[{t,o:99,h:101,l:98,c:100}],cnSnapshot:async()=>null,
}});
const quote=await quoteService.fetchQuote('QQQ');
assert.equal(quote.charts.daily30[0].c,100,'same-day tie must prefer Yahoo current candle');
assert.equal(quote.src,'yahoo');
console.log('PASS same-day daily source choice and explicit quote provenance');

let historyUrl;
const nasdaq=createNasdaqProvider({httpsGet:async url=>{
  historyUrl=new URL(url);
  assert.equal(historyUrl.hostname,'api.nasdaq.com');
  return {status:200,headers:{},body:JSON.stringify({data:{tradesTable:{rows:[{date:'09/04/2026',open:'100',high:'101',low:'99',close:'100',volume:'1000'}]}}})};
}});
const bars=await nasdaq.getNasdaqDaily('ZZZ');
assert.equal(bars.length,1);
const days=(Date.parse(historyUrl.searchParams.get('todate'))-Date.parse(historyUrl.searchParams.get('fromdate')))/86400000;
assert.ok(days>=210,'history request must cover enough calendar days for126tradingbars');
console.log('PASS history request covers the intended trading-bar window');
