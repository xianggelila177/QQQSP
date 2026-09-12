import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMacro,mergeMacroItems} from '../../lib/macro-analysis.js';
import {createMacroContext} from '../../lib/macro-context.js';
import {createApplication} from '../../app.js';
const clock=Date.parse('2026-09-11T08:38:00Z');
const item=title=>({title,sourceText:title,t:clock-60000,src:'新浪7x24',link:'https://finance.sina.com.cn/7x24/',linkScope:'feed'});
const titles=[
 '英国央行表示，8月份Savanta民调显示，受访者对五年后的通胀预期为3.2%。',
 '英国央行表示，Savanta在8月开展的调查显示，受访者对未来1-2年的通胀预期为2.9%。',
 '英国央行表示，8月Savanta民调显示，民众对未来一年的通胀预期为3.2%。'
];
test('截图复现：英国民调不是美国CPI实际发布，也不应贴纳指标签',()=>{
 const a=assessMacro(item(titles[0]),clock);
 assert.equal(a.event,'inflation-expectations-survey');assert.equal(a.region,'UK');
 assert.ok(a.facts.some(f=>f.value.includes('3.2')));assert.ok(a.impacts.every(x=>x.target!=='纳指100'));
 assert.notEqual(a.importance,'focus');assert.ok(!a.summary.includes('美国同月'));
});
test('截图复现：同次民调不同期限归组，保留每个期限而非三条重复占位',()=>{
 const rows=mergeMacroItems(titles.map(item));assert.equal(rows.length,1);
 const a=assessMacro(rows[0],clock);assert.equal(a.surveyReadings.length,3);
 assert.deepEqual(a.surveyReadings.map(x=>x.horizon).sort(),['1-2年','1年','5年']);
});
test('否定复现：未减产、并未恢复供应不能变成已发生供给冲击',()=>{
 for(const title of ['OPEC并未减产原油','原油供应并未恢复']){
  const a=assessMacro(item(title),clock);assert.equal(a.impacts[0].direction,'unknown',title);
 }
});
test('采样复现：来源缺成交时点，应分别提供观察时间和采样进度而非永久提示等15分钟',async()=>{
 let now=clock;const s=createMacroContext({now:()=>now,readQuote:async symbol=>({symbol,price:100,quoteAt:null,sourceCheckedAt:now,src:'directory'})});
 await s.getContext();now+=60000;await s.getContext();
 const d=s.snapshot(),f=d.factors[0];assert.equal(f.quoteAt,null);assert.equal(f.comparisonBasis,'observation');assert.ok(f.observationSamples>=2);
 assert.ok(d.observations.join(' ').includes('观察'));s.close();
});
test('生命周期复现：宏观后台有显式服务，不依赖HTTP展开请求',async()=>{
 const app=createApplication({env:{HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',PORT:0,MACRO_STATE_PATH:'',LOG_FILE:''},upstream:async()=>({status:503,headers:{},body:''})});
 try{assert.equal(typeof app.services.macroMonitor?.start,'function');assert.equal(typeof app.services.macroMonitor?.snapshot,'function');}
 finally{await app.stop();}
});
