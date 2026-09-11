# Global Major Markets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本环境未安装上述两个子技能，按用户已指定的子agent实施方式，使用原生collaboration分工、独立复审与现有验证工具执行；不另行要求用户重复选择执行方式。

**Goal:** 为现有行情站加入FTSE100及用户确认的20个主要市场，真实支持发现、报价、图表、正确交易时段和货币单位，并完成上线验收。

**Architecture:** 保持模块化Node单体与原生JavaScript前端。增加一个服务端市场目录，供识别与只读目录API共同使用；现有Yahoo行情适配器继续负责新增市场，既有区域批量源只服务其已验证范围。按原始报价单位保存价格，统一换算语义并以明确的日历覆盖边界处理不同交易所。

**Tech Stack:** Node24/26 ESM、原生HTTP/Canvas、Playwright Chromium、现有V8覆盖率与systemd发布门禁。

**Spec:** `docs/global-markets-spec.md`。隔离工作树为`work/global-markets`，基线提交`fdfdcbe`。父代理负责官方资料与线上数据核实、计划、集成、发布和验收；实施由以下子agent负责。

---

## 分工和文件边界

- 后端子agent `global_backend_map`：拥有`lib/`、`mkt.mjs`、`server.js`、`data/`、后端确定性测试、`docs/calendar-sources.md`与新市场数据源说明。新增集中式`lib/market-registry.js`和必要的货币工具；具体文件数量服从职责边界，不为拆分而拆分。
- 前端子agent `repair_sw_final`：拥有`public/app.js`、`public/index.html`、`public/style.css`、`public/modules/`及前端/浏览器新回归；新增`panel-market-directory.js`管理目录，不向app塞入目录渲染实现。
- 复审子agent `review_v63_snapshot`：先审完整计划，再审实现与缺陷修复；只读。
- 父代理：维护本规格/计划，写入`work/global-market-research.json`等非源码研究材料；处理VERSION、生成bundle、门禁工具如有必要的集成修改、发布脚本和最终验收文档。所有实施者不回退他人修改，不自行变更版本、生成bundle或部署。

## 共享契约（先锁定再并行）

### 市场目录 API

`GET /api/markets`返回JSON、只读、可短时缓存，不触发行情请求：

```js
{
  version: 1,
  featured: ['^FTSE'],
  markets: [{
    key: 'uk', name: '英国', label: '英股', region: '欧洲',
    exchange: 'London Stock Exchange', timezone: 'Europe/London', currency: 'GBP',
    benchmarks: [{symbol:'^FTSE',name:'富时100',type:'INDEX'}],
    examples: [{symbol:'VOD.L',name:'Vodafone',type:'EQUITY'}],
    sourceNote: '公开来源可能延迟或缺少部分字段'
  }]
}
```

`examples`包含经过身份核实的股票与ETF，每个项目固定使用`symbol/name/type`；`type`为`EQUITY/ETF/INDEX`。代码与名称由服务端目录统一提供。代表代码须经真实上游核实，未成功的不能标成已验证示例。目录仅描述支持能力，某证券当次可用性由行情响应决定。

### 货币和指数

沿用`quote.currency`原始大小写单位及`quote.fxMap`约定，不批量改写原价序列。`GBp`/`GBX`转换成GBP金额时先乘0.01，`ZAc`/`ZAC`先乘0.01得到ZAR。普通GBP、ZAR本身不得缩小；指数`instrumentType==='INDEX'`在后端元数据、前端money/axis/tooltip/基准说明中始终为点数。前端存储新增`NATIVE`，旧USD/CNY值与旧默认选择保持兼容。后端`currency2cny`与前端换算采用相同表格测试向量，不进行二次换算。新增持久化字段须补recovery白名单回归。

FX可返回缺少某币种的真实同源集合；缺少TWD等币种时该币种回落到原币并提示，不能令所有市场不可用。优先扩展一次批量取价、已有ECB完整同日参考集合；不允许新增15条无界FX chart扇出。若按所需币种选集合，必须在每个quote附上对应来源/日期/时效，不能只改全局fxMap后让旧quote误用新集合。

### 日历

市场目录与日历分离。2026条目保留原closed/halfDays，增加明确`validFrom/validThrough`和通用按日期sessionOverrides或等价结构，支持缩短/延后/周末特殊开市及明确未确认的特殊时段。完整日期窗口内不得只靠sources数组冒充完整覆盖；未覆盖年份返回未知，90天门禁阻止未说明的缺口。官方已宣布特殊日期、具体时间未发布的情况明确输出待确认警告，不补造时刻。

主要新增后缀：`.L/.DE/.PA/.SW/.AS/.MI/.MC/.TO/.AX/.NS/.SI/.TW/.SA/.MX/.JO`。如加入`.BO/.TWO/.V`等次级场所，必须同时有匹配场所的时段和日历证据，不能仅共用邻近后缀。合法印度`M&M.NS`及台湾`00632R.TW`必须覆盖；扩大字符集前，所有provider URL和浏览器URL查询都须正确编码，保持长度、类别限制和未知符号失败关闭。

## Task 1: 目录、身份与路由（后端）

