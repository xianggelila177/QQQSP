# QQQSP 重构总体规划 / Rebuild Master Plan

> **文档目的**：Part 1 罗列本产品要实现的全部内容（重构后必须完整覆盖）；Part 2 给出推倒重构的架构与执行路径。
> 实施者（Astra）按 Part 2 的阶段执行，每个阶段以 Part 1 的对应条目作为验收清单。
>
> **Purpose**: Part 1 is the complete inventory of what this product must do (the rebuild must cover all of it); Part 2 is the rebuild architecture and execution path. The implementer (Astra) executes Part 2 phase by phase, accepting against Part 1.

**基线 / Baseline**：qqqsp v72（Node ≥24，零运行时依赖，原生 http + Vanilla JS，VPS 单实例 + systemd + cloudflared）。
**代号 / Codename**：`qqqsp-v2`（新目录/新仓库，v72 保持运行直至切换）。
**硬性约束 / Hard constraints**（重构全程不得违反 / inviolable throughout）：

1. **零 npm 运行时依赖**。只用 Node 标准库与浏览器原生 API。/ Zero npm runtime dependencies — Node stdlib and browser-native APIs only.
2. **诚实性契约不可退化**：`quoteAt`（成交时间）与 `sourceCheckedAt`（来源检查时间）永远分开；无新成交时报价年龄必须继续增长；延迟来源必须标注 `feedDelayMinutes`/`feedCoverage`/`priceBasis`。/ Honesty contract: trade time vs check time never conflated; quote age grows when no new trade; delays and coverage always labeled.
3. **红涨绿跌**（中式配色）。/ Red-up/green-down (Chinese convention).
4. 时钟与界面时间默认 UTC+8。/ UI times default to UTC+8.
5. 所有对外行为变化必须有测试先行。/ Behavior changes are test-first.

---

# Part 1 — 目标全景清单 / Complete Goal Inventory

标注 / Legend：`[保留]` = v72 已有，重构必须完整带走 · `[改进]` = 审查发现的缺陷，重构中修正 · `[新增]` = 目标态新能力
`[keep]` = exists in v72, must survive the rebuild · `[fix]` = defect found in review, correct in rebuild · `[new]` = new target capability

## G1. 行情核心 / Quote core

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 1.1 | 全球多市场自选行情面板（美/A股/港/日/韩/欧/澳/印等 20 个注册市场） | [保留] | `data/market-instruments.json` + `market-registry` 数据驱动 / data-driven registry |
| 1.2 | 自选上限 12，localStorage 持久化（观察名单、每卡币种、名称、刷新模式、布局偏好） | [保留] | 上限与后端 `MAX_SYMBOLS=12` 一致 / client cap matches server |
| 1.3 | 时段感知：盘前/盘中/盘后/集合竞价/午间休市/休市/节假日 | [保留] | `mkt.mjs` SESSIONS + 日历 JSON，含 half-day 与 unknownSessions / calendars with half-days and pending sessions |
| 1.4 | 盘前/盘后独立报价行（独立基准价标注） | [保留] | `extSessions` 契约 / ext contract |
| 1.5 | 报价年龄每秒更新（独立显示计时器，不依赖网络） | [保留] | v72 已修，回归测试必须保留 / keep the v72 contract + tests |
| 1.6 | 来源检查时间 vs 成交时间分离显示 | [保留] | 诚实性核心 / honesty core |
| 1.7 | 来源标注（Yahoo/腾讯/东财/Naver/Alpaca/新浪/Nasdaq…）与延迟分钟 | [保留] | `feedDelayMinutes`、来源名映射 / source names + delay |
| 1.8 | 涨跌红涨绿跌 + 价格闪动（flash-up/down） | [保留] | |
| 1.9 | 降级链：主源 → 备源 → 旧缓存（stale 标注）→ 离线恢复文件 | [保留]+[改进] | 保留链路；修复 quote-cache 的 SWR 语义（v72 bug：10s 内不触发后台刷新）/ keep the chain, fix the stale-while-revalidate bug |
| 1.10 | 服务端聚合轮询：上游成本与客户端数量无关 | [保留] | 这是 v72 最正确的决策，重构保留为内核原则 / server-side fan-in stays a kernel principle |
| 1.11 | **SSE 服务端推送替代浏览器 2s 轮询** | [新增] | 快照变化即推；HTTP 轮询降级为兜底 / push on change, poll as fallback |
| 1.12 | **推送优先**：Alpaca WS（已有）+ 第二免费 WS 互备 | [改进]+[新增] | 流状态对用户可见（v72 缺渲染）/ stream status rendered |
| 1.13 | **统一源注册表**：每源声明市场/批量能力/声明间隔/延迟/推送 | [新增] | 替代散落的 UPSTREAM_ROLES/providerCapabilities / replaces scattered tables |
| 1.14 | **统一 per-host 断路器** + 源健康面板 | [新增] | 泛化 yahoo-breaker；/api/stats 输出 per-host 状态 / generalized breaker + health surface |

