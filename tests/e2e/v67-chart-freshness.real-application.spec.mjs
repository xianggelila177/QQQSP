import {test as base,expect,createRealServer} from './real-fixtures.mjs';
import {openPanel} from './fixtures.mjs';
const fixedNow=Date.parse('2026-09-08T15:00:25Z');
const test=base.extend({panelServer:async({},use)=>{
 const server=await createRealServer({snapshots:true,fixedNow,snapshotMarketState:'REGULAR'});
 const historyTime=Math.floor((fixedNow-25000)/1000);
 server.state.quotePatches={QQQ:{price:718.01,regularPrice:718.01,priceSession:'REGULAR',marketState:'REGULAR',quoteAt:fixedNow,
  charts:{intraday:[{t:historyTime-60,c:717.70,v:100},{t:historyTime,c:717.81,v:100}],daily30:[{t:historyTime-86400,o:714,h:720,l:710,c:717,v:1000}]}}};
 try{await use(server);}finally{await server.close();}
}});

test('v67 fast regular quote appears at the live intraday endpoint without waiting for slow history enrichment',async({page,panelServer})=>{
 await page.clock.install({time:new Date(fixedNow)});await openPanel(page,panelServer,['QQQ']);
 const card=page.locator('.price-card[data-sym="QQQ"]');
 await expect(card.locator('.cur')).toHaveText('718.01');
 const observed=await page.evaluate(()=>{
  const q=window.__hooks.cardCache.get('QQQ');
  return {price:q.d.price,quoteAt:q.d.quoteAt,apiTail:q.d.charts.intraday.at(-1),live:q.d.intradayLivePoint,canvasTail:q.plot.bars.at(-1)};
 });
 await test.info().attach('fast-quote-intraday-evidence',{body:JSON.stringify(observed,null,2),contentType:'application/json'});
 expect(observed.apiTail.c,'Historical source data must remain unchanged').toBe(717.81);
 expect(observed.live?.c,'Separate live point should include the newer regular quote').toBe(observed.price);
 expect(observed.canvasTail.c).toBe(observed.price);
 expect(observed.canvasTail.t).toBe(Math.floor(observed.quoteAt/1000));
 expect(observed.canvasTail.v).toBeNull();
 await expect(card.locator('.ohlcbar')).toContainText('718.01');
 await expect(card.locator('.ohlcbar')).toContainText('最新报价点');
 await expect(card.locator('.ohlcbar')).toContainText('naver-us');
});
