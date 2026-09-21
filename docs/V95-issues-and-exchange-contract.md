# v95 已知问题、复现与接口设计

本清单在实现前建立（2026-09-21）。范围为用户报告的过期新闻、科乐美搜索、来源轮询及行情 API 输出语义；不将有限审计描述为所有市场和全部上游永久无故障。

| 问题 | 已确认的复现 | 修复验收要求 |
| --- | --- | --- |
| 个股旧新闻冒充最新结果 | AAOI 模拟五月、八月 Yahoo 新闻仍返回且 stale=false | 所有出口采用原始发布时间滚动 7 天，未知时间/未来时间不显示 |
| 缓存跨界及获取失败保留旧文 | news cache/peek、HTTP、v1/v2 与前端无统一时效约束 | 获取、恢复、读取、投影、渲染均复核；失败不能恢复旧文 |
| 宏观时效不一致 | 官方公告允许 29 天；合并报告可改变原文日期 | 同样 7 天；保留原始文章发布时间与获取时间 |
| 新闻出处与关联不清 | Google 统一署名；SPY 命中艺术/游戏/跑分文章 | 真实发布者与文章链接、关联证据；不以短代码单独证明证券关联 |
| 科乐美及同类日股无法搜索 | 科乐美/Konami/9766/9766.T 本地全空，中文查询不走 Yahoo | JPX 普通股票目录、多语言名称和规范代码，源失败有状态 |
| 来源饥饿及恢复失败 | history 主源失败一次后 12 分钟仅访问备用 12 次 | 有界轮询，尊重缓存/冷却，主源恢复有机会被检测 |
| 财务/宏观/历史备用源永久跳过 | 主源健康即短路或续期备用粘性时间 | 到期来源重新检查，保留质量择优与序列连续性 |
| 清空缓存竞态 | 在途请求可在 reset 后回填 | 代际隔离，清空前结果不能重新写回 |
| API 新闻旁路与缓存响应头 | formatter 仅检查标题；CORS 的 Vary 覆盖 Authorization | 统一新闻质量契约，合并 Vary，带真实 CORS 的 HTTP 回归 |
| 最新获取掩盖异常成交时间 | 未来/未知 quoteAt 在 sourceCheckedAt 新鲜时可 ready | 明确 partial 与机器可读原因，不伪造成交时间 |

## 官方规范对照与适用边界

- [NYSE 市场数据技术规范](https://www.nyse.com/market-data/technical-documents)：成交、BBO、深度及统计是不同数据产品。QQQSP 保留独立 quote/order_book/历史分区，盘口单独标明时间、数量单位和覆盖范围。
- [Nasdaq Last Sale 3.0](https://nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NLSSpecification3.0.pdf)：原始成交消息具备事件类型、时间和源标识。本项目接收聚合供应商快照，没有完整逐笔成交/撤销更正消息，因此不构造交易 ID 或交易所序号。
- [Binance 官方市场数据 REST](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)：成交、盘口、K 线与统计分开；统计窗口、单位、游标有明确语义。此处借鉴契约组织，不把加密资产格式视为股票交易所统一标准。

## 请求至输出的分层

`HTTP 鉴权/额度/正文限制 → query 参数与 scope 校验 → service 有限队列/时间预算 → 供应商适配及缓存 → 纯函数投影 → JSON Schema/OpenAPI → 客户端展示`

1. 鉴权在 ETag 判断之前；GET/HEAD 可 304，POST 不返回 304；受保护数据 private/no-cache 或 no-store，Vary 同时保留 Authorization 与 Origin。
2. quote 是最新价格快照，order_book 是独立最优一档；没有逐笔成交 ID、全盘口深度、交易所增量序号就明确不可提供。SSE ID 仅属本次连接，重连发送新快照，不承诺补齐中间变化。
3. `quote_at_ms` 是供应商事件时间；`observed_at_ms` 是观察时间；`source_checked_at_ms` 是成功检查时间；`generated_at_ms` 是响应生成时间。日线 UTC 日期标签不等于成交时间。
4. 历史续页沿用排他 `next_before` 与 `series_id`；更换源不静默拼接。币种、成交量单位、复权口径和时段不可从另一个市场猜测。
5. 新闻不是交易所行情的一部分，保持独立分区。来源订阅元数据可追溯不等于独立事实核查；无合格近期文章时返回空数组及原因，不编造新闻。
6. `null` 表示缺失/不适用，状态与 missing_reason 解释原因；数字保持现有 JSON number 兼容性，不声称保留原始十进制定点精度、tick size 或 lot size。
7. 公共数据源与授权数据源能力分别声明。没有配置授权源时，不声称具备 SIP 全市场最优盘口、实时全市场逐笔、完整复权历史或全球股票容灾。

新增回归均先在旧逻辑运行并记录失败，再修复。最终运行记录在交付验收文件中更新。