## G2. 图表 / Charts

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 2.1 | 分时/日K/周K/月K/年K 五档切换 | [保留] | |
| 2.2 | MA5/10/20、成交量柱、十字光标、键盘导航（←→/Home/End） | [保留] | |
| 2.3 | 拖拽平移（Pointer Events）、滚轮缩放（锚定光标）、滑块、全览/最新跟随 | [保留] | |
| 2.4 | 图表 PNG 导出（白底合成） | [保留] | |
| 2.5 | 实时点与历史点分离（intradayLivePoint 契约：不伪造历史 bar） | [保留] | v68 契约，回归测试保留 / v68 contract, keep tests |
| 2.6 | 历史分页加载（before/seriesId/revision，409 身份变化重载） | [保留] | |
| 2.7 | cv 增量传输协议（版本一致回 'same'） | [保留] | 带宽核心优化 / key bandwidth optimization |
| 2.8 | **历史多源**：Yahoo 主 + 腾讯/新浪 A股兜底；架构上历史源可插拔 | [改进] | v72 历史链路 identity 硬写 'yahoo' / remove the hardcoded source |
| 2.9 | resize 单通道防抖重绘（ResizeObserver + rAF 合帧） | [改进] | v72 双通道无防抖 / currently dual-channel undebounced |

## G3. 资讯与宏观 / News & macro

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 3.1 | 卡片级相关新闻（Yahoo/东财/Google News，按市场选源） | [保留] | |
| 3.2 | 宏观资讯：Google topic 聚合 + 新浪7x24 快讯 | [保留] | |
| 3.3 | 官方源 RSS：Fed/ECB/BEA（30 天窗口，官方预约 3 条） | [保留] | |
| 3.4 | 规则情绪标签（利好/利空/中性）+ 误判免责说明 | [保留] | `sent.mjs` 关键词规则 / keyword rules |
| 3.5 | **折叠面板懒加载**：未展开不轮询 | [改进] | v72 折叠也每 60s/120s 拉取，白烧 Yahoo 配额 / collapsed panels still poll today |

## G4. 汇率 / FX

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 4.1 | 每卡 USD/CNY/原币 三态切换，持久化 | [保留] | |
| 4.2 | Yahoo 主源（v7 批量 + chart 兜底）+ ECB 日度参考源（Frankfurter 镜像同源） | [保留] | |
| 4.3 | 交叉换算标注 ≈ 与"非实时汇率"说明；GBp/ZAc 分单位 | [保留] | |
| 4.4 | 汇率缺失时显示原币并提示，不伪造数值 | [保留] | 诚实性 / honesty |

