# QQQSP Market-Context API 改进计划

> 基准：v92（2026-09-19）。对标 Alpha Vantage（130+ 端点）、SEC EDGAR data API、Polygon/交易所级 REST 规范。
> 原则：**新参数一律可选，默认行为与 v92 完全一致**；include 枚举只增不改；破坏性变更才升 schema_version。

## 0. 已达标且领先的能力（保持，不要退化）

- 字段级元数据：`as_of_ms` / `source_checked_at_ms` / `delay_minutes` / `missing_reason` / 单位与适用性
- 缺口保留不插值、null 不折零、亏损/不适用不改零
- 文档矩阵：OpenAPI + JSON Schema + llms.txt + tool.json + 字段指南
- `request_id` / `schema_version` / `sources` / `quality` / 顶层 complete|partial
- 严格参数校验（未知参数 400）、结构化错误码、429 + Retry-After
- 独立采样观测（samples 分区，独有特色）
- 日线游标分页（`daily_before` / `daily_series_id`，v92 新增）

---

## P0 — 高优先级（数据可信度的根基）

### 1. 复权口径切换
- **设计**：请求参数 `adjustment: "raw" | "split" | "split_dividend"`（缺省维持现状）；daily 增加 `adjusted_close` 列，coverage.adjustment 从 `*-unverified` 升级为可核验口径名。
- **验收**：任一 symbol 在已知拆股日前后，`raw` 与 `split` 两口径价格比 == 拆股比例；未复权区间两口径输出一致。

### 2. 公司行动端点
- **设计**：新分区 `corporate_actions`（或独立端点），返回事件表：type（split/dividend）、ex_date、ratio / 金额、币种、source_id、as_of。
- **派生**：fundamentals 缺失的 `dividendTTM` / `dividendYieldTTM` 可由事件表计算补齐，并标 `calculated: true` + formula。
- **验收**：NVDA 2024-07-10（4:1）拆股事件存在且日线连续性可复算。

### 3. 限流配额头
- **设计**：成功响应增加 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`（滚动 60s 窗口口径）；429 保持 Retry-After。
- **验收**：连续调用可见 Remaining 递减，窗口滚动后恢复；与 20/分钟文档一致。

### 4. 周线 / 月线
- **设计**：daily 分区参数 `daily_granularity: "daily"(默认) | "weekly" | "monthly"`，服务端由日线聚合；明示聚合规则（周=该周最后交易日，O=周首日开、H/L=区间极值、C=末日收、V=求和；月同）。
- **验收**：weekly close == 该周最后交易日 daily close；行数 = 周期数。

---

## P1 — 中优先级（可用性）

### 5. 日内历史查询
- **设计**：intraday 参数 `intraday_before`（游标，风格与 daily 一致）或 `intraday_month: "YYYY-MM"`；仅返回来源已有数据，缺口保留，coverage 声明范围。
- **验收**：能取到上周五（2026-09-18）的分时；越界日期返回明确 missing_reason 而非空 rows。

### 6. 分钟 OHLCV 聚合
- **设计**：参数 `aggregate_minutes: 1(默认) | 5 | 15 | 30 | 60`；由分时/采样聚合出 open(首价)/high(极值)/low(极值)/close(末价)；volume 无可靠数据时整列 null 并在 column_descriptions 声明。
- **说明**：这就是客户端绘制 K 线时手工做的事（15min 桶聚合），服务端化后可复现、可审计。
- **验收**：15min 桶的 O/H/L/C 与 samples 原始点逐桶复算一致；空桶保留。

### 7. 市场状态 / 交易日历
- **设计**：`GET /api/v1/market-status?exchange=US` → open/closed、当前 session（PRE/REGULAR/POST）、下次开市时间；`GET /api/v1/trading-calendar` → 节假日、半日市。宏观分区的事件日历定位不变。
- **验收**：周六查询返回 closed + 下次开市为周一 09:30 ET。

### 8. 批量 / 多代码
- **设计**：`symbols: [...]`（上限 10）仅支持 quote / fundamentals 分区；响应按 symbol 数组返回，每项独立 status/coverage；限流按批内 symbol 数计数。
- **验收**：3 只股票批量 = 3 次配额；单只失败不影响其余（partial）。

### 9. 密钥管理
- **设计**：多密钥、轮换（新密钥生效后旧密钥 24h 宽限期）、scopes（quote-only / history / macro）；管理走私有面板，不进只读 API。
- **验收**：旧密钥宽限期内 401 前有明确 error.code（如 KEY_ROTATED）。

---

## P2 — 低优先级（锦上添花）

### 10. 条件请求：`ETag` + `If-None-Match` → 304，缓存友好
### 11. CSV 输出：`format` 枚举扩展 `"csv"`（时序分区按 columns 输出表头）
### 12. 涨跌幅榜：`GET /api/v1/movers?market=us&range=1d&top=10`（涨/跌/活跃）
### 13. 弃用策略：响应头 `Deprecation` / `Sunset`（RFC 8594）；schema_version 变更在 llms.txt 公告
### 14. SSE 流式（可选）：仅 quote 分区的事件推送；WebSocket 不做（单执行队列架构不适配）
### 15. 技术指标：**建议不做**，保持只读数据 API 纯度；指标由客户端（Node/Python）计算——现有 market-context-client.mjs 路线

---

## 实施顺序建议

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| v93 | P0 全部（#1–#4） | 补齐可信度根基，工作量可控 |
| v94 | P1 的 #5–#7 | 历史与日历补全 |
| v95 | P1 的 #8–#9 + P2 按需 | 规模化与治理 |

## 每项通用验收底线

1. 新参数进 OpenAPI / JSON Schema / llms.txt 三处同步
2. 未知/越界值仍返回 `BAD_CONTEXT_QUERY` 风格结构化错误
3. 分区 coverage 仍声明口径、时点、缺口，无静默截断
4. 压缩前 2 MiB / 请求体 8 KiB 上限语义不变
