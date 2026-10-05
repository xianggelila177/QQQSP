import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const code=fs.readFileSync(new URL('../../public/modules/panel-chart-workspace.js',import.meta.url),'utf8');
function fixture(initial){
  const storage=new Map(initial?[['qqqsp:chart-workspace:v1',initial]]:[]),events={};
  const window={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},addEventListener:(type,fn)=>events[type]=fn};
  vm.runInNewContext(code,{window});return {api:window.PANEL_CHART_WORKSPACE,window,storage,events};
}
function container(){
  const inputs=[{dataset:{chartSetting:'scale'},value:''},{dataset:{chartSetting:'volume'},checked:false},{dataset:{chartStudy:'rsi14'},checked:false}],events={};
  return {inputs,events,querySelectorAll:selector=>inputs.filter(input=>selector==='[data-chart-setting]'?input.dataset.chartSetting:input.dataset.chartStudy),addEventListener:(type,fn)=>events[type]=fn,removeEventListener:type=>delete events[type]};
}
test('chart settings validate corrupted storage and unknown fields without changing defaults',()=>{
  const {api}=fixture('{invalid');assert.equal(api.loadSettings().scale,'linear');
  const result=api.normalizeSettings({scale:'log',volume:'false',studies:{sma5:false,rsi14:true,execute:true}});
  assert.equal(result.scale,'log');assert.equal(result.volume,true);assert.equal(result.studies.sma5,false);assert.equal(result.studies.rsi14,true);assert.equal(result.studies.execute,undefined);
  result.studies.sma10=false;assert.equal(api.loadSettings().studies.sma10,true);
});
test('changing a bound control persists and updates other mounted charts once; teardown unsubscribes',()=>{
  const {api,storage}=fixture(),a=container(),b=container();let first=0,second=0;
  const one=api.bindSettings(a,{onChange:()=>first++}),two=api.bindSettings(b,{onChange:()=>second++});
  a.inputs[2].checked=true;a.events.change({target:a.inputs[2]});
  assert.equal(b.inputs[2].checked,true);assert.equal(first,1);assert.equal(second,1);
  assert.equal(JSON.parse(storage.get('qqqsp:chart-workspace:v1')).settings.studies.rsi14,true);
  two.destroy();a.inputs[0].value='percent';a.events.change({target:a.inputs[0]});
  assert.equal(first,2);assert.equal(second,1);assert.equal(api.loadSettings().scale,'percent');one.destroy();
});
test('blocked persistence retains usable in-session preferences',()=>{
  const {api,window}=fixture();Object.defineProperty(window,'localStorage',{get(){throw Error('blocked');}});
  api.saveSettings({scale:'log',volume:false});assert.equal(api.loadSettings().scale,'log');assert.equal(api.loadSettings().volume,false);
});
test('readable old settings cannot replace an unsaved preference after quota failure',()=>{
  const {api,window,storage,events}=fixture(JSON.stringify({version:1,settings:{scale:'linear'}}));
  window.localStorage.setItem=()=>{throw Error('quota exceeded');};
  api.saveSettings({scale:'log',volume:false,studies:{rsi14:true}});
  const next=container();api.bindSettings(next);
  assert.equal(next.inputs[0].value,'log');assert.equal(next.inputs[1].checked,false);assert.equal(next.inputs[2].checked,true);
  storage.set('qqqsp:chart-workspace:v1',JSON.stringify({version:1,settings:{scale:'percent'}}));
  events.storage({key:'qqqsp:chart-workspace:v1',newValue:storage.get('qqqsp:chart-workspace:v1')});
  assert.equal(next.inputs[0].value,'percent');
});
test('study readout uses the selected historical offset and preserves warmup and zero values',()=>{
  const {api}=fixture(),p={a:1,studies:{sma5:[null,0,10],ema20:[null,null,11],rsi14:[null,0,100],boll20:{upper:[null,2,12],middle:[null,1,11],lower:[null,0,10]}}};
  const text=api.studyReadout(p,0,value=>'$'+value);assert.match(text,/MA5 \$0/);assert.match(text,/EMA20 —/);assert.match(text,/RSI14 0.00/);assert.match(text,/下 \$0/);
  assert.match(api.studyReadout(p,1),/EMA20 11/);assert.match(api.studyReadout(p,2),/RSI14 —/);
});