## G5. 可靠性与运维 / Reliability & ops

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 5.1 | 429 处理：Retry-After 解析、指数退避、断路器、半开探测 | [保留]+[改进] | 解析逻辑收敛为单一实现 / one parser |
| 5.2 | 请求准入：per-client 配额 + 并发与队列上限 | [保留]+[改进] | 修复隧道下身份坍塌（TRUST_PROXY_LOOPBACK 默认关且文档缺失）/ fix identity collapse behind the tunnel |
| 5.3 | 恢复文件：原子写、模式校验、符号/字节/年龄有界、损坏隔离 | [保留] | recovery-store 是 v72 最好的模块之一，直接移植 / port almost as-is |
| 5.4 | systemd 服务组 + cloudflared 隧道 + 看门狗脚本 | [保留] | ops 资产带走 / carry ops assets |
| 5.5 | /healthz /readyz /api/stats（token 或回环保护） | [保留] | |
| 5.6 | 结构化 JSON 日志 + 文件轮转 + 磁盘容量监控 | [保留] | |
| 5.7 | **配置单一事实源**：全部 env 集中校验 + 完整 .env.example | [改进] | v72 至少 4 处模块级 env 读取 / scattered env reads today |
| 5.8 | 启动日志输出激活的数据路径拓扑（快照/冗余/WS 开关状态） | [新增] | |

## G6. 前端体验 / Frontend UX

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 6.1 | PWA：manifest、SW 预缓存、版本升级提示、离线静态资源 | [保留] | |
| 6.2 | 响应式布局（auto/2/3/4 列）+ 卡片 band 跨卡对齐 | [保留] | |
| 6.3 | 心跳 Worker + 看门狗自愈（冻结恢复补刷） | [保留] | |
| 6.4 | 省流/持续监控双模式（按市场状态与前后台调频） | [保留] | |
| 6.5 | 搜索：Yahoo + 腾讯联想 + 中文别名表，IME 安全，键盘导航 | [保留]+[改进] | 改为合并去重而非 Yahoo 优先丢弃腾讯 / merge instead of drop |
| 6.6 | 市场目录浏览（/api/markets 驱动） | [保留] | |
| 6.7 | 可访问性：ARIA、role、键盘、prefers-reduced-motion | [保留] | |
| 6.8 | **实时流状态可见**（推送中/连接中/重试中/已回退轮询） | [改进] | v72 产出 realtimeStatus 但零渲染 / produced but never rendered |
| 6.9 | **首屏骨架屏**（PENDING 期间） | [新增] | |
| 6.10 | 顶栏市场状态改为汇总式（"3/5 交易中"）替代多数决 | [改进] | |
| 6.11 | 面向用户错误文案统一映射（原始 code 入 title） | [改进] | |

## G7. 性能目标 / Performance targets

| # | 目标 Goal | 标记 | 说明 Notes |
|---|---|---|---|
| 7.1 | 历史聚合缓存 + 字节数估算（不为算字节全量序列化） | [改进] | v72 每 60s 全量 JSON.stringify 2 万行 / full stringify per write today |
| 7.2 | 静态资源 brotli 预压（保留 gzip 回退） | [新增] | |
| 7.3 | 图表重绘签名短路（已有）+ MA 计算缓存（已有 WeakMap） | [保留] | |
| 7.4 | SSE 后浏览器常态请求量目标：0 轮询请求（仅事件流 + 操作请求） | [新增] | 量化验收 / measurable acceptance |

## G8. 工程质量 / Engineering quality（重构的内生目标）

| # | 目标 Goal | 说明 Notes |
|---|---|---|
| 8.1 | 单一对象图：唯一组装根，无模块级默认实例，无 initXxx 后门 | 消除 v72 最大架构债 / kills the biggest v72 debt |
| 8.2 | 统一缓存原语（TTL + 负缓存 + 单飞 + 终态）替代 8+ 份手写变体 | |
| 8.3 | 纯函数与 IO 分层：domain 层零 import 副作用 | |
| 8.4 | 每个 source adapter 独立 fixture 契约测试 | |
| 8.5 | API 契约冻结：v72 响应 shape 固化为 golden 测试 | 保证可灰度切换 / enables staged cutover |

---

# Part 2 — 推倒重构思路 / Rebuild Strategy

