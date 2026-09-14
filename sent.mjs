// 情绪打分 v3 —— 三层规则(主题override → 复合短语 → 原子词) + 真否定(跳过) + 商品隔离 + 紧缩语境映射
// 修复 v2 缺陷: ① 负面前缀后仅翻转词根(假否定) ② 词典缺少 hike/cut/通胀等股市语境映射
//              ③ 裸 rise/surge 在债券/商品标题里误判为股市利好 ④ 英文否定窗口过短
const L = (ph, w) => ({ ph, w, len: ph.length });

// ---- 层1: 主题/语境 override —— 命中即决定大方向(紧缩/避险/油供冲击 对股市偏空) ----
const TOPIC_OVERRIDE = [
  // 紧缩信号 → 利空
  [/\brate hikes?\b/i, -2.5], [/\bhike(s)?\s+(in|on)\s+(the\s+)?(cards|table)/i, -2.5],
  [/\bhigher[- ]for[- ]longer\b/i, -2.5], [/\bhawkish\b/i, -1.5],
  [/\binflation (accelerates|spikes|jumps|surges|remains elevated|still elevated|hot|risks?)\b/i, -2],
  [/\binflation\b/i, -1], [/\bhot (cpi|inflation|ppi|jobs)\b/i, -2], [/\byields? (spike|surge|jump|soar|climb)\b/i, -2],
  [/\brate[- ]cut hopes? (fade|dent|dim|ebb|slashed)\b/i, -1.5], [/\bdampen hopes?\b/i, -2],
  [/\bhopes? for (early )?rate cuts?\b/i, 0],                 // 语义由 dampen/rate cut 表达, 不重复计
  [/\btilted? to the upside\b/i, -1.5], [/\blittle hint of cuts?\b/i, -1.5], [/\bholds? rates? steady\b/i, -0.5],
  // 宽松信号 → 利好
  [/\brate cuts?\b/i, 2.5], [/\bcuts? (interest )?rates?\b/i, 2.5], [/\bdovish\b/i, 1.5],
  [/\bcool(er|ing|s)?[ -]?(than expected )?(cpi|inflation|ppi|jobs|payrolls)\b/i, 2],
  [/\bsoft (cpi|inflation|ppi|jobs|payrolls|print)\b/i, 2],
  [/\brate[- ]cut (hopes?|bets?|expectations?)\b/i, 1.5], [/\beasing\b/i, 1.5],
  // 避险/衰退/危机 → 利空
  [/\brecession\b/i, -2], [/\bhard landing\b/i, -2], [/\bstagflation\b/i, -2],
  [/\boil (prices? )?(spike|surge|jump|soar)\b/i, -1.5], [/\bsupply disruption\b/i, -1.5],
  [/\bpanic\b/i, -2], [/\bbanking crisis\b/i, -2.5], [/\bdefault\b/i, -2],
];
const TOPIC_RULES=TOPIC_OVERRIDE.map(([re,weight])=>[new RegExp(re.source,re.flags.includes('g')?re.flags:re.flags+'g'),weight]);

