# v91 费城半导体指数/ETF 修复与自选扩容

## 原因与处理

**SOXX（费城半导体 ETF）加载失败**：能取得报价，但被当成普通股票走股票历史接口。已按目录核验身份（iShares Semiconductor ETF，`SOXX.O`，NASDAQ，来源 iShares / Nasdaq / Naver，2026-09-18 核验），改走 ETF 历史接口；身份不再依赖先取得报价。

**^SOX（费城半导体指数）加载失败**：此前只依赖正在限流的 Yahoo。已接入已核验的 Naver `.SOX` 指数路由（NASDAQ、America/New_York 时区、USD、按点位显示），保留 Yahoo 备用路径；失败指数按符号独立恢复，健康指数的采集节奏不受同伴失败影响。

**自选上限 12 → 100**：前端、自选保存接口、后台采样原先分别写死 12。统一到 `lib/watchlist-limits.js`（`MAX_WATCHLIST_SYMBOLS=100`），采样留存证券上限 200、默认采样预算 96MiB；移出自选的留存采样在空间不足时优先回收，不阻断现役标的。

**大名单推送隐患**：100 只标的一次推送的图表可能超过单帧上限导致反复重连。SSE 改为按符号分批排队推送、按 drain 事件调度并受帧预算约束；前端请求 URL 的版本提示参数改为 percent-encode，超过代理请求行预算时省略提示但不截断成员；新闻按 12 只一批串行请求，避免突发压垮上游。

## 验证

- 新增 `tests/v2/semiconductor.test.mjs`、`tests/v2/watchlist-capacity.test.mjs`：SOX/SOXX 报价与历史、Yahoo 429 恢复、指数失败不拖累同伴、100 只保存/重启恢复/后台采样/留存回收、单帧预算与 100 只大快照推送。
- 核心测试 378 项通过；保留回归 91 个文件通过、43 个按迁移清单退役。
- 浏览器：半导体与扩容场景在 Chromium、WebKit 均通过；全套 63 项端到端中 62 项一次通过，1 项（identity conflict 分钟刷新）修复其预热竞态后单独复跑通过。
- 旧上限断言同步到新边界（第 101 只拒绝）；修复 v88 以来两个预存测试缺陷（real-application 未打桩 fundamentals 上游；journeys 宏观与历史用例在并发下的时序竞态）。
- 服务器候选实测：两者分时与四种 K 线均返回，SOXX 识别为 ETF；100 只自选保存、重启恢复、后台采样与大图表分批推送均验证。
- 发布后公开接口实测：`^SOX` 报价 11921.69 点（naver-index、USD、休市状态正确），分时 391 点，日/周/月/年 K 线分别 79/79/33/3 根；SOXX 报价 532.02（naver-us、ETF），分时 945 点，日/周/月/年 K 线 79/79/79/11 根。

## 发布与回退

现行版本：`/opt/qqqsp-v2/releases/20260919-semi-v91`，软件版本 `2.11.2`。

上一版：`/opt/qqqsp-v2/releases/20260917-nikkei-v90`，`/opt/qqqsp-v2/previous` 指向该版本。

上线前状态备份：`/opt/qqqsp-v2/backups/pre-semi-v91-state.tar.gz`。发布采用锁、原版本文件校验、原子切换和失败自动回退；只重启 `qqqsp-v2.service`。健康检查：readyz 版本 91、`^SOX` 经 naver-index 报价（USD、INDEX）、SOXX 报价且类型为 ETF、SOXX 周 K 历史可用；任一不满足自动回退到 v90。

身份与价格交叉核验：[PHLX Semiconductor Index](https://indexes.nasdaqomx.com/Index/Overview/SOX)、[iShares Semiconductor ETF](https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf)。
