# QQQSP 2.16.3 · 免费美股成交流与轮询

## 一、版本概览

应用版本 **2.16.3**，静态资源版本 **99**。配置自有免费 Finnhub API Key 后，成交流和网站批量轮询共同提供美股报价。新值有变化即推送，面板与本地 Agent 共享同一份数据；保留近7天新闻、全球证券搜索及原有接口。

v99 增加服务端 Finnhub REST 密钥池：搜索和低频财务请求按密钥轮换，单个密钥限流或拒绝时有界切换；普通远程搜索先查 Finnhub，有结果即返回，空结果或失败再查询 Yahoo 等来源，`more=1` 可展开全部来源。配置与验证见 [v99 部署说明](docs/DEPLOY-v99.md)。

v98 修复指数别名在搜索与批量 API 之间不一致，以及 SOXL 备源映射缺口，补充已核验的标普500指数来源。复现与验证见 [v98 修复记录](docs/DEPLOY-v98.md)，定向回归运行 `npm run test:v98`。

v97 修复报价年龄误报、SOX 指数发布时段和静默连接的时效判断。问题复现、修复范围与定向验证见 [v97 修复记录](docs/DEPLOY-v97.md)，新增回归运行 `npm run test:v97`。

本版接入与改动见 [v96 免费流与轮询](docs/DEPLOY-v96.md)，定向回归运行 `npm run test:v96`。网站固定延迟或账户行情覆盖不因每秒刷新而改变；来源与连接状态分开显示。

实现前的问题清单和交易所规范对照见 [v95 审计与契约](docs/V95-issues-and-exchange-contract.md)，日股目录及覆盖限制见 [搜索与日本行情](docs/SEARCH-JAPAN-v95.md)。新增缺陷回归运行 `npm run test:v95`；完整回归运行 `npm test`。

生产启动没有第三方 npm 运行时依赖；已构建网页资源在 `public`。没有附带真实密钥、私人运行数据或商业行情权限。代码可启动不意味着每个供应商、交易市场与资料范围都已经获得授权。

## 二、首次运行与升级

需要 Node.js 22.16 或更新版本。进入解压目录：

```sh
node scripts/init-config.mjs
npm start
```

默认 `http://127.0.0.1:8567`。初始化只在 `.env` 不存在时执行，生成不同的管理员和只读密钥，不输出密钥、不覆盖已有配置。已有部署保留 `.env`、`state`、`logs`；升级不要重新初始化。

升级步骤见 [v95 部署说明](docs/DEPLOY-v95.md)；既有 systemd、持久化及回滚体系见 [部署说明](部署说明.md)。管理面板 `/api-keys.html` 必须使用 `STATS_TOKEN`，只读密钥不能管理其他密钥。公网必须经 HTTPS 和适当的入口访问控制。

## 三、接口能力

新参数全部可选。旧 v1 单证券默认仍为七个原分区、252 根日线、三个交易日采样和紧凑格式；旧 v2 详情默认仍为详情快照及具名对象。没有强迫旧调用端改用高级接口。

| 能力 | 入口与约束 |
| --- | --- |
| 原聚合接口 | `POST /api/v1/market-context`；新增同契约 GET/HEAD |
| 截图式完整详情 | `POST /api/v2/market-detail`，保留 snapshot/analysis 两档 |
| 显式复权 | `adjustment=raw/split/split_dividend`，只使用能声明该口径的已配置来源 |
| 日、周、月 | `daily_granularity`，周期由日线聚合，保留实际末交易日和分页标识 |
| 公司行动 | 显式加入 `corporate_actions`；处理日期、除权日、支付日期分别声明 |
| 历史分时与观察柱 | 日期、月份、向前游标；1/5/15/30/60 分钟，采样不是成交柱 |
| 市场状态与日历 | `/api/v1/market-status`、`/api/v1/trading-calendar`，节假日、半日市、未知覆盖 |
| 多证券 | `symbols` 最多10个，仅 quote/fundamentals；每个证券消耗一个滚动额度 |
| 密钥管理 | 多密钥、分权限、24小时轮换、同系列共用配额及撤销；仅存摘要 |
| 条件与导出 | GET/HEAD ETag/304；单时序 CSV + 元数据，不把 POST 返回成304 |
| 全市场榜单 | `/api/v1/movers`，来源覆盖明确，不拿自选列表冒充全市场 |
| 报价流 | `/api/v1/quote-stream`，独立鉴权、有界连接、默认持续连接，非逐笔回放 |

接口指南：[market-api-guide.md](public/market-api-guide.md)；完整核验：[需求核验与实现清单](docs/v94-需求核验与实现清单.md)。原计划中的服务端技术指标按“不做”的要求保留在客户端，不新增服务端指标运算。

## 四、本地智能体

将 `LLM_API_KEY` 和 `LLM_API_BASE_URL` 写入私有客户端环境文件；不要提交到仓库。默认只读密钥或新建的密钥必须具有所请求分区的权限。

```sh
# 详情（原 v93 客户端继续兼容）
node --env-file=/private/client.env scripts/market-detail-client.mjs NVDA --output nvda-detail.json

# 三证券批量
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA,SPY,QQQ --include quote,fundamentals --output batch.json

# 已配置、有权限来源的拆股复权周线
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include daily --adjustment split --granularity weekly --daily-bars 52 --output weekly.json

# 单日来源分钟柱聚合为15分钟；来源无权限时返回明确缺失
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include intraday --intraday-date 2026-09-18 --minutes 15 --format csv --output intraday.csv
```

CSV 文件同时写出 `.metadata.json` 侧车，包含来源、单位、覆盖和空值说明。客户端拒绝覆盖已有文件，使用私有文件权限；行情全部不可用时保留 JSON 诊断并以退出码2退出。不存在可靠支付日期、币种及拆股基准的公司行动，不用于硬补“已支付股息”。

## 五、构建、验证与边界

```sh
npm run build
npm run check
npm test
npm run test:v94
# 浏览器测试需要 Python Playwright 和 Chromium
npm run test:v94-browser
npm run test:v94-regression-browser
```

开发依赖可通过 `npm ci` 安装；没有 npm 包的离线验证环境会用 Python jsonschema 校验模式，生产不依赖它。测试采用标明的离线样本，不把测试价格当成实盘结果。完整日志见 `docs/evidence/v94`；此前版本的证据保持历史归属。

显式复权、长期授权分钟历史和全市场榜单使用自己的 Alpaca 资料权限；默认免费网页来源不会自动获得商业授权。日历只在仓库已核验的市场和年份范围内给出确定结果，不替代实时停牌流。操作员必须保留密钥状态文件；回退到不理解多密钥的旧程序前，应先关闭 API 入口并重新配置凭据，避免重新启用旧环境密钥。
