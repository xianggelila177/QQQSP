import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Element,tape,trade} from './detail-ux-fixture.mjs';

const load=(name,context)=>vm.runInNewContext(readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),context);

test('T23 market model works without DOM/chart/history and owns deduplication, epochs and cancellation',async()=>{
  const context={window:{},AbortController,Date},pending=[],updates=[];load('panel-market-detail-model',context);
  const network={request:(key,url,options)=>new Promise(resolve=>pending.push({key,url,...options,resolve}))};
  const model=context.window.PANEL_MARKET_DETAIL_MODEL.createMarketDetailModel({network,onChange:(value,error)=>updates.push({value,error})});
  const first=model.read({symbol:'NVDA'});assert.equal(model.read({symbol:'NVDA'}),first);assert.equal(pending.length,1);
  const second=model.read({symbol:'AAPL'});assert.equal(pending[0].signal.aborted,true);
  pending[0].resolve({ok:true,json:async()=>({symbol:'NVDA',range:'1d'})});await first;assert.equal(updates.length,0);
  pending[1].resolve({ok:true,json:async()=>({symbol:'AAPL',range:'1d',tape:{events:[]}})});await second;assert.equal(updates[0].value.symbol,'AAPL');
  const third=model.read({symbol:'AAPL'});model.cancel();assert.equal(pending[2].signal.aborted,true);
  pending[2].resolve({ok:true,json:async()=>({symbol:'AAPL',range:'1d'})});await third;assert.equal(updates.length,1);
});

test('T23 market view renders exact units and window stats without canvas/history/network globals',()=>{
  const context={window:{},Intl,Date};for(const name of ['panel-format','panel-trade-direction','panel-market-detail-view'])load(name,context);
  const root=new Element(),document={createElement:tag=>new Element(tag)};
  const view=context.window.PANEL_MARKET_DETAIL_VIEW.createMarketDetailView({document,root});
  const options={symbol:'NVDA',session:'post',zone:'America/New_York',money:v=>'$'+v,formatKey:'USD'};
  view.render({tape:tape([{...trade,size:1001},{...trade,at:trade.at+1000,size:.125}])},options);
  const table=root.querySelector('.cd-tape-list').children[0];assert.match(table.textContent,/1,001 股/);
  assert.match(root.querySelector('.cd-tape-stats').textContent,/1,001.125 股/);
  view.render({tape:tape([{...trade,size:1001},{...trade,at:trade.at+1000,size:.125}])},options);
  assert.equal(root.querySelector('.cd-tape-list').children[0],table);
  view.render({tape:tape([{...trade,size:1,sizeUnit:'contracts'},{...trade,at:trade.at+1000,size:1,sizeUnit:'shares'}])},options);
  assert.match(root.querySelector('.cd-tape-stats').textContent,/数量单位不同，不合计/);
});

test('T23 dialog owns back navigation, focus and scroll cleanup without market state',()=>{
  const listeners=new Map(),opener=new Element('button'),dialog=new Element('dialog'),document={body:new Element('body'),activeElement:opener};
  document.body.style.overflow='scroll';let pushes=0,backs=0,pops=0;
  const window={addEventListener:(event,fn)=>listeners.set(event,fn),removeEventListener:event=>listeners.delete(event)};
  load('panel-detail-dialog',{window,document,history:{pushState:()=>pushes++,back:()=>backs++},location:{href:'https://panel.test/'}});
  const modal=window.PANEL_DETAIL_DIALOG.createDetailDialog({document,window,onBack:()=>{pops++;modal.close(true);}});
  modal.open(dialog,opener);assert.equal(dialog.open,true);assert.equal(document.body.style.overflow,'hidden');
  listeners.get('popstate')();assert.equal(pops,1);assert.equal(backs,0);assert.equal(dialog.open,false);assert.equal(opener.focused,true);assert.equal(document.body.style.overflow,'scroll');
  modal.open(dialog,opener);modal.close();assert.equal(pushes,2);assert.equal(backs,1);assert.equal(listeners.size,0);
});