// ---- 层2: 复合短语(最长优先) —— 语义完整的动宾/主谓, 权重高 ----
const PHRASES = [
  // 中文 · 强正向
  L('创历史新高', 3), L('业绩超预期', 2.5), L('净利润大增', 2.5), L('业绩预增', 2), L('降准', 2),
  L('降息', 2), L('上调评级', 2), L('目标价上调', 2), L('获批上市', 1.5), L('逆势上涨', 2),
  L('低开高走', 1.5), L('高开高走', 1.5), L('探底回升', 1.5), L('止跌回升', 1.5), L('放量上攻', 1.5),
  L('集体大涨', 2), L('全线大涨', 2), L('大幅上涨', 2), L('大涨', 2), L('暴涨', 2), L('涨停', 2),
  L('飙升', 2), L('收涨', 1), L('领涨', 1), L('翻红', 1),
  // 中文 · 强负向
  L('创历史新低', -3), L('业绩预亏', -2), L('业绩变脸', -2), L('亏损扩大', -2), L('商誉减值', -2),
  L('立案调查', -2), L('财务造假', -2.5), L('清仓式减持', -2), L('质押爆仓', -2), L('下调评级', -2),
  L('目标价下调', -2), L('违规减持', -2), L('退市风险', -2), L('闪崩', -2.5), L('跌停', -2),
  L('暴跌', -2), L('大跌', -2), L('重挫', -2), L('大幅下挫', -2), L('低开低走', -1.5),
  L('高开低走', -1), L('收跌', -1), L('领跌', -1), L('裁员', -1.5), L('破产', -2),
  // 中文 · 常规
  L('利好', 1), L('利空', -1), L('提振', 1), L('增长', 1), L('扩张', 1), L('突破', 1),
  L('分红', 0.5), L('回调', -0.5), L('下跌', -1), L('低开', -0.5),
  // 英文 · 财报/事件
  L('beats estimates', 2), L('beat estimates', 2), L('beats expectations', 2), L('tops estimates', 2),
  L('earnings beat', 2), L('revenue beat', 2), L('guidance raised', 2), L('raises guidance', 2), L('raise guidance', 2),
  L('boosts guidance', 2), L('raised profit outlook', 2), L('full-year guidance', 1), L('cuts guidance', -2),
  L('misses estimates', -2), L('miss estimates', -2), L('misses expectations', -2), L('earnings miss', -2),
  L('profit warning', -2), L('turns profitable', 2), L('strong earnings', 2), L('blowout earnings', 2.5),
  L('upgraded to buy', 2), L('price target raised', 2), L('price target cut', -2), L('downgraded to sell', -2),
  L('wins contract', 2), L('signs deal', 1.5), L('gets approval', 2), L('secures approval', 2),
  L('dividend hike', 1), L('buyback program', 1), L('share buyback', 1.5),
  L('fraud probe', -2.5), L('short-seller report', -2), L('bankruptcy', -2.5), L('chapter 11', -2.5),
  L('delisting risk', -2), L('halts trading', -1.5), L('recalls', -1.5), L('workforce reduction', -2),
  L('job cuts', -1.5), L('layoffs', -1.5), L('shut down', -2), L('panic sell', -2.5),
  // 英文 · 市场运动(带方向语境)
  L('surges to record', 2.5), L('record high', 2.5), L('all-time high', 2.5), L('multiyear low', -2),
  L('worst day since', -2), L('falls most since', -2), L('stocks rally', 2), L('stocks slide', -2),
  L('stocks fall', -1.5), L('stocks gain', 1.5), L('stocks rise', 1.5), L('stocks drop', -1.5),
  L('rallies on', 2), L('jumps on', 2), L('plunges on', -2), L('sinks to', -2), L('slumps on', -2),
  L('tumbles after', -2), L('pulls back', -1.5), L('pull back', -1.5), L('sell-off', -2), L('selloff', -2),
  L('closes higher', 1.5), L('closes lower', -1.5), L('ends in the green', 1.5), L('ends in the red', -1.5),
  L('gains ground', 1.5), L('recovers ground', 1.5), L('breaks out', 1.5), L('futures rise', 1.5),
  L('futures fall', -1.5), L('risk-on rally', 2), L('hits record', 2), L('reaches record', 2),
  L('rebound', 1), L('rebounds', 1), L('rises after', 1), L('spikes', 1.5), L('spike', 1.5),
  L('tumbles', -2), L('tumble', -2), L('plunges', -2), L('plunge', -2), L('slumps', -2), L('slump', -2),
  L('soars', 2), L('soar', 2), L('surges', 2), L('surge', 2),
];

// ---- 层3: 原子词 —— 仅作补充; 方向词在商品/债券语境下会被隔离降权 ----
const ATOMS = [
  // 英文
  L('advance', 0.5), L('advances', 0.5), L('gain', 0.5), L('gains', 0.5), L('rise', 0.5), L('rises', 0.5),
  L('climb', 0.5), L('climbs', 0.5), L('jump', 0.5), L('jumps', 0.5), L('rally', 0.5),
  L('fall', -0.5), L('falls', -0.5), L('fell', -0.5), L('drop', -0.5), L('drops', -0.5),
  L('decline', -0.5), L('declines', -0.5), L('slides', -0.5), L('sink', -0.5), L('sinks', -0.5),
  L('loss', -0.5), L('losses', -0.5), L('warn', -0.5), L('warns', -0.5), L('fear', -0.5), L('fears', -0.5),
  L('risk', -0.5), L('risks', -0.5), L('concern', -0.5), L('concerns', -0.5), L('worry', -0.5),
  L('profit', 0.5), L('profits', 0.5), L('growth', 0.5), L('upgrade', 0.5), L('downgrade', -0.5),
  L('beat', 0.5), L('beats', 0.5), L('miss', -0.5), L('misses', -0.5), L('top', 0.5), L('exceed', 0.5),
  L('fail', -1), L('fails', -1), L('failure', -1), L('cancel', -1), L('cancels', -1),
  L('warning', -1), L('warns of', -1), L('worsens', -1), L('worsening', -1),
  // 中文
  L('涨', 0.5), L('跌', -0.5),
];

// ---- 否定处理: 真否定 = 反转极性并按 0.7 降权(语言上"并未大跌"≠强利好, 是弱化利空) ----
const NEGATORS_CN = ['并未', '没有', '未', '并非', '不是', '不再', '否认', '难以', '未见', '停止', '避免'];
const NEGATORS_EN = ['not ', 'no ', 'never ', 'without ', "isn't ", "aren't ", "don't ", "doesn't ", "didn't ", "won't ", "wouldn't ", 'denies ', 'denied ', 'deny ', 'avoids ', 'rules out ', 'lack of ', 'fails to ', 'far from ', 'hardly ', 'barely '];
const HEDGES = ['might ', 'may ', 'could ', 'about to change', '或将', '可能', '有望', '预计', '或'];