## 2.1 为什么重构而不是继续修补 / Why rebuild instead of patch

v72 的单点 bug 都不致命，但**结构性税收**已经过高：双例对象图让每个改动要推理两套状态；8 份手写缓存让一致性修复无法一处生效；前端 app.js 的交叉状态使任何刷新逻辑改动都要回归全部时序。重构的目的不是"更漂亮"，而是把后续每个功能的边际成本降下来。
No single v72 bug is fatal, but the structural tax is too high: dual object graphs force reasoning about two states per change; eight hand-rolled caches make consistency fixes impossible to land once; app.js cross-state makes every refresh-logic change a full timing regression. The rebuild's purpose is cutting the marginal cost of every future feature.

## 2.2 目标架构 / Target architecture

四层 + 内核事件总线，单向依赖，禁止跨层反向 import。
Four layers plus a kernel event bus; one-way dependencies; no upward imports.

```
┌─────────────────────────────────────────────────────────┐
│ web/          浏览器：store + views + sse-client          │  无框架 Vanilla JS
├─────────────────────────────────────────────────────────┤
│ api/          HTTP 路由 + SSE 网关 + admission + 静态服务  │  无业务逻辑
├─────────────────────────────────────────────────────────┤
│ engine/       quote-engine · scheduler · breaker ·       │  有状态，但状态
│               cache · history · news · fx · recovery     │  全部显式持有
├─────────────────────────────────────────────────────────┤
│ sources/      yahoo · tencent · eastmoney · naver ·      │  每源一个 adapter，
│               sina · nasdaq · alpaca · official-rss ·    │  只出不进的纯适配
│               ecb/frankfurter                            │
├─────────────────────────────────────────────────────────┤
│ domain/       instruments · sessions · calendar ·        │  纯函数、零 IO、
│               quote-contract · freshness · currency ·    │  零 import 副作用
│               merge · units                              │
└─────────────────────────────────────────────────────────┘
         events: QuoteUpdated / SourceHealthChanged
```

**数据流 / Data flow**（单向）：
`source adapter → normalize（domain.quote-contract）→ quote-engine（去重/乱序拒绝/新鲜度推导）→ cache → ① HTTP 快照读取 ② SSE 广播（QuoteUpdated 事件）`
`source adapter → normalize → quote-engine (dedupe / reject out-of-order / freshness) → cache → ① HTTP snapshot reads ② SSE broadcast`

**关键形态 / Key shapes**：
- 一个进程只有 **一个** `createApp()` 对象图；所有依赖构造时注入；没有模块级实例、没有 init 后门。
  One process = one `createApp()` graph; constructor injection only; no module-level instances, no init backdoors.
- source adapter 统一接口：
  ```js
  {
    id: 'tencent',                          // 注册表键
    supports(symbol) → bool,
    declaredIntervalMs: 2000,               // 源声明节奏（调度下限）
    feedDelayMinutes: null|number,          // 诚实标注
    transport: 'poll' | 'ws',
    fetchBatch(symbols, ctx) → [{symbol, price, quoteAt, ...}],   // poll 源
    stream?: { start(), stop(), onTrade(cb) }                     // ws 源
  }
  ```
- engine 按注册表调度：同组源一个批量请求；会话状态调频（开市/午休/闭市不同节奏）；per-host 断路器统一挂载。
  The engine schedules from the registry: one batch request per source group; session-aware cadence; unified per-host breakers.

## 2.3 核心设计决策 / Core design decisions

1. **契约冻结先行**。开工第一天：用 v72 fixture 把 `/api/market`、`/api/news`、`/api/macro`、`/api/history`、`/api/search`、`/api/markets` 的响应 shape 固化为 golden JSON 契约测试（字段集、类型、null 语义）。v2 的全部 API 必须通过这些契约。这是灰度切换与回退的保险丝。
   **Contract freeze first.** On day one, freeze v72 response shapes as golden contract tests (field sets, types, null semantics). Every v2 API must pass them. This is the fuse for staged cutover and rollback.
