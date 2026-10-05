# QQQSP K线、五日缓存及盘口修复

日期：2026-10-02（北京时间）。
本次先完成诊断和详细计划，再执行修改及部署。图表修复发布版本为 v113；随后根据“旧面板未更新”反馈补发 v114，详见 [更新链路修复](PANEL-UPDATE-REPAIR-2026-10-02.md)。公网入口为 https://qqqsp.avalon-izumi.online/ 。原有未提交的后端修复全部保留；未执行 Git 提交或推送。下方保留v113图表修复的验收记录。

## 原因与执行计划

| 问题 | 已核实原因 | 实施内容 | 验收要点 |
|---|---|---|---|
| 一日、五日没有蜡烛影线 | 图形类型由周期推断，intraday 被固定为折线；fiveDay 又映射为 intraday | 独立 chartStyle，真实 OHLC 默认蜡烛；价格点和报价采样禁用蜡烛 | 高低影线按原始 h/l，十字星，最新报价独立点 |
| 日K细小、选项不醒目 | 窄卡片固定柱数、1px影线；昨收等基准扩大纵轴 | 自适应柱密度、增加绘图区、增强影线和控件；K线纵轴按可见 OHLC/均线 | 窄屏柱宽、上下影线、涨跌颜色、切换按钮选中态 |
| 五日每次重开冷启动 | 切换、关闭和失败会清空前端；后端2分钟过期后同步等待；与逐笔 Promise.all 耦合 | 前端按身份保留；后端缓存立即返回并后台更新；磁盘恢复；拆分图表/市场请求 | 重开即显、过期先显、失败保图、关闭不取消采集、重启和跨日隔离 |
| 五日降级为一天价格点 | 生产验收发现 Naver 每页右边界返回截断柱，与下一页完整柱冲突，导致整个来源被放弃 | 按每页半开区间 [from,to) 合并，保留页内冲突校验 | NVDA 五日恢复390根真实OHLC；QQQ五日389根，来源少一根不补造 |
| 报价下方文字拥挤 | updateQuoteMeta 拼接多个内部诊断字段 | 下方仅保留报价年龄；清空冗长来源检查/轮询/排队文案 | 本地页面已确认报价年龄显示 |
| 逐笔无法辨认方向 | 源未提供主动方向；前端固定“方向未知” | 时间、价格、股数、方向分列；有明确验证字段才显示主动买卖，否则仅显示涨价/跌价/平价推断 | 同秒未知，跨证券/来源/日期不混推断，更正撤销不纳入统计 |
| 美股盘口几乎为空 | 现有美股盘口主要来自需凭证的 Alpaca，Nasdaq 逐笔不能产生买卖价 | 增加 Nasdaq 公开盘口适配器；有效报价盘口优先，公开盘口补充；独立缓存及限流 | 真实 bid/ask，身份/币种匹配，未知盘口时间保留 null，N/A 不造值 |

## 缓存行为

- 五日内存缓存：2 分钟新鲜期，7 天保留期，30 条或 8 MiB 上限，按证券、市场、币种、品种及五个交易日窗口区分。
- 过期立即返回已有数据，同时去重刷新；失败保留旧图及原始 sourceCheckedAt，增加 stale/refreshError/retryAt。
- 关闭浏览器请求只取消等待者；后台任务继续，直到完成、服务期限到达或应用关闭。
- 状态文件：HISTORY_STATE_PATH + '.five-day.json'。空路径禁用持久化。原子写入；恢复校验身份、日期、OHLC、时间及容量。
- /api/chart/detail 支持 sections=chart|market|all；缺省 all 兼容既有调用。前端五日请求 sections=chart，盘口和逐笔请求 sections=market。
- 前端最多保留30份五日结果，24小时内按证券、币种、图表交易日复用；恢复旧值显示缓存待更新，不改写来源时间。

## 公开盘口与逐笔的证据边界

已实测公开端点：

1. Nasdaq /api/quote/NVDA/info?assetclass=stocks 和 /summary：HTTP 200，当前休市，买卖价与数量均为 N/A。
2. Naver /stock/NVDA.O/basic 及 worldstock 实时端点：能读到成交价与时间，未发现 bid/ask 字段。
3. CNBC quick/extended quote：HTTP 200，已检查的响应为成交及盘前盘后字段，没有可用 bid/ask。
4. Yahoo 本机直连返回403地域限制，未作为已经可用的盘口来源。

Nasdaq 官方公开功能说明：
https://www.nasdaq.com/articles/empowering-retail-investors:-free-access-to-real-time-bid-and-ask-data-added-to-nasdaq.com

