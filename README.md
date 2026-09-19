# QQQSP v92 — 多市场行情与 LLM 分析数据 API

应用版本 **2.12.0**，静态资源版本 **92**。完整源码包含网页行情、服务器三交易日报价采样、最多 100 只自选，以及独立鉴权的只读 LLM 数据接口。

本仓库是脱敏发布副本。`quotes.example.com`、`203.0.113.10` 等为示例部署地址；运行时使用自己的域名和配置。真实密钥、私有环境文件、运行日志、采样记录和本地调用包不随源码发布。

## 本地运行

需要 Node.js **22.16+**，推荐 Node.js 24。生产程序没有 npm 运行时依赖，构建后的静态资源已包含在仓库中。

```sh
umask 077
cp .env.example .env
# 按需编辑 .env，填写自己的配置
npm start
```

默认地址为 `http://127.0.0.1:8567`。Linux 服务、持久化目录及升级步骤见 [部署说明](部署说明.md)。升级时保留已有配置和状态。

## v92 新增：供 LLM 查询的完整 JSON

```http
POST /api/v1/market-context
Authorization: Bearer <独立只读密钥>
Content-Type: application/json

{"symbol":"NVDA"}
```

在服务器 `.env` 中配置 `LLM_API_KEY`：32～256 位 URL 安全字符，并与 `STATS_TOKEN` 不同。留空时接口拒绝访问。密钥只在 HTTP 请求头中传递。

默认返回最新报价、来源最新交易日分时、252 根日线、服务器三个交易日的采样、基础指标、缓存资讯和宏观概况。每个分区包含来源、时间、单位、覆盖范围和缺失原因；时序使用带列定义的紧凑 JSON。指数以点计价，未知值为 `null`，缺失数据不补造。

- 每次查询一个标的，支持未加入自选的证券；查询不会修改自选或启动永久采样。
- 整体等待最多 15 秒，含排队；部分数据可用时返回 `partial`。
- 请求体最多 8 KiB，响应压缩前最多 2 MiB，不静默截断。
- 每密钥每分钟最多 20 次、突发 3 次；全局执行 1 次、等待最多 2 次。

文档与客户端：

- [接口与字段说明](public/market-context.md)
- [OpenAPI 3.1](public/market-context.openapi.json)；运行时地址 `/api/v1/openapi.json`
- [JSON Schema](public/market-context.schema.json)
- [Agent 工具定义](public/market-context.tool.json) 与 [llms.txt](public/llms.txt)
- [零运行时依赖的查询与统计脚本](scripts/market-context-client.mjs)

调用脚本从私有环境文件读取 `LLM_API_KEY` 和 `LLM_API_BASE_URL`。本机测试可设置 `LLM_API_BASE_URL=http://127.0.0.1:8567`；公网使用自己的 HTTPS 地址：

```sh
node --env-file=/private/client.env scripts/market-context-client.mjs NVDA --output nvda-context.json --stats
```

输出路径必须是新的 `.json` 文件。完整数据写入文件，统计摘要写到 stderr，文件权限为 0600。支持 HTTP 工具的 LLM 可读取整份 JSON 后执行统计；不要从被对话界面截断的文本计算。

## 现有功能

- 多市场股票、ETF、基金、指数与现有支持的期货来源。
- 自选上限 100，服务器持续采集已保存自选，浏览器关闭后继续运行。
- 真实来源历史与服务器观察采样分开，页面默认来源历史。
- 行情与图表共享来源缓存、限流和重试；SSE 分批推送。
- 日经、费城半导体指数及 SOXX ETF 的身份和行情路由已修正。
- 来源延迟、休市、盘前盘后、复权未知及缺失数据明确标注。

## 构建和验证

```sh
npm ci
npm run build
npm run check
npm test

# 可选浏览器验证，开发依赖不用于生产运行
npx playwright install chromium webkit
npm run test:e2e
```

构建会统一 `VERSION`、Service Worker 和静态资源，并生成接口文档。开发验证使用 Node 内置测试、Playwright 和 Ajv；生产仍为零第三方运行时依赖。

发布前检查了源码凭据、版本和生成产物一致性。已退役的历史用例不计为通过，见 `tests/retired-v72.json`。使用自己的行情数据权限与基础设施配置部署。