- [ ] 写失败测试：20市场及代表代码；FTSE100和无caret指数；股票/ETF身份；未知`.XX`不回落美国；`M&M.NS`编码、`00632R.TW`通过且注入样例被拒。
- [ ] 新增集中目录，将`lib/instruments.js`、`lib/search.js`的新增识别/别名接入目录；允许现有美股BRK-B等兼容符号。
- [ ] 修改`lib/http.js`验证与目录路由、`lib/http-charts.js`条件图表标识以及`lib/recovery-store.js`验证（仅必要处）；保留配额与12只上限。
- [ ] 以规范marketKey限制Nasdaq/腾讯的适用范围；Yahoo路径参数编码；补回归证明外国代码不会触发美国备用源。
- [ ] 运行对应新测试及既有身份、搜索、HTTP/CV/recovery测试，确认失败先出现再消失。给前端确认最终目录schema。

## Task 2: 时区、日历与时效（后端，父代理提供官方事实）

- [ ] 先以固定时钟写失败向量：伦敦/纽约DST不同切换周、加拿大半日、欧洲闭市、新加坡午休、印度特殊周日、已知日期未公告时刻、未知年份。
- [ ] 将`mkt.mjs`与`lib/sessions.js`/`lib/session-policy.js`改为通用日历状态；先检查特殊日覆盖再判断周末，按目标时间计算IANA偏移。
- [ ] 根据父代理核实的官方来源材料填入20市场日历和标准连续交易时段；不得把公共法定假期、清算休息日和股票闭市混用。
- [ ] 传递提供者明确的`exchangeDataDelayedBy`或等价延迟字段；未知延迟保持未知，来源检查与最近成交时间分开。
- [ ] 扩展日历覆盖门禁，保留90天窗口及既有市场行为测试。数据来源、获取日期、特殊日期的不确定性写入说明。

## Task 3: 全球FX与子单位（后端）

- [ ] 写失败测试：GBp/GBP、GBX、ZAc/ZAR、EUR/CHF/CAD/AUD/INR/SGD/TWD/BRL/MXN；价格与涨跌因子相同、百分比/成交量不缩放；指数不换汇。
- [ ] 在quote/redundancy使用共用货币工具，保留原始报价单位与数组；参考FX扩展可用币种、单一日期/来源、不完整币种局部降级。
- [ ] 批量请求及回退请求均走现有Yahoo熔断，保持最多4个chart回退预算；测试429不会因新增币种放大请求。
- [ ] 更新FX元数据与recovery保存/恢复，确认旧格式存储仍可读取且不会100倍缩放。

## Task 4: 全球市场浏览和原币（前端）

- [ ] 写失败测试：目录加载/失败重试、FTSE添加、重复和12只上限、旧自选不变、NATIVE持久化；GBp/ZAc/INDEX在卡片及图表统一格式。
- [ ] 新增独立目录控制器：可展开、地区或市场筛选，股票/ETF/指数类型清晰；以目录API驱动FTSE重点入口，键盘可达，添加成功有反馈。
- [ ] 修改currency/format/card/state及app最小接线：原币按钮，大小写敏感子单位，缺FX回落原币并解释，指数隐藏货币选择。
- [ ] 只按用户添加激活证券；目录展开不请求全部报价，不覆盖已有localStorage；失败提示独立于币种重绘。
- [ ] 加入真实应用浏览器旅程和320px/DPR验证，复测既有新闻、离线、手势和自选流程；生成bundle交父代理统一完成。

## Task 5: 审查、实源与发布（父代理+独立复审）

- [ ] 计划审查通过后分阶段GO；每位worker报告文件、先失败后通过证据及限制，独立code-reviewer审查跨层契约。
- [ ] 父代理用当前授权服务器的公开数据中继做低频样本核实；保存20市场代表指数/股票/ETF的源身份、币种/单位、价格、分时/日线长度与错误状态，不落盘凭据。FTSE100为硬性成功条件。
- [ ] 如某市场示例源不可用，先验证正确代码/同市场替代提供者；不能以默认0、ETF替指数或模拟数据通过。需要降低能力描述时明确记入验收，不宣称全面实时覆盖。
- [ ] 合并代码，更新VERSION并重建静态资源；运行`node scripts/gate-state.mjs --begin`、source/calendar、`node scripts/coverage.mjs --record`，保持109个既有确定性文件和26个既有浏览器用例及新增测试全部通过、各层覆盖率>=80%。
- [ ] Linux Node24重新执行确定性测试、6个systemd单元原生检查，记录同一源码指纹，重复构建发布包核对一致。
- [ ] 独立预发布实例验收，再正式切换；严格验证FTSE100和QQQ/SPY价格及两种图表、ready、版本/PID/current/文件清单。失败自动回退v65，保留分离服务身份与凭据权限。
- [ ] Chrome验证目录、FTSE100、原币及子单位、窄屏、旧自选保持、SW更新；保存清晰验收文档和源码包。恢复测试时临时修改的用户偏好。

## 实施停止线

数据源权限或未公告的交易时间不是可以猜测的数据。未知显式表达并继续完成其余可验证范围；若直接影响用户指定的FTSE100或某市场整个核心数据能力，发布前必须解决或向用户说明实证阻碍。不得降低测试门槛，亦不得修改运行中的其他应用和Docker挂载配置。
