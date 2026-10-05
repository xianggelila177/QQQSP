import test from 'node:test';
import assert from 'node:assert/strict';
import {detailHarness,tape,trade,bar} from './detail-ux-fixture.mjs';

test('T20 detail open and silent ticker use the supplied quote clock and stop on close',async()=>{
  const h=detailHarness();await h.flush();assert.equal(h.field('.cd-status').textContent,'报价年龄 10秒');
  h.setNow(trade.at+12000);await h.tick();assert.equal(h.field('.cd-status').textContent,'报价年龄 12秒');
  h.view.close();const timers=h.timers.size;h.setNow(trade.at+20000);await h.tick();assert.equal(h.timers.size,timers);assert.equal(h.field('.cd-status').textContent,'报价年龄 12秒');
});

test('T19/T21 real detail response exposes readable quality and exact event/quote sizes',async()=>{
  const h=detailHarness();await h.respond(0,{tape:tape([{...trade,size:1001},{...trade,size:1499,at:trade.at+1000},{...trade,size:1500,at:trade.at+2000},{...trade,size:.125,at:trade.at+3000}]),book:{bid:{price:109,size:1999},ask:{price:110,size:1001},source:'nasdaq-public-book',sizeUnit:'round_lots',coverage:'source-website-top-of-book-unverified',asOf:null,checkedAt:trade.at,delayMinutes:null}});
  for(const size of ['1,001','1,499','1,500','0.125'])assert.ok(h.field('.cd-tape-list').textContent.includes(size),size);
  assert.match(h.field('.cd-bid-size').textContent,/1,999 整手/);
  assert.match(h.field('.cd-tape-quality').textContent,/非完整逐笔.*延迟未核验/);
  assert.match(h.field('.cd-tape-quality').textContent,/更正.*撤销/);
  assert.doesNotMatch(h.field('.cd-tape-quality').textContent,/NO_TRADE_IDS|CORRECTIONS_UNAVAILABLE/);
  assert.match(h.field('.cd-book-quality').textContent,/来源网站一档报价.*每整手股数未核验/);assert.doesNotMatch(h.field('.cd-book-quality').textContent,/source-website/);h.view.close();
});

test('T22 an unchanged tape snapshot retains the same row nodes and cached time formatter',async()=>{
  const h=detailHarness();await h.respond(0,{tape:tape(Array.from({length:200},(_,i)=>({...trade,at:trade.at+i*1000})))});
  const list=h.field('.cd-tape-list'),table=list.children[0],before=list.mutations,formats=h.formats();
  for(const timer of h.timers.values())if(timer.interval)timer.fn();
  await h.respond(h.pending.length-1,{tape:tape(Array.from({length:200},(_,i)=>({...trade,at:trade.at+i*1000})))});
  assert.equal(list.children[0],table);assert.equal(list.mutations,before);assert.ok(h.formats()-formats<5);h.view.close();
});

test('T10 detail dragging near the left edge requests one earlier page and preserves its visible date',async()=>{
  const h=detailHarness();await h.select('daily30');const cv=h.field('.cd-canvas');
  cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:300,clientY:10});
  cv.dispatch('pointermove',{pointerId:1,clientX:5000,clientY:10});await h.flush();
  assert.equal(h.loads.filter(x=>x.before&&!x.limit).length,1);
  const date=h.plot().bars[0].periodStart;
  cv.dispatch('pointermove',{pointerId:1,clientX:5001,clientY:10});await h.flush();assert.equal(h.loads.filter(x=>x.before&&!x.limit).length,1);
  await h.completePage();assert.equal(h.plot().bars[0].periodStart,date);assert.ok(h.plot().a>=10);h.view.close();
});

test('T11 detail restores each timeframe scale, date and style after switching and reopening',async()=>{
  const h=detailHarness();await h.select('daily30');h.field('[data-action="in"]').click();await h.flush();
  h.field('[data-chart-style="line"]').click();await h.flush();const before={vis:h.plot().vis,date:h.plot().bars[0].periodStart};
  await h.select('weekly');assert.equal(h.plot().candle,true,'daily style must not leak to weekly');
  await h.select('daily30');assert.equal(h.plot().vis,before.vis);assert.equal(h.plot().bars[0].periodStart,before.date);assert.equal(h.plot().candle,false);
  h.view.close();h.card.el.querySelector('.chart-expand').click();await h.select('daily30');assert.equal(h.plot().vis,before.vis);assert.equal(h.plot().candle,false);h.view.close();
});

test('T19 nonempty history still exposes partial coverage, date and close conflicts',async()=>{
  const h=detailHarness();h.card.d.regularChart={...h.card.d.regularChart,status:'partial',reason:'FIVE_DAY_INTERVAL_COVERAGE_UNVERIFIED',stale:true,tradeDate:'2026-09-24'};
  h.view.update(h.card);await h.flush();
  assert.match(h.field('.cd-chart-info').textContent,/数据截至 2026-09-24/);assert.match(h.field('.cd-chart-info').textContent,/覆盖不完整/);
  assert.match(h.field('.cd-chart-quality').textContent,/日内覆盖待核验/);
  const meta={source:'twse-stock-day',historyAsOf:'2026-09-24',currency:'TWD',closeConsistency:{status:'conflict'},adjustmentBasis:'source-default-unverified'};
  const result=h.panel.PANEL_MARKET_DETAIL_VIEW.chartQuality({},meta,{});assert.match(result.short,/收盘价冲突/);assert.match(result.detail,/复权口径未核验/);h.view.close();
});

