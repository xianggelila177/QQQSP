import {transmissionAssessment} from './macro-transmission.js';
import {macroRegion,regionNames,isInflationSurvey,surveyReadings,surveyKey} from './macro-semantics.js';
// Deterministic, asset-relative reading aids. Never a return predictor or a fund-flow detector.
const DAY=864e5;
const OIL=/原油|油价|石油|OPEC|\bWTI\b|\bBrent\b|\bcrude\b|\boil\b/i;
const INFLATION=/CPI|PCE|通胀|消费者价格|consumer price|inflation/i;
const RATES=/美债|国债收益率|美联储|鲍威尔|\bFed\b|FOMC|Powell|Treasury|interest rates?/i;
const MAYBE=/可能|预计|预料|传闻|据悉|考虑|或将|有望|将于|尚未|否认|没有|不会|(?:并)?未(?:曾|再|有|宣布)?(?:减产|增产|恢复|中断)|\b(may|might|could|denies|denied|rumou?r|consider|preview|forecast to|expected to)\b/i;
const OFFICIAL_HOSTS=new Set(['bls.gov','www.bls.gov','eia.gov','www.eia.gov','bea.gov','www.bea.gov','apps.bea.gov','federalreserve.gov','www.federalreserve.gov','ecb.europa.eu','www.ecb.europa.eu']);
const plain=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const num=String.raw`([+-]?\d+(?:\.\d+)?)\s*%`;
const monthPattern=/(?:\d{4}年)?(?:1[0-2]|[1-9])月|January|February|March|April|May|June|July|August|September|October|November|December/i;
const US=/(?:美国|\bU\.?S\.?\b|United States)/i;
const notUS=/中国|英国|欧元区|日本|韩国|\bChina\b|\bUK\b|Eurozone|\bJapan\b/i;
function official(item){try{return item.official===true&&OFFICIAL_HOSTS.has(new URL(item.link).hostname);}catch{return false;}}
function impact(target,direction,rationale){return {target,direction,label:({positive:'条件偏利多',negative:'条件偏利空',mixed:'影响分歧',unknown:'待验证'})[direction],rationale};}
function reference(text){return text.match(monthPattern)?.[0]||null;}
// Only explicit percentage rates with a named month and an actual/consensus pair.
// Separate metric spans before parsing: core/headline and MoM/YoY must not leak into one another.
export function extractInflationRelease(value){
 const text=plain(value).slice(0,2200);if(!US.test(text)||notUS.test(text)||MAYBE.test(text))return [];
 const metrics=[...text.matchAll(/(?:核心\s*|core\s+)?(?:CPI|PCE)\s*(?:月率|年率|同比|环比|MoM|YoY|month.over.month|year.over.year)/gi)];
 const releases=[];
 for(let i=0;i<metrics.length;i++){
  const m=metrics[i],before=text.slice(i?metrics[i-1].index+metrics[i-1][0].length:0,m.index),ref=reference(before)||reference(text.slice(0,m.index));
  if(!ref)continue;
  const tail=text.slice(m.index+m[0].length,metrics[i+1]?.index??text.length).split(/[；;。]/)[0];
  const actual=tail.match(new RegExp(String.raw`^\s*[:：,，]?\s*(?:(?:实际(?:公布)?|公布值?|录得|actual(?:ly)?)\s*[:：=]?\s*)?${num}`,'i'));
  const expected=tail.match(new RegExp(String.raw`(?:预期|市场预期|consensus|expected|forecast)\s*[:：=]?\s*${num}`,'i'));
  if(!actual||!expected)continue;
  const actualValue=Number(actual[1]),forecastValue=Number(expected[1]);
  if(Math.abs(actualValue)>100||Math.abs(forecastValue)>100)continue;
  const previous=tail.match(new RegExp(String.raw`(?:前值|previous|prior)\s*[:：=]?\s*${num}`,'i'));
  const metric=m[0].toUpperCase().includes('PCE')?'PCE':'CPI',core=/核心|core/i.test(m[0]);
  const period=/月率|环比|MoM|month.over.month/i.test(m[0])?'mom':'yoy';
  releases.push({metric,core,period,reference:ref,unit:'%',actual:actualValue,consensus:forecastValue,previous:previous?Number(previous[1]):null,
   surprise:Math.round((actualValue-forecastValue)*10000)/10000,consensusStatus:'reported-not-point-in-time-verified',seasonalAdjustment:'not-verified'});
 }
 return releases;
}
export function assessMacro(item,now=Date.now()){
 const title=plain(item.title),excerpt=plain(item.sourceText).slice(0,1800),text=title+(excerpt?' '+excerpt:'');
 const publishedAt=Number.isFinite(item.t)?item.t:null,age=publishedAt===null?Infinity:now-publishedAt;
 const x={schemaVersion:1,ruleVersion:'macro-transmission-3',event:'background',status:'watch',importance:'background',scope:excerpt?'feed-excerpt':'title',evidenceTier:official(item)?'official':'reported',
  publishedAt,region:macroRegion(text+' '+(item.official?item.src||'':'')),relevance:'background',topic:OIL.test(text)?'原油':INFLATION.test(text)?'通胀':RATES.test(text)?'利率':'其他',summary:'没有足够的事件数据支持方向判断。',
  facts:[],releases:[],impacts:[impact('纳指100','unknown','新闻情绪不等于指数收益。')],conditions:[],counterEvidence:[],missing:[],horizon:'事件后观察，不是买卖指令'};
 if(OIL.test(text)||INFLATION.test(text)||RATES.test(text))x.importance='watch';
 if(age<0||age>2*DAY){x.status='background';x.summary=age<0?'发布时间在未来，不能作为已发生事件。':'历史背景资料，不计入当前方向判断。';x.missing.push(publishedAt===null?'缺少可靠发布时间':'需要当前事件及同步价格');return x;}
 x.facts.push({label:x.scope==='title'?'来源标题':'来源标题及订阅摘要',value:title.slice(0,240),kind:'reported'});
 if(isInflationSurvey(text)){
  x.event='inflation-expectations-survey';x.surveyReadings=surveyReadings(text);x.relevance=x.region==='US'?'indirect':'regional';
  x.importance=x.region==='US'?'watch':'background';x.status='context';
  const region=regionNames[x.region],target=x.region==='US'?'美国利率预期':region+'通胀与利率';
  x.summary=region+'公众通胀预期调查，不是CPI实际发布，也不是经济学家对CPI的一致预期。';
  x.impacts=[impact(target,'unknown','受访者预期只反映该地区的调查结果；没有同一调查前值或政策反应，不判定资产方向。')];
  for(const r of x.surveyReadings)x.facts.push({label:region+'受访者 '+r.horizon+'通胀预期',value:r.value+'%',kind:'survey-reading'});
  x.conditions.push('比较同一调查机构、相同样本方法和相同期限的历史值');
  x.counterEvidence.push('不同国家、期限及调查方法不能直接比较，调查预期不等于已实现物价变化');
  x.missing.push('相同调查口径的前值及变化幅度');
  if(x.region!=='US')x.missing.push('尚无直接关联美国通胀或纳指的事件证据');
  return x;
 }
 if(INFLATION.test(text)&&!OIL.test(text)&&!['US','UNKNOWN','MULTI'].includes(x.region)){
  const region=regionNames[x.region];x.event='regional-inflation';x.importance='background';x.relevance='regional';x.status='context';
  x.summary=region+'通胀相关信息，保留地区口径，不套用美国CPI或纳指方向规则。';
  x.impacts=[impact(region+'利率与本地资产','unknown','需要当地实际值、当地预期与政策反应；不能直接推导纳指方向。')];
  x.missing.push('本地同口径的实际值和预期、可追溯的跨市场传导证据');return x;
 }

 const rotation=OIL.test(text)&&/资金|funds?|capital|profit.taking|获利了结|获利了解/i.test(text)&&/纳指|Nasdaq|CPI|轮动|rotat/i.test(text);
 if(rotation){
  x.event='rotation-hypothesis';x.summary='资金从原油流向纳指的解释尚未证实，价格反向变化只能提示待验证假设。';
  x.missing.push('同一时间窗口的资金流或交易持仓证据；价格和成交量不足以证明资金转移','CPI实际值与发布前一致预期');
  x.conditions.push('先核对油价与纳指的同步价格，再核对利率反应和新闻时间顺序');
  x.counterEvidence.push('油价可能反映供给改善或需求恶化；纳指也可能受独立公司消息影响');return x;
 }
 const channels=transmissionAssessment(item,text,x.region);
 if(channels&&!extractInflationRelease(text).length){
  Object.assign(x,channels);
  for(const signal of channels.signals||[])x.facts.push({label:({reported:'报道的事件／市场反应','reported-expectations':'报道的预期变化',opinion:'作者观点',scenario:'未落地情景'})[signal.basis],value:signal.evidence,kind:signal.basis});
  return x;
 }
 if(INFLATION.test(text)){
  x.event='inflation-watch';x.releases=extractInflationRelease(text);
  // Identical title + excerpt repetitions are not additional measurements.
  x.releases=x.releases.filter((r,i,all)=>all.findIndex(q=>JSON.stringify(q)===JSON.stringify(r))===i);
  if(x.releases.length){
   x.event='inflation-surprise';x.importance='focus';x.relevance='direct';
   const signs=new Set(x.releases.map(r=>Math.sign(r.surprise)));
   const direction=signs.has(1)&&signs.has(-1)?'mixed':signs.has(1)?'negative':signs.has(-1)?'positive':'unknown';
   x.impacts=[impact('纳指100',direction,direction==='mixed'?'不同通胀分项的实际值相对预期方向不一致。':direction==='positive'?'报道通胀低于报道预期，若利率预期同步下移且增长未显著恶化，估值压力可能减轻。':direction==='negative'?'报道通胀高于报道预期，若利率预期同步上移，成长股估值可能承压。':'符合报道预期不构成新的方向优势。')];
   x.summary=direction==='mixed'?'通胀分项意外方向分歧，不能合并为一个利多标签。':'已提取同口径实际值与报道预期；方向仅为条件推断。';
   for(const r of x.releases)x.facts.push({label:`${r.reference} ${r.core?'核心':''}${r.metric} ${r.period==='mom'?'月率':'年率'}`,value:`实际 ${r.actual}% / 报道预期 ${r.consensus}% / 意外 ${r.surprise>0?'+':''}${r.surprise} 个百分点`,kind:'reported-comparison'});
   x.missing.push('报道预期是否为发布前冻结的一致预期尚未核验','需核对季调、修订值及官方原表');
   x.conditions.push('核对发布后美债收益率、美元和纳指是否在同一窗口响应，不能用当前快照冒充事件反应');
   x.counterEvidence.push('市场可能已提前定价；核心与总指数分歧、增长冲击可抵消利率传导');
  }else{
   x.summary='通胀相关消息：未取得可比较的美国同月、同分项实际值与一致预期。';
   x.missing.push('需要美国、参考月份、核心或总指数、月率或年率、单位，以及实际值和发布前预期');
   x.counterEvidence.push('“低于前值”不等于“低于预期”；当前油价下跌不能改写已公布月份的CPI');
  }
  if(!OIL.test(text))return x;
 }
 if(OIL.test(text)){
  if(MAYBE.test(text)){x.event='oil-unconfirmed';x.summary='原油相关预测、否认或传闻，暂不按已发生供需冲击判断。';x.missing.push('实际供需变化及可追溯的确认消息');return x;}
  const demandLoss=/需求.{0,15}(下降|下滑|疲软|萎缩|减弱|恶化)|衰退|demand.{0,25}(weak|fall|declin|slow)|recession/i.test(text);
  const loss=/减产|供应中断|供给中断|停产|production cuts?|supply disruption|output cuts?/i.test(text);
  const gain=/增产|供应恢复|供给恢复|产量增加|生产恢复|restor.{0,20}(supply|production)|supply.{0,20}(recover|restor)|production increase|output increase/i.test(text);
  if(demandLoss){x.event='oil-demand-loss';x.impacts=[impact('纳指100','mixed','能源成本下降与增长、盈利担忧可能相互抵消。'),impact('原油','negative','若需求走弱得到确认且未被供给收缩抵消，油价承压。')];x.summary='需求恶化型油价压力，不能简单解释为科技股利多。';}
  else if(loss&&!gain){x.event='oil-supply-loss';x.impacts=[impact('纳指100','negative','若供给收缩推高持续能源成本和利率预期，估值与利润率可能承压。'),impact('原油','positive','若减产形成实际供应缺口，原油价格可能受支撑。')];x.summary='供给收缩事件：对原油和纳指的条件影响方向不同。';}
  else if(gain&&!loss){x.event='oil-supply-gain';x.impacts=[impact('纳指100','positive','若需求稳定，能源成本缓和可能减轻通胀与利率压力。'),impact('原油','negative','若新增供给落地且未被需求增长抵消，原油价格可能承压。')];x.summary='供给改善事件：观察是否转化为能源成本和利率缓和。';}
  else{x.event='oil-watch';x.summary='原油价格或库存消息，缺少足以判定供需冲击与纳指方向的证据。';x.missing.push('供给还是需求驱动、库存实际值与预期、炼厂开工及进口变化');}
  if(['oil-demand-loss','oil-supply-loss','oil-supply-gain'].includes(x.event)){x.importance='focus';x.relevance='indirect';}
  x.conditions.push('核对布伦特与WTI、原油供需事实及利率；传导通常不是即时一比一关系');
  x.counterEvidence.push('原油影响总体通胀的能源项，不直接等同于核心CPI；需求、汇率和政策反应可能抵消');
  x.missing.push('尚未确认事件意外程度及市场是否已经定价');return x;
 }
 if(RATES.test(text)){x.event='rates-watch';x.summary='利率或政策相关消息：先核对决定相对预期的差异，不能仅凭“降息”判定利多。';x.conditions.push('区分预防性宽松与衰退应对；核对美债和美元的实际反应');x.missing.push('决定、发布前预期、经济动机和事件时间');}
 return x;
}
function canonicalLink(value){try{const u=new URL(value);if(!/^https?:$/.test(u.protocol))return '';for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.hash='';return u.href;}catch{return '';}}
export function mergeMacroItems(items){
 const out=[],links=new Map(),titles=new Map(),surveys=new Map();
 for(const item of items){
  const link=canonicalLink(item.link),identityLink=item.linkScope==='feed'?'':link,title=plain(item.title).toLowerCase(),day=Number.isFinite(item.t)?Math.floor(item.t/DAY):'unknown',key=day+'|'+title;
  const group=surveyKey(item),old=(group&&surveys.get(group))||(identityLink&&links.get(identityLink))||titles.get(key);
  const report={src:item.src||'未知来源',link,publishedAt:item.t};
  if(old){if(group){old.groupFragments=[...new Set([...(old.groupFragments||[old.sourceText||old.title]),...(item.groupFragments||[item.sourceText||item.title])])].slice(0,8);old.groupedCount=old.groupFragments.length;old.sourceText=old.groupFragments.join('。').slice(0,1800);old.t=Math.max(old.t,item.t);}if(!old.reports.some(r=>r.link===link&&r.src===report.src))old.reports.push(report);if(item.official&&!old.official){Object.assign(old,item,{reports:old.reports});}if(identityLink)links.set(identityLink,old);continue;}
  const row={...item,reports:item.reports||[report],...(group?{groupFragments:item.groupFragments||[item.sourceText||item.title],groupedCount:item.groupFragments?.length||1}:{}),independentConfirmations:null};out.push(row);if(identityLink)links.set(identityLink,row);titles.set(key,row);if(group)surveys.set(group,row);
 }
 return out;
}
