import {test as base,expect,createRealServer} from './real-fixtures.mjs';
import {openPanel} from './fixtures.mjs';
const fixedNow=Date.parse('2026-09-06T00:00:00Z');
const test=base.extend({panelServer:async({},use)=>{
 const server=await createRealServer({snapshots:true,startupPartial:true,fixedNow});
 try{await use(server);}finally{await server.close();}
}});

test('closed-market cold fallback visibly recovers missing intraday before normal fifteen-minute enrichment',async({page,panelServer})=>{
 await page.clock.install({time:new Date(fixedNow)});await openPanel(page,panelServer);
 const card=page.locator('.price-card[data-sym="QQQ"]');
 await expect(card.locator('.cur')).not.toHaveText('—');
 const read=async()=>{const response=await page.request.get(panelServer.url+'/api/market?symbols=QQQ');expect(response.status()).toBe(200);return (await response.json())[0];};
 await expect.poll(async()=>(await read()).slowFields?.intraday?.status).toBe('missing');
 const partial=await read();expect(partial.slowFields.intraday.maxAgeMs).toBe(1800000);expect(partial.price).toBeGreaterThan(0);expect(partial.charts.intraday).toEqual([]);
 const daily=await page.request.get(panelServer.url+'/api/history?symbol=QQQ&period=daily');expect(daily.status()).toBe(200);expect((await daily.json()).bars.length).toBeGreaterThan(0);
 await page.evaluate(()=>window.__hooks.refresh(false));
 await expect(card.locator('.quote-meta')).toContainText('分时图缓存待更新');
 panelServer.state.startupPartial=false;panelServer.state.clockOffset+=61000;
 await page.clock.setSystemTime(fixedNow+61000);
 await expect.poll(async()=>(await read()).charts?.intraday?.length,{timeout:10000}).toBeGreaterThan(0);
 await page.evaluate(()=>window.__hooks.refresh(false));
 await expect(card.locator('.chart-summary')).toContainText('个数据点');
 await expect(card.locator('.quote-meta')).not.toContainText('分时图缓存待更新');
 const recovered=await read();expect(recovered.slowFields.intraday.stale).toBe(false);
 expect(panelServer.app.services.snapshots.diagnostics().enrichmentRetries).toEqual({});
});