2. **domain 层纯函数化**。sessions/calendar/freshness/merge/currency 全部零 IO 纯函数，`now` 一律参数注入。表驱动测试。
   Pure domain layer: zero IO, `now` always injected, table-driven tests.
3. **统一缓存原语** `createCachedResource({ttlMs, failureCooldownMs, loader, terminalWhen, staleOnError})`，news/macro/search/daily/fx/nasdaq/tencent/official 全部迁移其上。语义差异用选项表达，不复制代码。
   One cached-resource primitive; semantic variants become options, never copies.
4. **事件驱动内核**。quote-engine 内部维护权威快照；每次有效更新发 `QuoteUpdated`。HTTP 读 = 快照快照；SSE = 事件订阅。浏览器轮询退化为兜底。
   Event-driven kernel: authoritative snapshot inside the engine; each valid update emits `QuoteUpdated`. HTTP reads snapshot state; SSE subscribes to events; browser polling degrades to fallback.
5. **前端单一 store**。`app.js` 拆解：`store`（watchlist/quotes/connection 状态机）+ `views`（card/chart/news/macro/directory）订阅渲染。禁止 view 直接发请求——一律经 store 派发。
   Single frontend store; views subscribe and render; views never fetch directly.
6. **每源一个文件 + 一个 fixture 目录**。adapter 不知道调度、缓存、熔断的存在——这些由 engine 横切。
   One file + one fixture dir per source; adapters are ignorant of scheduling, caching, breaking — the engine owns those cross-cutting concerns.
7. **配置单一事实源**：`config.js` 集中校验全部 env（bounds 表模式），任何模块禁止读 `process.env`；`.env.example` 由同一张表生成注释骨架，check 脚本强制同步。
   Single config source: one validating table; modules never touch `process.env`; `.env.example` generated from the same table with a sync check.
8. **数据资产直接带走**：`data/market-instruments.json`、`market-calendars.json`、`yahoo-delays.json` 是多年积累的资产，原样复制，不改 schema。
   Data assets (`data/*.json`) carry over unchanged.
9. **零依赖维持**。前端保持"模块拼接 bundle + SW 预缓存"的既有形态（它已工作且利于离线）；不引入构建链。
   Zero dependencies hold. Keep the concatenated-bundle + SW precache shape (it works and is offline-friendly); no build chain.
10. **日志与诊断对齐 v72**：结构化 JSON 日志、/healthz、/readyz、/api/stats 的字段在 v2 保持同名（运维脚本已依赖）。
    Logging and diagnostics keep v72 field names (ops scripts depend on them).

## 2.4 移植 / 重写 / 删除清单 / Port · Rewrite · Delete

**直接移植（微调）/ Port with minor edits**：
- `lib/xml-structure.js`（手写 XML 解析，防御完备）
- `lib/recovery-store.js`（518 行，原子写/校验/隔离齐全；仅把 `log` 参数对齐新 logger）
- `mkt.mjs` 的 SESSIONS/日历逻辑 → 拆为 `domain/sessions.js` + `domain/calendar.js`（去掉模块级 readFileSync，改注入数据）
- `lib/providers/alpaca-stream.js`（WS 生命周期完整；改为注册表声明 + 状态事件上抛）
- `lib/http-response.js` 静态服务（加 brotli 预压）
- `lib/history-aggregate.js`、`lib/history-contract.js`（纯函数，几乎原样）
- `sent.mjs` 情绪规则
- `data/*.json`、`ops/*.sh`、systemd unit 文件