新增 nasdaq-public-book 使用公开 /info 中的 bidPrice/askPrice/bidSize/askSize。
该接口未给出可核验的独立盘口时间、数量单位和市场覆盖，因此返回 partial，asOf=null，timeBasis=source-snapshot-time-unavailable；checkedAt 只表示实际读取时间。不能把 lastTradeTimestamp 当作盘口时间，不能把数据称为 NBBO 或完整盘口。已有真实值在后续 N/A/失败时短期保留并明确标记旧快照；目前休市实测仍然为空，不能声称已经恢复当前实盘买卖价。

公开逐笔没有主动买卖标记。方向模块只对明确提供 aggressorSide 且 aggressorSideVerified=true 的事件显示“主动买入/主动卖出”。其余价格变化显示为推断，不解释为真实买卖订单方向。

## 验证记录

- 发布前70项聚焦回归通过，覆盖已有后端修改及本次蜡烛、缓存、盘口、逐笔功能。
- chart-regression 的旧请求次数断言与已有“日线先取近期、长周期再补齐”的策略不一致；改为校验各周期覆盖、分页边界及缓存重读，6/6通过，未修改业务代码来迁就断言。
- Naver分页边界新增2项回归，连同来源优先级及证券身份测试17/17通过；最终边界与缓存相邻检查10/10通过。
- npm run build、npm run check通过：541项脚本及资源/配置一致性检查；18项shell LF检查。服务器对发布包内shell执行bash -n通过。未运行全量测试。
- 生产真实接口：NVDA来源naver-world-chart，5个交易日、390根完整OHLC、390根有影线；QQQ为5天389根、388根有影线，9月28日来源77根。保留收盘成交覆盖未核验标记。
- 五日恢复旧缓存时立即返回stale/refreshing；后台完成后回读为cached=true、stale=false、refreshing=false，保留真实sourceCheckedAt。共享磁盘缓存已更新，权限600，属主qqqsp:qqqsp。
- 浏览器通过SSH本地转发访问真正的生产v113，确认一日/五日蜡烛、影线、均线、全览、报价年龄、逐笔方向，以及关闭重开五日立即复用缓存。PNG导出成功。公网IAB导航超时，因此公网浏览器视觉验收不计为通过。
- 新域名公网首页、bundle、CSS、SW均HTTP200且SHA与本地发布包一致；合法刷新Origin/CORS正常；标准Node客户端认证market-context返回HTTP200。Python urllib默认客户端被Cloudflare 1010拒绝，未修改安全设置。
- 最终本机readyz：version=113、ready=true、dataReady=true；14个核心证券全部ok。市场上下文整体仍partial：基本面/宏观部分缺失，并保留source_adjustment_unverified。

一日与五日真实生产图表截图属于内部验证材料，未随仓库发布。它们与先前的合成样例分开保存，未用合成数据替换真实行情。

## 发布与公网入口

- 当前发布：/opt/qqqsp-v2/releases/20261002T033749Z-v113。
- 回退版本：/opt/qqqsp-v2/releases/20261002T032747Z-v112；v111也保留。
- 本轮备份：/opt/qqqsp-v2/backups/20261002T033749Z-v113；最初v111配置/状态备份位于20261002T032747Z-v112。
- 发布包255个文件逐一校验；.env、密钥、API-key状态、共享状态/日志、自选、服务权限和隧道配置均保留；服务active/enabled、UMask=0077。
- 旧域名digital-reality.shop的权威DNS指向停放服务，注册商RDAP显示到期日期2026-09-27；用户决定改用qqqsp.avalon-izumi.online。
- 新域名的Cloudflare CNAME代理、nginx和PUBLIC_ORIGIN本来已配置正确，本轮复用现有配置并完成公网验收，没有重复改写DNS或隧道。工作区AGENTS.md的市场上下文入口已更新。
- 换域名后浏览器本地自选/缓存按Origin隔离；服务器缓存仍共享。公开盘口当前休市返回N/A，无法把“适配器接入成功”当成“盘中实时盘口已验证”。逐笔涨跌方向仍为推断，非真实主动买卖。

## 主要文件

- public/modules/panel-chart-engine.js、panel-chart-controller.js、panel-chart-detail.js、panel-timeframes.js
- public/modules/panel-card-view.js、panel-trade-direction.js、public/style.css
- lib/chart-detail-service.js、lib/providers/nasdaq-public-book.js、lib/order-book.js、lib/http.js、app.js
- tests/v2/chart-candles.test.mjs、chart-detail-cache.test.mjs、public-book.test.mjs、panel-trade-direction.test.mjs、panel-public-tape.test.mjs

发布和缓存落盘已完成。仍待实际交易时段验证公开源买卖报价覆盖；工作区改动未提交或推送。
