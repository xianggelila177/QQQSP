import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('old HTTP/SSE snapshots cannot replace newer macro prices, but a restarted process can publish',()=>{
 const observed=[],events={};const document={hidden:false,getElementById:id=>['macroFactors','macroContextStatus'].includes(id)?{}:null};
 const window={PANEL_FORMAT:{esc:String,fmtTime8:String},PANEL_MACRO_CONTEXT:{createMacroContext:()=>({apply:value=>observed.push(value.factors[0].price)})},EventSource:class{addEventListener(name,fn){events[name]=fn;}},addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-macro-controller.js',import.meta.url),'utf8'),{window,Date,JSON,URL,setTimeout,clearTimeout});
 window.PANEL_MACRO_CONTROLLER.createMacroController({document,network:{},client:{},box:{},filters:{},status:{},retry:{addEventListener(){}},isOpen:()=>false});
 const send=(startedAt,revision,price)=>events.macro({data:JSON.stringify({revision,monitor:{enabled:true,running:true,startedAt},news:{items:[]},context:{factors:[{id:'wti',price}]}})});
 send(1000,10,102);send(1000,9,100);assert.deepEqual(observed,[102]);send(2000,1,103);send(1000,11,101);assert.deepEqual(observed,[102,103]);
});