**重写（保留语义、更换结构）/ Rewrite (same semantics, new structure)**：
- `lib/quote.js` `fetchQuote` 组装 → `engine/quote-assembler.js`：当前 250 行串行/并行混杂、CN 特例内联；重写为字段级管线（identity → price → prevClose → ohlc → ext → fx → charts），每字段声明来源优先级，CN/美股特例成为来源编排而非 if 分支。
- `lib/snapshot-service.js` → `engine/quote-engine.js`：拆出纯函数 `domain/merge.js`（getCachedQuote 的 60 行合并、mergeEnrichment 的 45 行），状态只剩 Map 存取与调度。
- `lib/quote-cache.js` → 并入 cached-resource + SWR 修复。
- `lib/yahoo.js` → `sources/yahoo.js`（网关队列保留，breaker 换统一实现）+ `engine/fx-service.js`。
- `public/app.js`（374 行上帝文件）→ `web/store.js` + 现有 18 个模块重新归位为 views。
- `lib/http.js` → `api/router.js`（路由表化）+ `api/sse.js`。
- 前端心跳/看门狗 → `web/scheduler.js`（保留 Worker + 看门狗语义，接口对齐 store）。

**删除（不再复活）/ Delete (never resurrect)**：
- 所有模块级 `defaultService` 实例与 `initXxx`、`initHttp`、`initTransport`、`__upstream`。
- `lib/transport.js` 的双 transport 套娃。
- `lib/http.js` 末尾 legacy adapter（import 即建 Server）。
- check 脚本加静态规则：`engine/ sources/ domain/ api/` 内禁止模块级 `create*` 调用、禁止 `process.env`。
- All module-level default instances, `initXxx`, the nested-transport fallback, the import-time HTTP server. A static check rule bans their return.

## 2.5 阶段划分 / Phases（每阶段独立可验收 / independently acceptable）

**Phase 0 — 契约冻结与骨架（1-2 天）**
- 从 v72 提取 golden API 契约测试（用现有 fixture + 录制的典型响应）。
- 新仓库骨架：`domain/ sources/ engine/ api/ web/ ops/ tests/`，check/test/build 脚本就位（沿用 v72 的脚本形态）。
- Freeze golden API contracts from v72; scaffold the new repo; scripts in place.
- 验收 / Done：契约测试在 v72 上全部通过（证明契约正确），在空 v2 上全部失败（证明测试有效）。

**Phase 1 — domain 层（2-3 天）**
- instruments、sessions、calendar、quote-contract、freshness、currency、merge、units。
- 全部纯函数 + 表驱动测试；`now` 注入。
- 验收 / Done：domain 测试覆盖 v72 对应模块的全部断言点；`grep -r "Date.now()\|process.env\|readFileSync" domain/` 为零。

**Phase 2 — sources 层（3-4 天）**
- 顺序：tencent → naver → eastmoney → sina → nasdaq → yahoo（含网关队列）→ alpaca（WS）→ official-rss → ecb/frankfurter。
- 每源：adapter + fixture 契约测试 + 注册表声明（间隔/延迟/推送/批量）。
- 验收 / Done：每源 fixture 测试通过；注册表可回答"某 symbol 的全部可用源及其节奏"。

**Phase 3 — engine 层（3-4 天）**
- cached-resource 原语 → host-breaker → scheduler（会话调频）→ quote-engine（含 SWR 修复、merge 纯函数接入）→ fx-service → history（多源可插拔 + 聚合缓存）→ news/macro → recovery（移植）。
- 验收 / Done：v72 的 snapshot/realtime/redundancy 语义测试在新引擎上全部重现通过；内存与 CPU 基准不劣于 v72（记录对比数据进 commit）。

**Phase 4 — api 层（2 天）**
- router（路由表化）→ admission（含 TRUST_PROXY 文档化）→ SSE 网关（/api/stream，30s 心跳，独立连接配额）→ 静态服务（brotli）。
- 验收 / Done：Phase 0 契约测试全绿；SSE 事件流测试（连接、增量、断线）；/api/market 保留可用。

**Phase 5 — web 层（3-4 天）**
- store + views 重构；SSE 客户端（EventSource，失败回退 2s 轮询）；折叠面板懒加载；骨架屏；realtimeStatus 渲染；搜索合并；顶栏汇总状态。
- 验收 / Done：v72 前端沙箱测试的等价用例全绿；六种视口无横向溢出；Playwright e2e（离线/正常/WS 断开三态）。

