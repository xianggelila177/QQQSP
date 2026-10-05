import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const at=Date.parse('2026-10-02T05:00:00Z');
const value=(period,extra={})=>({schemaVersion:1,symbol:'NVDA',period,seriesId:'naver:'+period,revision:period+'-1',
  source:'naver-index-history',sourceCheckedAt:at,status:'ready',stale:false,errorCode:null,retryAt:null,
  bars:[{periodStart:'2026-10-01',periodEndExclusive:'2026-10-02',t:Date.parse('2026-10-01T00:00:00Z')/1000,o:100,h:102,l:99,c:101,v:null}],...extra});

function setup(){
  const window={PANEL_FORMAT:{fmtDate:String,fmtVol:String},addEventListener(){},fetch:async()=>{throw Error('unexpected network');}};
  const document={addEventListener(){}};
  const sandbox={window,document,Date,URLSearchParams,AbortController,IntersectionObserver:undefined,ResizeObserver:undefined};
  for(const name of ['panel-timeframes','panel-history-store','panel-chart-controller'])
    vm.runInNewContext(readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),sandbox);
  const controller=window.PANEL_CHART_CONTROLLER.createChartController({document,client:{createChartEngine:()=>({})},
    formatterFor:()=>({money:String}),formatKey:()=>'',flash(){},UP:'red',DOWN:'green'});
  const historyStore=window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',network:{}});
  const q={symbol:'NVDA',tf:'intraday',historyStore};
  return {apply:prepared=>controller.applyPrewarm(q,{symbol:'NVDA',...prepared}),store:historyStore,q};
}

test('aggregate stale from another period cannot turn fresh daily prewarm into stale',()=>{
  const {apply,store}=setup();const daily=value('daily'),weekly=value('weekly',{status:'stale',stale:true,errorCode:'WEEKLY_SOURCE_STALE',retryAt:at+300000});
  apply({status:'stale',refreshFailed:false,error:'WEEKLY_SOURCE_STALE',retryAt:at+600000,periods:{daily,weekly}});
  const d=store.getMeta('daily30'),w=store.getMeta('weekly');
  assert.equal(d.status,'ready');assert.equal(d.meta.stale,false);assert.equal(d.errorCode,null);assert.equal(d.retryAt,null);
  assert.equal(d.meta.sourceCheckedAt,at);assert.equal(d.meta.prewarmed,true);
  assert.equal(w.status,'stale');assert.equal(w.meta.stale,true);assert.equal(w.errorCode,'WEEKLY_SOURCE_STALE');assert.equal(w.retryAt,at+300000);
  assert.equal(store.getMeta('monthly').status,'unknown','an omitted period does not inherit another period failure');
});

test('only explicit failed refresh may apply the bundle failure to cached or missing periods',()=>{
  const {apply,store}=setup();const daily=value('daily');
  apply({status:'ready',refreshFailed:false,periods:{daily}});const bars=store.getSeries('daily30');
  apply({status:'stale',refreshFailed:true,error:'HISTORY_SOURCE_UNAVAILABLE',retryAt:at+60000,periods:{daily:{...daily,bars:'same'}}});
  assert.equal(store.getSeries('daily30'),bars);assert.equal(store.getMeta('daily30').status,'stale');
  assert.equal(store.getMeta('daily30').meta.stale,true);assert.equal(store.getMeta('daily30').meta.sourceCheckedAt,at);
  assert.equal(store.getMeta('daily30').errorCode,'HISTORY_SOURCE_UNAVAILABLE');assert.equal(store.getMeta('daily30').retryAt,at+60000);
  assert.equal(store.getMeta('weekly').status,'error');assert.equal(store.getMeta('weekly').errorCode,'HISTORY_SOURCE_UNAVAILABLE');
  apply({status:'stale',refreshFailed:false,error:null,periods:{daily:{...daily,bars:'same'}}});
  assert.equal(store.getSeries('daily30'),bars);assert.equal(store.getMeta('daily30').status,'ready');
  assert.equal(store.getMeta('daily30').meta.stale,false);assert.equal(store.getMeta('daily30').errorCode,null);assert.equal(store.getMeta('daily30').retryAt,null);
});

test('legacy aggregate error is not proof of a whole refresh failure and own period errors survive',()=>{
  const {apply,store}=setup();
  apply({status:'error',error:'OTHER_PERIOD_FAILED',retryAt:at+60000,periods:{daily:value('daily'),
    weekly:value('weekly',{status:'error',stale:true,errorCode:'WEEKLY_UNAVAILABLE',retryAt:at+5000,bars:[]})}});
  assert.equal(store.getMeta('daily30').status,'ready');assert.equal(store.getMeta('daily30').errorCode,null);
  assert.equal(store.getMeta('weekly').status,'error');assert.equal(store.getMeta('weekly').errorCode,'WEEKLY_UNAVAILABLE');
  assert.equal(store.getMeta('weekly').retryAt,at+5000);assert.equal(store.getMeta('monthly').status,'unknown');
});

test('refreshing indicator does not change each period freshness or source timestamp',()=>{
  const {apply,store}=setup();
  apply({status:'refreshing',refreshFailed:false,periods:{daily:value('daily'),weekly:value('weekly',{status:'stale',stale:true,sourceCheckedAt:at-600000})}});
  assert.equal(store.getMeta('daily30').status,'ready');assert.equal(store.getMeta('daily30').meta.refreshing,true);
  assert.equal(store.getMeta('weekly').status,'stale');assert.equal(store.getMeta('weekly').meta.refreshing,true);
  assert.equal(store.getMeta('weekly').meta.sourceCheckedAt,at-600000);
});
