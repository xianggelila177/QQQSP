// SENT-V3 利好/利空判断准确性 —— RED 阶段测试
// 复现来源: 2026-08-28 线上 /api/macro 与 /api/news 真实误判 + 典型模式样本
// 契约: sentiOf(title) 返回 '利好' | '利空' | '中性'
// 预期方向由人工逐条标注(括注理由), 修复后须全绿。
import { sentiOf } from '../sent.mjs';

const CASES = [
  // ===== 线上误判复现(2026-08-28) =====
  ['Fed Chair Warsh signals rate hikes may be needed with inflation still elevated', '利空'],   // 加息信号 → 利空(旧:中性, hike未入词典)
  ['Watch Jackson Hole: Fed Rate Hike Would Be Important Signal to Market', '利空'],              // rate hike → 利空(旧:中性)
  ['Bond Yields Rise Despite Treasury Efforts to Curb Borrowing Costs', '中性'],                  // 债市叙述, 勿因"rise"直接判利好(旧:利好)
  ['Nvidia Pulls Back on a Risky AI Cloud Strategy', '利空'],                                     // pulls back 回落(旧:中性)
  // ===== 金融紧缩/政策: 对股市为利空 =====
  ['Fed signals more rate hikes ahead as inflation persists', '利空'],
  ['Fed holds rates steady, offers little hint of cuts', '利空'],                                 // 不降=偏鹰 → 微利空
  ['Treasury yields climb after hot CPI reading', '利空'],                                        // 收益率飙升(紧缩)→ 股市利空
  ['Fed officials see inflation risks tilted to the upside', '利空'],                             // risks to the upside(通胀)
  ['Powell warns higher-for-longer rates may be necessary', '利空'],
  ['US inflation accelerates to 3.5%, denting rate-cut hopes', '利空'],
  ['Hawkish Fed minutes dampen hopes for early rate cuts', '利空'],
  // ===== 宽松/政策: 对股市为利好 =====
  ['Fed signals rate cuts could start in September', '利好'],
  ['Powell hints at rate cuts as inflation cools', '利好'],
  ['Cooler-than-expected CPI boosts rate-cut hopes, stocks rally', '利好'],
  ['Fed delivers 25bp rate cut, markets cheer', '利好'],
  ['Dovish comments from Fed officials lift stocks', '利好'],
  ['US economy adds fewer jobs than expected, bolstering rate-cut bets', '利好'],                 // 弱非农 → 降息预期 → 股市利好
  // ===== 中文: 否定/修正句(旧双重否定缺陷) =====
  ['公司称并未计划大规模裁员', '中性'],                                                           // 并未裁员 → 不应利空(旧:利空)
  ['业绩没有增长，但也没有亏损', '中性'],                                                         // 没有增长 → 不应利好(旧:利好)
  ['并非所有板块都在上涨', '中性'],                                                               // 并非上涨 → 不应利好(旧:利好)
  ['公司否认业绩变脸传闻', '中性'],                                                               // 否认变脸 → 中性(旧:利空)
  ['市场并未出现恐慌性抛售', '中性'],                                                             // 并未抛售 → 中性
  // ===== 中文: 涨跌/事件 =====
  ['沪深两市低开高走，沪指收涨0.8%', '利好'],
  ['三大指数集体收跌，创业板指跌超2%', '利空'],
  ['央行宣布降准0.5个百分点，释放长期资金', '利好'],
  ['证监会就减持新规公开征求意见', '中性'],                                                       // 中性监管动作
  ['公司发布业绩预增公告，净利润同比增长50%', '利好'],
  ['公司因财务造假被立案调查', '利空'],
  ['多款产品获批上市，券商上调目标价', '利好'],
  ['大股东拟清仓式减持，股价闪崩', '利空'],
  ['隔夜美股大涨，纳指创历史新高', '利好'],
  ['恐慌情绪蔓延，美股全线重挫', '利空'],
  // ===== 英文: 否定/修正(旧仅前8字符窗口+无否定语料) =====
  ['Company says it is not planning layoffs', '中性'],                                            // is not planning layoffs → 中性(旧:利空)
  ['CEO denies fraud allegations in detailed rebuttal', '中性'],                                  // denies fraud → 中性(旧:利空)
  ['Analysts say stock is not overvalued despite rally', '中性'],                                 // not overvalued → 中性
  ['No, the Fed is not about to change course on rates', '中性'],                                 // No + not → 中性(旧 hedges 减半但方向仍可能错)
  // ===== 英文: 市场涨跌/财报/事件 =====
  ['Nvidia surges to record high on blowout earnings', '利好'],
  ['Stocks slide as bond yields spike to multiyear highs', '利空'],
  ['Dow jumps 500 points after soft inflation print', '利好'],
  ['S&P 500 ends lower as recession fears resurface', '利空'],
  ['Apple beats Q3 estimates, raises full-year guidance', '利好'],
  ['Meta misses revenue estimates, shares tumble after hours', '利空'],
  ['Tesla recalls 2 million vehicles over safety concerns', '利空'],
  ['Microsoft wins $10B cloud contract from Pentagon', '利好'],
  ['Company announces 10% workforce reduction to cut costs', '利空'],
  ['Boeing secures approval for 737 MAX deliveries to resume', '利好'],
  ['Oil prices jump on supply disruption fears', '利空'],                                         // 油价飙升(成本/通胀)→ 股市语境利空
  ['Oil prices plunge as recession fears sap demand outlook', '利空'],
  ['Gold climbs to record as investors seek safety', '中性'],                                     // 避险资产涨, 非直接股市利好
  // ===== 边界: 纯商品/中性叙述 =====
  ['纽约期金失守4600美元/盎司，日内跌1.41%', '中性'],
  ['纽约可可期货暴涨近7%，至6588美元/吨', '中性'],
  ['Copper prices steady ahead of key China data', '中性'],
  ['WTI crude trades near $80 a barrel in quiet session', '中性'],
  ['How $400,000 in JEPQ Pushed a Retiree’s Medicare Premium Up $1,000 a Year', '中性'],
  ['5 Dividend Stocks Whose Income Turns Completely Tax-Free in a Roth', '中性'],
];

let pass = 0; const fails = [];
for (const [title, want] of CASES) {
  const got = sentiOf(title);
  const mark = got === want ? '✓' : '✗';
  if (got !== want) fails.push(`[${got}]≠[${want}] ${title}`);
  console.log(`${mark} [${got}] ${title.slice(0, 78)}`);
}

console.log(`\n[SENT-V3] ${pass}/${CASES.length} 通过, ${fails.length} 失败`);
if (fails.length) { console.log('失败明细:'); fails.forEach(f => console.log('  ' + f)); }
process.exit(fails.length ? 1 : 0);