**Phase 6 — 部署切换（1 天 + 观察期）**
- v2 与 v72 并行部署（不同端口/不同隧道主机名）；切 10% 自用流量观察 48h；`verify_all.sh` 等价门禁通过后全量切换；v72 保留一个版本周期作回退。
- Parallel deploy, shadow traffic, 48 h soak, then cut over; keep v72 one release cycle as rollback.
- 验收 / Done：线上 48h 内 SSE 连接稳定率、报价年龄分布、上游 429 次数三项指标不劣于 v72。

**总计 / Total**：约 14-19 个工作日 + 48h 观察期。/ ~14–19 working days plus soak.

## 2.6 测试策略 / Test strategy

1. **契约测试**（golden JSON）：API 层 100% 覆盖 Part 1 的对外行为。
2. **fixture 契约**：每个 source adapter 对录制响应的解析测试（含畸形/空值/字段漂移样本）。
3. **纯函数表驱动**：domain 层每个函数一张用例表。
4. **时序测试**：沿用 v72 的可注入 `now` 与 vm 沙箱模式（`tests/_harness.mjs` 的思路带走，形态清理）。
5. **e2e**：Playwright 三态（正常/离线/WS 断开）+ 六视口。
6. **基准**：history 聚合 p95、2s 快照序列化次数（SSE 后应为 0/客户端）、冷启动 RSS。
Golden API contracts; per-source fixture contracts; table-driven domain tests; injected-clock timing tests (keep the vm-sandbox idea, clean the shape); Playwright three-state e2e; benchmarks for aggregation p95, per-client serializations (target 0 polling after SSE), cold-start RSS.

## 2.7 风险与缓解 / Risks & mitigations

| 风险 Risk | 缓解 Mitigation |
|---|---|
| 第二系统效应（重写膨胀） | Part 1 清单即范围边界；不在清单内的不做；Phase 门禁卡死 / the inventory is the scope fence; phase gates enforce it |
| 重写期间 v72 出线上事故 | v72 不动、继续运行；v2 并行部署 / v72 stays live; v2 deploys in parallel |
| 契约冻结遗漏字段导致前端回归 | Phase 0 的契约测试必须先在 v72 上跑绿；遗漏即补契约 / contracts must pass on v72 first; misses get added |
| 上游端点在重构期间失效（腾讯/Naver 改字段） | fixture 契约 + 源健康面板先上线（Phase 2/4 即可用），与重写解耦 / fixtures + health surface land early, decoupled from the rewrite |
| SSE 在 cloudflared 下被缓冲 | Phase 4 验收必须过真实隧道（cloudflared 支持 SSE，但要在切换前实测）/ verify SSE through the real tunnel before cutover |

## 2.8 非目标 / Non-goals

1. 不引入框架（前端/后端）、TypeScript、数据库、Redis。/ No frameworks, no TypeScript, no database, no Redis.
2. 不做用户系统/多租户/收费。/ No accounts, multi-tenancy, or billing.
3. 不追求美股全市场实时（SIP 收费）。/ No full-market US realtime (SIP is paid).
4. 不做移动端原生 App。/ No native apps.
5. 不在本次重构中扩大自选上限 12。/ The 12-symbol watchlist cap stays.

---

## 交接说明 / Handoff note

本计划与 `REVIEW-PLAN.md`（v72 修补版）二选一执行，不要并行。若选择本重构计划，REVIEW-PLAN 中只有两项值得先在 v72 上落地（因为它们是线上风险且独立于重构）：**A3 限流身份坍塌修复**（改一行配置 + 文档）与 **C5 折叠面板停止轮询**（省上游配额）。其余一律在新代码库中实现。
Execute this plan OR `REVIEW-PLAN.md` (v72 patching), not both. If rebuilding, only two review items deserve landing on v72 first (they are live risks independent of the rebuild): **A3 admission identity fix** (one config line + docs) and **C5 stop polling collapsed panels** (saves upstream quota). Everything else is implemented in the new codebase.
