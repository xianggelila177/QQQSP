import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {modules,mounted} from './chart-viewport-fixture.mjs';
import {detailHarness} from './detail-ux-fixture.mjs';

const annual=year=>({t:Date.parse(year+'-01-01T00:00:00Z')/1000,periodStart:year+'-01-01',periodEndExclusive:(year+1)+'-01-01',periodState:'closed',o:100,h:110,l:90,c:105,v:null,coverageStatus:'unknown'});
const history=[{...annual(2012),coverageStatus:'partial',missingTradingDates:['2012-10-22'],qualityFlags:['source-invalid-ohlc']},annual(2018)];
const meta={source:'naver-index-history',currency:'POINTS',volumeUnit:'source-unit-unverified',historyAsOf:'2026-10-02',coverageStatus:'partial',
  historyQuality:{status:'partial',missingTradingDates:['2012-10-22'],reason:'source-invalid-ohlc'}};

test('main annual chart names the excluded source date in Chinese without blaming an unaffected selected year',async()=>{
  const m=modules();vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-format.js',import.meta.url),'utf8'),{window:m.window,Date,Intl});
  const store={getSeries:()=>history,getRevision:()=>1,getMeta:()=>({status:'ready',meta}),load:async()=>{},abort(){},needsLoad:()=>false};
  const c=mounted(m,history,'yearly',20,store);
  try{
    assert.match(c.q.chartState.textContent,/来源数据异常.*2012-10-22/);
    await c.q.cv.dispatch('keydown',{key:'Home',preventDefault(){}});
    assert.match(c.q.point.textContent,/2012.*来源数据异常.*2012-10-22.*缺失 1 个交易日/);
    assert.match(c.q.ohlc.innerHTML,/2012-10-22/);
    assert.doesNotMatch(c.q.point.textContent,/source-invalid-ohlc|historyQuality/);
    await c.q.cv.dispatch('keydown',{key:'End',preventDefault(){}});
    assert.doesNotMatch(c.q.point.textContent,/来源数据异常|2012-10-22|缺失 1/);
  }finally{c.controller.unmount(c.q);}
});

test('detail annual cursor and source explanation expose the missing date with a readable coverage warning',async()=>{
  const h=detailHarness();h.data.yearly=history;h.card.historyStore.getMeta=()=>({status:'ready',meta});
  try{
    await h.select('yearly');
    assert.match(h.field('.cd-chart-info').textContent,/来源数据异常/);
    assert.match(h.field('.cd-chart-quality').textContent,/2012-10-22.*缺失 1 个交易日/);
    const cv=h.field('.cd-canvas');cv.dispatch('keydown',{key:'Home'});
    assert.match(h.field('.cd-point').textContent,/2012.*来源数据异常.*2012-10-22.*缺失 1 个交易日/);
    assert.doesNotMatch(h.field('.cd-point').textContent+h.field('.cd-chart-quality').textContent,/source-invalid-ohlc|historyQuality/);
    cv.dispatch('keydown',{key:'End'});assert.doesNotMatch(h.field('.cd-point').textContent,/来源数据异常|2012-10-22|缺失 1/);
  }finally{h.view.close();}
});

test('initial card without history metadata stays usable before the first response',()=>{
  const m=modules();vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-format.js',import.meta.url),'utf8'),{window:m.window,Date,Intl});
  const store={getSeries:()=>[],getRevision:()=>0,getMeta:()=>({status:'unknown',meta:null}),load:async()=>{},abort(){},needsLoad:()=>false};
  const c=mounted(m,[],'yearly',20,store);
  try{assert.doesNotMatch(c.q.chartState.textContent,/来源数据异常|缺失/);}finally{c.controller.unmount(c.q);}
});
