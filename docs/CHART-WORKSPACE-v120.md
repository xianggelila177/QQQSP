# v120 图表工作台更新

2026-10-05。已完成实现、构建、有限验收及生产部署。本次发布包含图表工作台，以及此前已完成并验证的后端性能、缓存与数据边界修复；没有重置已有代码或清理用户浏览器存储。

## 官方图表研究与采用理由

| 对象 | 从官方资料归纳的优点 | 本站实现 |
|---|---|---|
| 嘉信 thinkorswim | 常用绘图就近调用，分析结果能留在图上。[绘图指南](https://www.schwab.com/learn/story/7-basic-thinkorswim-desktop-chart-drawing-tools) | 水平线、两点趋势线、区间测量，撤销与清空；绘图按证券和数据身份保存。 |
| 盈透 IBKR | 图表粒度、显示范围和研究工具分开，价格读数位置稳定。[Desktop 图表指南](https://www.ibkrguides.com/ibkrdesktop/charts-summary.htm)、[Advanced Chart](https://www.ibkrguides.com/traderworkstation/advanced-chart.htm) | 周期之外另设 30 / 90 / 180 根、全部已加载范围；固定 OHLC 和指标读数，盘口侧栏可折叠。 |
| Fidelity Trader+ | 定制图表和保存工作习惯有明确入口。[Web 图表教程](https://www.fidelity.com/learning-center/trading-investing/trading-platforms/how-to-customize-charts-trader-plus-web) | 卡片和详情共用设置，当前页面立即同步，本地保存并跨刷新恢复。 |
| CME、Nasdaq | 图表工具与数据观察分区，主图保留主要空间；对可用数据使用独立层。[CME 官方指南](https://www.cmegroup.com/education/files/cme-institute-trading-simulator-guide.pdf)、[Nasdaq 图表](https://www.nasdaq.com/market-activity/quotes/advanced-charting) | 主图、成交量、RSI 分区；来源与覆盖说明独立保留，缺少盘口和逐笔时继续显示真实缺失原因。 |
| TradingView（补充） | 刻度模式、图表设置和绘图管理语义清楚。[图表设置](https://www.tradingview.com/support/solutions/43000748166-how-to-configure-your-supercharts/) | 线性、百分比、对数价格轴；百分比注明可见首根收盘基准，无效基准或非正价格时解释回退。 |

研究基于官方指南、教学和公开图示，未登录券商平台操作，也未对各券商性能排名。详细研究笔记属于内部验证材料，未随仓库发布；可公开核查的官方资料入口见上表。官方图片未作为本站发布资产。

## 实现与算法选择

- 保留 Canvas 内核和独立光标层，增加独立绘图层；未引入图表运行时依赖。
- 设置覆盖 MA5/10/20、EMA20、BOLL20/2、RSI14、成交量开关与价格轴。卡片、详情和新增卡片保持一致；存储不可用或配额耗尽时保留当前会话设置。
- SMA 使用滚动均值；BOLL 使用滚动方差并定期重新居中，降低高价格偏移时的数值误差；EMA20 以 20 点 SMA 初始化、α=2/21；RSI14 使用 Wilder 平滑，完全平盘约定 50。缺失值重启预热，不补零。加载更早历史可能改变 EMA/RSI 种子，不宣称和所有券商逐点一致。
- 指标计算为 O(n)，按数据数组、版本和启用设置缓存；拖动、缩放或移动光标重用结果。回归验证了线性读数和缓存复用；没有进行生产性能压测。
- 绘图存储时间戳与原币价格，使用统一正反坐标变换，随平移缩放重新投影。按证券、周期、币种、来源、序列、复权与价格比例隔离；最多 30 组身份、每组 50 个绘图。测量显示已加载观测根数与自然时间，不把缺失日期当成真实交易日。
- 手机默认竖屏，提供显式横向与全屏操作。窄屏工具栏换行，短横屏正文独立滚动以容纳副图，头尾操作保持可达。
- 固定读数支持指针和键盘；方向键浏览、加减缩放、L 跟随最新、Esc 退出绘图或关闭详情。PNG 导出包含主图、绘图与光标。

## 数据边界修复

1. 五日图周期采用自身 `intervalSeconds` / `resolution`，避免把一分钟柱按当天五分钟间隔定位。
2. 五日来源失败的后端回退保留实际周期和复权元数据，不再硬编码 5m；不会推进来源检查时间。
3. 未声明周期时显示有说明的收盘线，不虚构分钟粒度。
4. 字符串复权信息纳入绘图身份；币种或交易日变化后清除不匹配五日视图、取消草稿并重新加载。
5. 实时报价与历史柱同时间时，历史绘图锚点仍落在真实柱中心。

继续保持真实 OHLC 才能绘制蜡烛，盘前盘后标题报价与常规交易图分开。来源不完整、复权未确认和盘口缺失不会由界面功能消除。

## 验证结果

| 验证 | 结果 |
|---|---|
| 新功能与数据边界测试 | 新增 37 项全部通过 |
| 新增及邻近测试组合 | 94 / 94，通过引擎、卡片/详情入口、历史分页、来源回退及服务边界 |
| 实际浏览器 | 独立无头 Edge，1440×1000、390×844、320×740、844×390 全部通过，无脚本错误及水平溢出 |
| 浏览器交互 | 共享设置、画线、测量、快捷键、范围切换、关闭焦点恢复、竖屏旋转与恢复通过；320px / 矮横屏实际滚动后 RSI 可见 |
| 构建 | `npm run build` 通过，36 个输入模块；同步版本、bundle、预压缩资源 |
| 工程检查 | `npm run check` 通过，587 个脚本语法及版本/构建/配置一致性；19 个 Shell 文件 LF 检查通过，Windows 上未执行 Bash 语法检查 |
| 差异检查 | `git diff --check` 通过 |

浏览器使用生产 UI 工厂与合成行情，所有截图均为离线测试数据，不是实时报价或线上验收。图表 bundle 原始体积从 302,292 增至 337,205 字节（增加 34,913 字节）；整体构建的静态资源 Brotli 合计为 109,473 字节。这些是构建体积，不代表线上首屏耗时。

没有运行全站完整测试。额外触及的旧 `panel-audit-chart-repairs.test.mjs` 有 3 项既有失败，改动前快照可完全复现：两个夹具缺少 `PANEL_DETAIL_DIALOG`，一个五日状态旧预期 ready / 实际 partial。未将这些旧失败计入 94 项通过结果，也未修改断言掩盖它们。

## 生产部署与真实在线验证

2026-10-05 已部署 v120。以下来自部署后的真实应用检查，与上面的离线合成行情验收分别记录：

| 项目 | 实际结果 |
|---|---|
| 服务器暂存验证 | Node.js 24.19.0，58 / 58 新增后端回归通过；606 项脚本语法与工程一致性检查通过，包含 19 项 Bash 语法检查 |
| 公开静态资源 | HTML、bundle v120、CSS v120、Service Worker、更新脚本均 HTTP 200，摘要与本地构建一致 |
| 应用及数据就绪 | 07:20:15 UTC 最后复查：version=120、ready=true、dataReady=true；13 项持久自选均非 stale，常规图有真实数据且交易日匹配 |
| 真实线上浏览器 | 1440×1000 桌面、390×844 手机通过；控制页面的 Service Worker 为 v120，无脚本或控制台错误、无水平溢出 |
| 工作台交互 | NVDA 真实日 K 79 根；EMA20、RSI14、BOLL、百分比轴、共享设置、详情与保存水平线通过 |
| 状态保留 | 既有配置、密钥状态、自选、共享数据、服务权限和隧道保留；没有清理旧版本或浏览器存储 |

就绪不代表所有来源完整。NVDA 市场上下文仍为 `partial`：报价、分时、日线、采样和资讯 ready，基本面及宏观 partial；五日图有 390 根真实五分钟数据，保留来源复权未确认说明。部分美股常规图仍标记收盘成交覆盖待核验，不能因非 stale 就声称覆盖完整。161128.SZ 日 K 已 ready，但最后复查的周/月/年缓存仍 stale、来源窗口不足，该限制未在本次发布中修复。

以上均为该次验收时点的结果，不保证上游之后持续可用。本次没有运行全仓完整测试，既有失败及来源边界继续保留。

## 文件与验收材料

核心改动：`public/modules/panel-chart-{studies,workspace,drawings,engine,detail,controller}.js`、`panel-card-view.js`、`public/style.css`、`lib/chart-detail-service.js`、`scripts/build-static.mjs`，以及版本与构建资源。

基线、红绿证据、检查日志及截图属于内部验证材料，未随仓库发布。以下文件名用于说明材料范围，不是仓库下载入口：

- `baseline/`：本次更新前相关文件；`git-status-before.txt`：既有工作区改动清单。
- `focused-tests.txt`、`build.txt`、`check.txt`、`browser-check.txt`。
- `evidence/browser-results.json` 与 `evidence/workspace-*.png`。
- `detail-identity-red.txt`、`source-fallback-red.txt`、`unknown-interval-red.txt` 及对应通过日志。

本次未加入多图同步、下单、自动买卖信号、自定义指标参数或未经确认的事件图层；已有绘图支持撤销/清空，尚无拖动修改已保存锚点功能。没有新增行情数据授权。
