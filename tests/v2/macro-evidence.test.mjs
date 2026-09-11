import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMacro,extractInflationRelease,mergeMacroItems} from '../../lib/macro-analysis.js';
const now=Date.parse('2026-09-11T13:00:00Z');
const item=title=>({title,t:now-60000,src:'测试快讯',link:'https://example.com/news'});
const a=title=>assessMacro(item(title),now);
test('CPI surprise requires matching actual and consensus, not previous',()=>{
 const x=a('美国8月核心CPI月率实际0.2%，预期0.3%，前值0.3%');
 assert.equal(x.event,'inflation-surprise');assert.equal(x.releases[0].surprise,-0.1);assert.equal(x.impacts[0].direction,'positive');assert.ok(x.missing.some(s=>s.includes('发布前')));
 assert.equal(a('美国8月核心CPI月率0.2%，前值0.3%').impacts[0].direction,'unknown');
});
test('headline/core and YoY/MoM cannot be mixed into one surprise',()=>{
 const x=a('美国8月CPI年率实际2.4%，预期2.5%；美国8月核心CPI月率实际0.4%，预期0.3%');
 assert.equal(x.releases.length,2);assert.equal(x.impacts[0].direction,'mixed');
 assert.equal(a('美国8月CPI年率实际2.4%；核心CPI月率预期0.3%').event,'inflation-watch');
});
test('forecast, non-US, unrecognised units and missing reference month cannot become release surprises',()=>{
 for(const text of ['预计美国8月CPI月率0.2%，预期0.3%','中国8月CPI月率实际0.2%，预期0.3%','美国8月CPI月率实际20，预期30','美国CPI月率实际0.2%，预期0.3%']) assert.notEqual(a(text).event,'inflation-surprise',text);
});
test('English explicit US CPI release is parsed; predicted values remain pending',()=>{
 assert.equal(extractInflationRelease('US August core CPI MoM actual 0.2%, consensus 0.3%')[0]?.surprise,-0.1);
 assert.equal(extractInflationRelease('US August core CPI MoM expected 0.2%, previous 0.3%').length,0);
});
test('oil supply loss means conditional oil support and Nasdaq pressure, not universal good news',()=>{
 const x=a('OPEC宣布原油减产100万桶/日');assert.equal(x.event,'oil-supply-loss');assert.equal(x.impacts[0].direction,'negative');assert.equal(x.impacts[1].direction,'positive');
});
test('oil supply recovery and demand destruction have different Nasdaq interpretation',()=>{
 assert.equal(a('原油供应恢复，产量增加').impacts[0].direction,'positive');
 const x=a('原油需求下降，全球衰退风险上升');assert.equal(x.event,'oil-demand-loss');assert.notEqual(x.impacts[0].direction,'positive');
});
test('oil price alone and profit-taking narrative cannot establish capital rotation',()=>{
 const x=a('原油下跌，纳指期货上涨，资金获利了结后转去赌CPI');assert.equal(x.event,'rotation-hypothesis');assert.equal(x.impacts[0].direction,'unknown');assert.ok(x.missing.some(s=>s.includes('资金')));
 assert.equal(a('WTI原油下跌2%').impacts[0].direction,'unknown');
});
test('negation and rumours cannot become factual supply shock',()=>{
 for(const text of ['OPEC否认减产传闻','OPEC可能减产原油','OPEC will consider production cuts','OPEC denies oil supply cuts'])assert.equal(a(text).impacts[0].direction,'unknown',text);
});
test('old official announcements are background, official status is not a trading confidence score',()=>{
 const x=assessMacro({...item('OPEC宣布原油减产'),t:now-5*864e5,official:true},now);assert.equal(x.status,'background');assert.equal(x.impacts[0].direction,'unknown');assert.equal(x.confidence,undefined);
});
test('a source name cannot impersonate an official source',()=>{
 assert.notEqual(assessMacro({...item('美国8月CPI月率实际0.2%，预期0.3%'),src:'BLS',official:true},now).evidenceTier,'official');
 assert.equal(assessMacro({...item('CPI release'),link:'https://www.bls.gov/news.release/cpi.nr0.htm',official:true},now).evidenceTier,'official');
});
test('duplicate links and identical syndicated titles count as one event, not independent confirmations',()=>{
 const xs=mergeMacroItems([item('原油供应恢复'),{...item('原油供应恢复'),link:'https://other.test/a',src:'转载'}, {...item('原油供应恢复'),link:'https://example.com/news?utm_source=x'}]);
 assert.equal(xs.length,1);assert.equal(xs[0].reports.length,2);assert.equal(xs[0].independentConfirmations,null);
});
test('evidence records the source text scope without claiming to read full articles',()=>{
 assert.equal(a('原油供应恢复').scope,'title');
 const x=assessMacro({...item('美国通胀数据公布'),sourceText:'美国8月CPI月率实际0.2%，预期0.3%'},now);assert.equal(x.scope,'feed-excerpt');assert.equal(x.event,'inflation-surprise');
});
test('different flashes with the same feed landing URL are not collapsed',()=>{const xs=mergeMacroItems([{...item('原油供应恢复'),linkScope:'feed'},{...item('美国8月CPI月率实际0.2%，预期0.3%'),linkScope:'feed'}]);assert.equal(xs.length,2);});