test('T23 closing/hiding/changing symbol aborts the old market work and restores focus',async()=>{
  const h=detailHarness();h.document.hidden=true;h.view.syncVisibility();assert.equal(h.pending[0].signal.aborted,true);
  h.document.hidden=false;h.view.syncVisibility();assert.equal(h.pending.length,2);
  h.view.close();assert.equal(h.pending[1].signal.aborted,true);assert.equal(h.card.el.querySelector('.chart-expand').focused,true);
  const old=h.pending[1];h.card.symbol='AAPL';h.card.d={...h.card.d,symbol:'AAPL'};h.card.el.querySelector('.chart-expand').click();
  old.resolve({ok:true,json:async()=>({symbol:'NVDA',range:'1d',tape:tape()})});await h.flush();
  assert.equal(h.field('.cd-tape-list').children.length,0,'late old response cannot paint new security');
  h.view.remove(h.card);assert.equal(h.pending.at(-1).signal.aborted,true);assert.equal(h.dialog.open,false);
});

test('T22 hiding tape defers changed rows until the tape tab is selected',async()=>{
  const h=detailHarness();await h.respond(0,{tape:tape()});const table=h.field('.cd-tape-list').children[0];
  h.field('[data-side="stats"]').click();for(const timer of h.timers.values())if(timer.interval)timer.fn();
  await h.respond(h.pending.length-1,{tape:tape([{...trade,size:1999}])});assert.equal(h.field('.cd-tape-list').children[0],table);
  h.field('[data-side="tape"]').click();assert.notEqual(h.field('.cd-tape-list').children[0],table);assert.match(h.field('.cd-tape-list').textContent,/1,999/);h.view.close();
});

test('T10/T11 hydrate before an anchored date and reopening after a prepend preserve that date',async()=>{
  const h=detailHarness();await h.select('daily30');const cv=h.field('.cd-canvas');
  cv.dispatch('wheel',{ctrlKey:true,deltaY:-1,clientX:400,clientY:10});await h.flush();
  const date=h.plot().bars[0].periodStart;
  h.replaceSeries('daily30',[bar(-2),bar(-1),...h.data.daily30]);await h.flush();assert.equal(h.plot().bars[0].periodStart,date);
  h.view.close();h.replaceSeries('daily30',[bar(-4),bar(-3),...h.data.daily30]);
  h.card.el.querySelector('.chart-expand').click();await h.select('daily30');assert.equal(h.plot().bars[0].periodStart,date);h.view.close();
});

test('T11 reopening intraday preserves the saved date when earlier bars arrive while closed',async()=>{
  const h=detailHarness();await h.flush();h.field('.cd-canvas').dispatch('wheel',{ctrlKey:true,deltaY:-1,clientX:400,clientY:10});await h.flush();
  const at=h.plot().bars[0].t;h.view.close();const first=h.card.d.regularChart.bars[0];
  h.card.d.regularChart.bars=[{...first,t:first.t-120},{...first,t:first.t-60},...h.card.d.regularChart.bars];
  h.card.el.querySelector('.chart-expand').click();await h.flush();assert.equal(h.plot().bars[0].t,at);h.view.close();
});

test('T10 day/week/year detail can fetch two distinct pages without moving the selected date',async()=>{
  for(const tf of ['daily30','weekly','yearly']){
    const h=detailHarness({pageCount:2});await h.select(tf);const cv=h.field('.cd-canvas');
    for(let page=0;page<2;page++){
      cv.dispatch('pointerdown',{pointerType:'mouse',button:0,pointerId:page+1,clientX:300,clientY:10});
      cv.dispatch('pointermove',{pointerId:page+1,clientX:50000,clientY:10});await h.flush();
      const date=h.plot().bars[0].periodStart;assert.equal(h.loads.filter(x=>x.before&&!x.limit).length,page+1,tf);
      await h.completePage();assert.equal(h.plot().bars[0].periodStart,date,tf);
      cv.dispatch('pointerup',{pointerId:page+1,clientX:50000,clientY:10});
    }
    const pages=h.loads.filter(x=>x.before&&!x.limit);assert.notEqual(pages[0].before,pages[1].before);assert.match(h.field('.cd-history-state').textContent,/历史起点/);h.view.close();
  }
});

test('T19 daily quality is independent of the current intraday failure and exposes five-day missing intervals',async()=>{
  const h=detailHarness();h.card.d.regularChart={...h.card.d.regularChart,status:'partial',stale:true,refreshError:'FIVE_DAY_COVERAGE_REGRESSION'};
  await h.select('daily30');assert.doesNotMatch(h.field('.cd-chart-info').textContent,/缓存待更新|保留旧图|覆盖不完整/);
  const quality=h.panel.PANEL_MARKET_DETAIL_VIEW.chartQuality({intervalCoverage:{status:'partial',observedBars:390,days:[{missingSlots:3}]}},{},{});
  assert.match(quality.detail,/收到 390 根.*未覆盖 3 个预期时段/);h.view.close();
});

test('T01 detail names intraday price lines and historical close lines consistently with the card',async()=>{
  const h=detailHarness();await h.flush();assert.equal(h.field('[data-chart-style="line"]').textContent,'分时线');
  for(const tf of ['daily30','weekly','yearly']){
    await h.select(tf);assert.equal(h.field('[data-chart-style="line"]').textContent,'收盘线');
    h.field('[data-chart-style="line"]').click();await h.flush();assert.match(h.field('.cd-chart-info').textContent,/收盘线/);assert.doesNotMatch(h.field('.cd-chart-info').textContent,/分时线/);
  }
  await h.select('fiveDay');assert.equal(h.field('[data-chart-style="line"]').textContent,'分时线');
  await h.select('intraday');assert.equal(h.field('[data-chart-style="line"]').textContent,'分时线');h.view.close();
});
