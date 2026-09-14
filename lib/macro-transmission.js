// Asset-relative transmission channels, not a sentiment score or trading model.
// Each match keeps the text span and its epistemic type: report / expectations / opinion / scenario.
const UP='positive',DOWN='negative',UNKNOWN='unknown';
const GOLD=/黄金|金价|\bgold\b/i;
const OIL=/原油|油价|石油|OPEC|\boil\b|\bcrude\b|Brent|WTI/i;
const US=/美国|美联储|美债|\bU\.?S\.?\b|\bFed\b|FOMC|Treasur(?:y|ies)|United States/i;
const NEGATED=/并未|没有|不会|否认|未发生|未曾|\b(?:not|never|denies|denied|no longer)\b/i;
const HYPOTHETICAL=/可能|或将|有望|考虑|希望|呼吁|应当|应该|预计|传闻|\b(?:may|might|could|considers?|expected|rumou?r|hopes?|should)\b/i;
const OPINION=/认为|主张|呼吁|应当|应该|\b(?:demands?|justifies?|should|calls? for)\b/i;
const labels={positive:'条件偏利多',negative:'条件偏利空',mixed:'影响分歧',unknown:'待验证'};
const impact=(target,direction,rationale)=>({target,direction,label:labels[direction],rationale});
const opposite=d=>d===UP?DOWN:d===DOWN?UP:UNKNOWN;
const policyImpacts=tight=>[
 impact('纳指100',tight?DOWN:UP,tight?'更高预期利率可能提高折现率，成长股估值受压。':'预期利率下移可能缓和折现压力，但需排除增长或盈利恶化。'),
 impact('美债价格',tight?DOWN:UP,'对固定现金流债券，收益率与价格方向相反；实际幅度取决于期限和风险溢价。'),
 impact('黄金',tight?DOWN:UP,'黄金的利率渠道取决于实际收益率与美元；名义政策预期不是唯一驱动。'),
 impact('美元',tight?UP:DOWN,'仅在美国相对其他经济体的预期利差同向变化时成立。')
];
function clauses(text){return text.split(/[。；;！？!?]|(?<!\d)\.(?!\d)/).filter(Boolean);}
function evidence(text,re){
 for(const clause of clauses(text)){
  const m=clause.match(re);if(!m)continue;
  // Negation is scoped to this clause; an unrelated "not" in another sentence is not a veto.
  const near=clause.slice(Math.max(0,m.index-20),m.index+m[0].length);
  if(!NEGATED.test(near))return {text:clause.trim().slice(0,300),match:m[0],basis:OPINION.test(clause)?'opinion':HYPOTHETICAL.test(near)?'scenario':'reported'};
 }
 return null;
}
function combine(signals){
 const targets=new Map();
 for(const s of signals)for(const i of s.impacts){const arr=targets.get(i.target)||[];arr.push(i);targets.set(i.target,arr);}
 return [...targets].sort(([a],[b])=>(a==='纳指100'?-1:b==='纳指100'?1:0)).map(([target,items])=>{
  const signs=new Set(items.map(i=>i.direction).filter(d=>d!==UNKNOWN));
  const d=signs.has('mixed')||signs.size>1?'mixed':[...signs][0]||UNKNOWN;
  return impact(target,d,[...new Set(items.map(i=>i.rationale))].join(' '));
 });
}
export function transmissionAssessment(item,text,region){
 const signals=[];
 const add=(id,match,impacts,conditions,counterEvidence)=>{if(match)signals.push({id,evidence:match.text,basis:match.basis,impacts,conditions,counterEvidence});};
 // A forecast/technical support level is not a newly observed macro shock.
 if(GOLD.test(text)&&/\b(?:EMA|moving average|support|resistance|bulls defend|technical)\b|均线|支撑位|阻力位/i.test(text))return {
  event:'gold-technical',status:'context',topic:'黄金',summary:'黄金技术分析或价格预测，不等于宏观冲击；保留技术对象，不据此给纳指贴方向标签。',
  impacts:[impact('黄金',UNKNOWN,'均线或支撑位本身不能证明后续涨跌。')],signals:[],conditions:['核对实际价格、失效位置和作者所述条件'],missing:['缺少可验证的宏观增量证据']
 };
 if(GOLD.test(text)&&/ahead of (?:the )?CPI|before (?:the )?CPI|CPI.{0,8}(发布前|公布前)|CPI发布前/i.test(text))return {
  event:'gold-event-preview',status:'context',topic:'黄金',summary:'CPI发布前的黄金价格背景，不包含实际值相对预期的新增冲击。',impacts:[impact('黄金',UNKNOWN,'已经发生的开盘高低点不是数据发布后的方向预测。')],signals:[],conditions:['等待数据发布，再核对实际利率与美元反应'],missing:['发布后的同口径实际值和预期']
 };
 if(/柴油|汽油|成品油|炼油|炼厂|diesel|gasoline|refin(?:ing|er)/i.test(text)&&!/原油产量|crude (?:oil )?(?:output|production)/i.test(text)){
  const m=evidence(text,/炼油.{0,35}(?:冲突|中断|产能|能力)|柴油.{0,25}(?:问题|关切|上涨)|refin.{0,30}(?:disrupt|capacity)|diesel.{0,25}(?:concern|surge)/i);
  add('refining-constraint',m,[impact('成品油',UP,'炼油瓶颈若持续，成品油供应及裂解价差可能承压；拟扩产不等于已投产。'),impact('原油','mixed','炼厂受阻可能降低原油加工需求，不能等同于原油供给下降。')],['确认炼厂实际停工、利用率与修复进展'],['扩建意向尚未形成新增供应；需求下降可能抵消产品端紧缺']);
 }
 if(US.test(text)&&!['UK','EU','CN','JP','KR'].includes(region)){
  const hikeUp=evidence(text,/(?:加息(?:的)?(?:概率|几率|押注|预期).{0,25}(?:升|增加|提高|加大)|(?:加大|增加|上调).{0,20}加息(?:的)?(?:押注|预期|概率)|hike odds.{0,24}(?:jump|ris|rose|surge|climb)|(?:raising|increas\w*|boost\w*).{0,18}(?:odds|bets).{0,18}(?:Fed )?hike|(?:odds|bets).{0,20}(?:hike).{0,20}(?:jump|ris|surge))/i);
  const hikeDown=evidence(text,/(?:加息(?:的)?(?:概率|押注|预期).{0,20}(?:降|减少|回落)|(?:降低|调低|减少).{0,12}加息(?:的)?(?:概率|预期)|hike odds.{0,18}(?:fell|fall|slip|declin)|(?:odds|bets).{0,16}(?:hike).{0,18}(?:fell|fall|declin))/i);
  const cutDown=evidence(text,/(?:调低|降低|减少|下调).{0,12}降息(?:的)?(?:概率|押注|预期)|降息(?:的)?(?:概率|押注|预期).{0,18}(?:降|减少|回落)|cut odds.{0,18}(?:fell|fall|slip|declin)/i);
  const cutUp=evidence(text,/(?:加大|增加|上调).{0,12}降息(?:的)?(?:概率|押注|预期)|降息(?:的)?(?:概率|押注|预期).{0,18}(?:升|增加)|cut odds.{0,18}(?:jump|ris|rose|surge|climb)/i);
  for(const [id,m,tight]of [['repricing-hawkish',hikeUp||cutDown,true],['repricing-dovish',hikeDown||cutUp,false]]){
   if(m)m.basis='reported-expectations';
   add(id,m,policyImpacts(tight),['核对同次会议的概率前值、合约时点及是否已被价格反映'],['报道的加息概率不是股价下跌概率；期限溢价、增长和公司信息可能抵消']);
  }
  // Yield direction is directly usable even when no CPI consensus pair is present.
  const yieldUp=evidence(text,/(?:(?:Treasury\s+)?(?:real\s+)?yields?|real\s+rates)\s+(?:(?:have|has|are|were)\s+)?(?:soar\w*|ris\w*|rose|surge\w*|jump\w*|climb\w*|weigh\w*)|(?:美债|国债|实际)?(?:收益率|实际利率).{0,12}(?:上升|走高|上涨|飙升|攀升)/i);
  const yieldDown=evidence(text,/(?:(?:Treasury\s+)?(?:real\s+)?yields?|real\s+rates)\s+(?:(?:have|has|are|were)\s+)?(?:slip\w*|fall\w*|fell|declin\w*|drop\w*|cool\w*)|(?:cools?|lowers?).{0,24}real (?:rates|yields)|(?:美债|国债|实际)?(?:收益率|实际利率).{0,12}(?:下降|走低|下跌|回落)/i);
  for(const [id,m,tight]of [['yield-up',yieldUp,true],['yield-down',yieldDown,false]])add(id,m,
   policyImpacts(tight).filter(i=>i.target!=='美元'),['确认期限、名义或实际收益率，以及新闻所述观察时点；价格已走出的方向不是后续收益承诺'],['增长担忧引起的收益率下降可能同时打压股票；黄金还受美元及避险需求影响']);
  if(!hikeUp&&!hikeDown&&!cutDown&&!cutUp&&!/概率|押注|\bodds\b|probability/i.test(text)){
   const hawk=evidence(text,/(?:Fed|FOMC|美联储).{0,30}(?:rate hikes?|hike|加息)|(?:demands?|justifies?|calls for|raising).{0,20}(?:rate hikes?|Fed hike)|通胀.{0,20}(?:支持|需要)加息/i);
   const dove=evidence(text,/(?:Fed|FOMC|美联储).{0,30}(?:rate cuts?|降息|宽松)/i);
   for(const [id,m,tight]of [['policy-hawkish',hawk,true],['policy-dovish',dove,false]]){
    if(m&&!/决定|宣布|决议|announc|decid|raises|cuts rates/i.test(m.text)&&m.basis==='reported')m.basis='scenario';
    add(id,m,policyImpacts(tight),['区分官方决定、市场预期与作者观点；比较决定相对发布前预期的差异'],['政策若完全在预期内，方向可能已被定价；衰退式降息不保证股票受益']);
   }
  }
 }
 if(OIL.test(text)&&!signals.some(s=>s.id==='refining-constraint')){
  const loss=evidence(text,/output.{0,20}(?:crash\w*|plung\w*|collaps\w*|fell|falls)|production.{0,20}(?:crash\w*|plung\w*|collaps\w*)|(?:产量|供应).{0,15}(?:暴跌|骤降|锐减)/i);
  const gain=evidence(text,/(?:output|production).{0,20}(?:surges?|increases?|recovers?|restored)|(?:产量|供应).{0,15}(?:恢复|增加|激增)/i);
  for(const [id,m,oilDirection]of [['supply-loss-reported',loss,UP],['supply-gain-reported',gain,DOWN]])add(id,m,[
   impact('原油',oilDirection,'若报道的供给变化属实且未被需求及其他产油国抵消，供给减少支撑油价、供给增加压低油价。'),
   impact('纳指100',opposite(oilDirection),'仅在能源成本变化持续并传递到通胀、利润率和利率预期时成立。')
  ],['核对实际产量、涉及规模与恢复期限；不把价格上涨当作供给变化的证据'],['供给消息可能已定价；需求衰退、库存释放及替代供应可抵消']);
 }
 if(signals.length){
  const allScenario=signals.every(s=>s.basis==='scenario'||s.basis==='opinion');
  const impacts=combine(signals);
  if(allScenario)for(const i of impacts)if(i.direction!==UNKNOWN&&i.direction!=='mixed')i.label=(signals.every(s=>s.basis==='opinion')?'观点':'情景')+(i.direction===UP?'偏利多':'偏利空');
  const mixed=impacts.some(i=>i.direction==='mixed');
  return {event:'transmission-channels',status:allScenario?'scenario':'conditional',importance:allScenario||signals.every(s=>s.basis==='reported'&&/yield/.test(s.id))?'watch':'focus',relevance:'indirect',signals,impacts,
   summary:mixed?'已识别相反传导渠道，按资产显示分歧，不将正负词汇加总成胜率。':allScenario?'这是评论或未落地政策情景；给出成立后的资产方向，不冒充已发生决定。':'已识别利率预期、市场反应或供给渠道；不再因缺少CPI数值而丢弃其他有效信息。',
   conditions:[...new Set(signals.flatMap(s=>s.conditions))],counterEvidence:[...new Set(signals.flatMap(s=>s.counterEvidence))],missing:['仅依据当前标题和订阅摘要；需要原始数据或原文确认幅度、时点与是否已定价']};
 }
 if(region==='EU'&&/monetary policy|policy decisions|货币政策|利率决议/i.test(text))return {event:'regional-policy-notice',status:'context',importance:'background',summary:'欧元区政策公告入口；标题未给出决定和预期，不套用美国CPI或纳指方向。',impacts:[impact('欧元及欧元区资产',UNKNOWN,'需读取该次决定的内容和相对预期差异。')],signals:[],conditions:['核对当地政策与预期'],missing:['公告正文中的决定、预期及前值']};
 return null;
}
