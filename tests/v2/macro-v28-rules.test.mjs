import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMacro} from '../../lib/macro-analysis.js';
const now=Date.parse('2026-09-11T15:10:00Z');
const assess=title=>assessMacro({title,t:now-60000,src:'截图回归样本',topic:'宏观'},now);
const direction=(a,target)=>a.impacts.find(i=>i.target===target)?.direction;
const cases=[
 ['美国核心通胀数据高于预期，交易员加大对美联储加息的押注，利率互换显示下周加息概率升至90%。','纳指100','negative','repricing'],
 ['U.S. Stocks Rise, Treasury Yields Slip Despite Stubborn Inflation','纳指100','positive','yield'],
 ['Treasury yields soar to almost 5% on inflation fears','美债价格','negative','yield'],
 ['Crude Oil Raises Inflation Concerns as Treasury Yields Weigh on Stocks','纳指100','negative','yield'],
 ['US inflation continues to rise as Fed considers rate hike following August price surge','纳指100','negative','policy'],
 ['August inflation data demands rate hikes from the Fed','纳指100','negative','policy'],
 ['Inflation stayed hot in August with annual pace of 3.4%, raising the odds of a Fed hike','纳指100','negative','repricing'],
 ['Gold Rebounds as US Inflation Data Cools Record-High Real Rates','黄金','positive','yield'],
 ['Oil Soars Past $100 as Saudi Output Crashes to Lowest Since 1990','原油','positive','supply'],
 ['美国国债收益率下降，美元走弱','纳指100','positive','yield'],
 ['Fed hike odds fell to 20% after US data','纳指100','positive','repricing'],
 ['市场调低美联储降息概率，美元走强','纳指100','negative','repricing'],
];
for(const [title,target,expected,channel] of cases)test('v28 screenshot: '+title,()=>{
 const a=assess(title);assert.equal(direction(a,target),expected);assert.ok(a.signals?.some(s=>s.id.includes(channel)),JSON.stringify(a));
 assert.ok(!a.summary.includes('未取得可比较的美国同月'));assert.ok(a.facts.length);assert.ok(a.conditions.length);
});
test('forecast and rate commentary stay conditional, never a completed decision or 90% return chance',()=>{
 const a=assess('Fed considers rate hike after hot inflation');assert.equal(a.status,'scenario');assert.ok(a.impacts.every(i=>i.label.includes('情景')));
 const b=assess('加息概率升至90%，交易员加大对美联储加息的押注');assert.ok(b.signals.some(s=>s.basis==='reported-expectations'));assert.ok(!JSON.stringify(b).includes('胜率90'));
});
test('gold technical headline and ahead-CPI preview are not generic Nasdaq inflation releases',()=>{
 for(const title of ['Gold Price Forecast: Bulls Defend 200-Day EMA After Hot CPI','Gold opens at lowest level in a month ahead of CPI data']){
  const a=assess(title);assert.equal(a.impacts[0].target,'黄金');assert.ok(a.summary.includes('技术')||a.summary.includes('发布前'));assert.equal(a.releases.length,0);
 }
});
test('plain CPI level without consensus remains unknown, not invented surprise',()=>{
 const a=assess('U.S. CPI rose 0.4% in August 2026, annual inflation at 3.4%');assert.equal(a.releases.length,0);assert.equal(direction(a,'纳指100'),'unknown');
});
test('generic official ECB publication is regional, not Nasdaq',()=>{
 const a=assessMacro({title:'Monetary policy decisions',src:'ECB',topic:'官方公告',official:true,link:'https://www.ecb.europa.eu/press/pr/date/2026/html/test.html',t:now-60000},now);
 assert.ok(a.impacts.every(x=>x.target!=='纳指100'));assert.equal(a.region,'EU');
});
test('negated yield and supply events cannot create a directional shock',()=>{
 for(const title of ['US Treasury yields did not rise after CPI','Oil output did not fall in Saudi Arabia','OPEC否认减产，原油供应并未中断']){
  const a=assess(title);assert.ok(a.impacts.every(x=>x.direction==='unknown'),title+JSON.stringify(a.impacts));
 }
});
test('conflicting channels produce mixed impact without summing made-up probabilities',()=>{
 const a=assess('美联储加息概率升至90%，但美债收益率下跌');assert.equal(direction(a,'纳指100'),'mixed');assert.ok(a.signals.length>=2);
});
test('diesel refining proposal is not actual crude production growth',()=>{
 const a=assess('美国官员称柴油价格是大关切，希望提高国内炼油能力，炼油地区受到冲突影响');assert.ok(a.impacts.some(x=>x.target==='成品油'));assert.ok(a.event!=='oil-supply-gain');
});
test('explicit comparable US inflation release retains priority',()=>{
 const a=assess('美国8月核心CPI月率0.3%，预期0.2%，前值0.2%。');assert.equal(a.event,'inflation-surprise');assert.equal(direction(a,'纳指100'),'negative');
});