// 商品/债券语境词: 命中后, 裸方向原子词(rise/fall 等)不计分 —— 期金跌 ≠ 股市利空
const COMMODITY_CTX = /gold|silver|copper|crude|oil|wti|brent|bond|treasury|yield|note|bullion|commodity|corn|wheat|soybean|cocoa|coffee|sugar|天然气|期金|期银|原油|债券|国债|收益率|商品|可可|大豆|小麦|玉米|铜|铝/i;

// 规则预处理(模块级一次): 英文短语允许词间插入 ≤3 个过渡词(如 "beats Q3 estimates"), 中文用 indexOf
// span 长度按正则实际匹配长度(不再用 ph.length, 避免过渡词导致覆盖区间错位)
const GAP = '(?:\\s+[a-z0-9$%&\'’-]+){0,3}\\s+';
const compile = (list) => list.slice().sort((a, b) => b.len - a.len).map(r => ({
  ...r,
  re: /^[a-z '’-]+$/i.test(r.ph)
    ? new RegExp('\\b' + r.ph.trim().split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(GAP) + '\\b', 'gi')
    : null,
}));
const RULES_PHRASES = compile(PHRASES);
const RULES_ATOMS = compile(ATOMS);

function scanRules(text, rules, spans) {
  let score = 0;
  for (const { ph, w, re } of rules) {
    if (re) {
      let m; re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const i = m.index, j = i + m[0].length;                       // 用真实匹配区间
        if (spans.some(([a, b]) => i < b && j > a)) { if (m.index === re.lastIndex) re.lastIndex++; continue; }
        const pre = text.slice(Math.max(0, i - 14), i);
        const negated = NEGATORS_EN.some(n => pre.includes(n)) || NEGATORS_CN.some(n => pre.includes(n));
        if (negated) { spans.push([i, j]); continue; }              // 真否定: 抑制, 不计入任何方向
        spans.push([i, j]);
        score += w;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      continue;
    }
    let idx = 0;
    while ((idx = text.indexOf(ph, idx)) !== -1) {
      if (spans.some(([a, b]) => idx < b && idx + ph.length > a)) { idx += ph.length; continue; }
      const pre = text.slice(Math.max(0, idx - 10), idx);
      const negated = NEGATORS_CN.some(n => pre.includes(n)) || NEGATORS_EN.some(n => pre.includes(n));
      if (negated) { spans.push([idx, idx + ph.length]); idx += ph.length; continue; }   // 真否定: 抑制
      spans.push([idx, idx + ph.length]);
      score += w;
      idx += ph.length;
    }
  }
  return score;
}

export function sentiOf(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return '中性';

  // 层1: 主题 override(紧缩/宽松/避险) —— 直接定主方向
  let topicScore = 0;
  for (const [matcher, w] of TOPIC_RULES) {
    // Topic overrides obey the same local negation boundary as phrase rules.
    // Evaluate each match so a negated mention cannot suppress a later assertion.
    matcher.lastIndex=0;
    let match;
    while((match=matcher.exec(t))!==null) {
      const pre=t.slice(Math.max(0,match.index-24),match.index).split(/[.;!?，。；！？]/).at(-1);
      if(NEGATORS_EN.some(n=>pre.includes(n))||NEGATORS_CN.some(n=>pre.includes(n)))continue;
      topicScore+=w;
      break;
    }
  }

  // 中文商品/期货快讯(含"期货/期金/期银/原油"等)且无任何股市语境词时: 涨跌不映射股市利好利空
  const zhFuturesOnly = /期货|期金|期银|期铜|原油|可可|大豆|小麦|玉米|黄金|白银|伦铜|伦铝/.test(t)
    && !/股|沪指|深成|创业板|科创|纳指|标普|道瓊|大盘|a股|美股|港股|上市公司|券商/.test(t);
  if (zhFuturesOnly && topicScore === 0) return '中性';

  // 层2+3: 短语 → 原子词(共享 spans 防重复计数)
  const spans = [];
  let score = scanRules(t, RULES_PHRASES, spans);
  // 商品/债券语境: 裸方向原子词不计分(隔离) —— "Bond Yields Rise" 不应因 rise 判利好
  const isolateAtoms = COMMODITY_CTX.test(t);
  if (!isolateAtoms) score += scanRules(t, RULES_ATOMS, spans);

  let total = score + topicScore;
  if (HEDGES.some(h => t.includes(h.trim()))) total *= 0.7;   // 对冲/推测降权
  if (topicScore !== 0 && score !== 0 && Math.sign(topicScore) !== Math.sign(score)) total = topicScore;   // 主题优先于冲突短语

  return total > 0.5 ? '利好' : total < -0.5 ? '利空' : '中性';
}
