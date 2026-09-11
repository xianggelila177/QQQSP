# QQQSP 2.2

QQQSP 是一个面向单用户、自托管部署的多市场行情面板。项目使用 Node.js 原生 HTTP/SSE、静态 HTML/CSS/JavaScript 和可选 WebSocket 来源，不依赖数据库、Redis 或前端框架；默认只监听本机回环地址，适合放在已有反向代理或 Cloudflare Tunnel 后面使用。

本版本重点完善历史 K 线来源切换、行情与历史的时效标识、429 冷却、分时最新报价点和部署回滚链路。报价来源与历史来源可以不同，页面和 API 会保留实际来源、检查时间、覆盖范围及失败/冷却状态。

## 核心特性

- 覆盖美股、中国内地、香港、韩国及其他已配置市场的证券、ETF 和指数目录。
- 默认使用网站批量快照轮询；通过 SSE 向浏览器推送，断流时保留受控的轮询兜底。
- 支持日、周、月、年历史；周/月/年由经过校验的日线聚合，不用短窗口冒充长历史。
- 历史响应检查证券身份、日期、OHLC 关系、未来记录、单位和覆盖状态；不跨来源拼接、不补造蜡烛。
- 分时图区分“来源历史”和“报价采样”；最新报价点只在时间、交易日、单位和新鲜度均匹配时显示。
- 每来源主机设置最小间隔、并发控制和共享冷却；429、403、5xx 会携带可见的 retryAt 或冷却状态。
- 可选的受控恢复快照、参考汇率、官方公告源、Alpaca/Finnhub 流式报价及容量检查工具。
- 提供直接启动、版本化 systemd 安装/回滚、Cloudflare Tunnel 示例和自动化测试脚本。

## 架构

~~~text
浏览器
  ├─ 静态资源：public/app.js、public/modules/、panel.bundle.js
  └─ HTTP/SSE：/api/market、/api/stream、/api/history 等
          │
      server.js → lib/http.js / lib/sse.js
          │
      app.js（组合根）
          ├─ quote engine / snapshot / realtime：行情、缓存、SSE 更新
          ├─ history service：来源选择、缓存、分页、日线聚合
          ├─ news / macro / FX / market calendar：资讯、宏观、汇率和交易时段
          ├─ host gate / retry / telemetry：控频、冷却、超时和诊断
          └─ lib/providers/：Yahoo、Nasdaq、东方财富、Naver、腾讯、新浪等适配器
~~~

运行时的配置由 config.js 统一读取；实例独立持有传输层、队列、缓存、熔断状态和生命周期。/healthz 表示进程存活，/readyz 表示服务及磁盘条件满足，不等于所有外部行情源已经可用；dataReady、来源诊断和历史 coverage 需要单独查看。

常用接口：

| 接口 | 用途 |
|---|---|
| /healthz、/readyz | 存活与就绪检查 |
| /api/market、/api/quote | 最新行情快照 |
| /api/stream | SSE 行情与心跳 |
| /api/history | 日/周/月/年历史 K 线 |
| /api/sources、/api/markets | 来源状态、市场目录 |
| /api/news、/api/macro、/api/search | 资讯、宏观和证券搜索 |
| /api/stats | 本机或带 STATS_TOKEN 的诊断接口 |

## 行情与历史数据来源

项目按公开网站响应格式实现适配。来源可能延迟、限流、改版或只覆盖部分证券；下表是代码中的用途，不是供应商 SLA 或使用授权声明。

| 数据用途 | 主要来源 | 说明 |
|---|---|---|
| 批量行情快照 | 新浪、腾讯、Naver | 默认 POLL_PRIMARY=sina；根据市场和证券身份切换备源，按来源返回的延迟/检查间隔处理 |
| 全球/低频补充与历史 | Yahoo Finance | 需要时使用 crumb/cookie；同一 Yahoo 主机共享控频，不作为秒级行情承诺 |
| 美股历史与分时 | Nasdaq API | 支持的美股/ETF 使用历史 OHLC 或来源分时；证券类型和返回身份会校验 |
| 内地、香港及部分美股历史 | 东方财富 | 通过证券市场命名空间读取原始日线；返回证券和市场不匹配时拒绝 |
| 中国内地日线备源 | 新浪 | 作为内地日线的独立备源，不把不同来源的单日数据拼在一起 |
| 韩国历史 | Naver F-chart | 使用韩国本地代码和 Asia/Seoul 时区，区分 KOSPI/KOSDAQ |
| 可选流式美股 | Alpaca、Finnhub | 默认关闭；覆盖、延迟、权限和数据许可取决于账户与所选 feed |
| 汇率与公告 | Yahoo、ECB/Frankfurter、Federal Reserve、ECB、BEA | PUBLIC_SOURCE_REDUNDANCY=1 时启用受控参考汇率和官方公告冗余；参考汇率按日度/近似标记 |

本地 data/market-instruments.json 和 data/market-calendars.json 提供证券目录、交易所时区、已核对的交易日范围和特殊时段。历史接口会返回 source、sourceCheckedAt、historyAsOf、coverageStatus 和警告；上游来源不同时不会静默合并为一条“完整”序列。详细来源边界见 docs/SOURCES-2.2.zh-CN.md、docs/global-market-data-sources.md。

## 报价年龄与 429 处理原则

- quoteAt 是来源观测时间，sourceCheckedAt 是应用检查来源的时间，fetchedAt 是应用接收时间；三者语义不同。
- 默认 POLL_MS=1000、CACHE_MS=2000、QUOTE_MAX_AGE=10000（毫秒）。页面的“更新于”由独立显示时钟递增，不会因为 Worker 静默、SSE 心跳或刷新失败而把旧数据伪装成新数据。
- 429 优先尊重上游 Retry-After；否则按来源主机共享的退避策略冷却。默认 Yahoo 退避从 Y429_BASE=30000 毫秒开始，最多 Y429_CAP=900000 毫秒，单次任务还有 Y_TASK_DEADLINE=20000 毫秒上限。
- 冷却状态按真实主机维护，Yahoo 的认证、搜索、图表等出口归为同一组；冷却期间快速失败并返回 retryAt，前端禁止无意义的重复请求，适用时尝试已定义的独立备源。
- 不轮换代理、IP、命名空间或凭据来规避限流，不连续刷新探测，也不把 HTTP 200 的空数据当作成功。
- 可用旧缓存会明确标记为 stale/staleInfo；恢复快照会标记为 recovery 和离线状态。来源全部失败时显示错误和冷却，不合成历史蜡烛或虚构报价。

## 安装与部署

### 环境要求

- Node.js >=22.16.0；Docker 示例使用 Node 24 Alpine。
- 运行时没有 npm 依赖，不需要在服务器执行 npm install。
- systemd 安装需要 Linux、systemd 和管理员权限；浏览器测试另需 Python Playwright 与 Chromium。

### 从交付包或源码启动

~~~bash
unzip qqqsp-v2.2-source.zip
cd qqqsp-v2.2

# 仅对原始交付 ZIP 执行；GitHub 源码树请使用 scripts/verify.mjs 校验
sha256sum -c SHA256SUMS

cp .env.example .env
# 按需编辑 HOST、PORT、SYMBOLS 等配置
bash start.sh
~~~

默认直接启动地址为 http://127.0.0.1:8567。如果确实需要从外部访问，应显式设置 HOST=0.0.0.0，并由防火墙、反向代理或认证层限制访问；本项目本身不提供用户登录系统。

### systemd 版本化安装

从源码根目录执行：

~~~bash
sudo env NODE_BIN="$(command -v node)" bash ops/install.sh /opt/qqqsp-v2 8568
sudo systemctl status qqqsp-v2.service --no-pager
node ops/smoke.mjs http://127.0.0.1:8568
node ops/history-smoke.mjs http://127.0.0.1:8568 NVDA,MRVL
~~~

ops/install.sh 会创建或更新 qqqsp-v2.service，在 releases/ 保存版本，在 current 切换当前版本，并保留 shared/.env、shared/state/ 和 shared/logs/。升级时已有端口和配置优先保留；脚本不会替你修改 Nginx、DNS 或 Cloudflare Tunnel。新服务就绪后，必须再执行实际 /api/history 检查；仅 /readyz 成功或页面显示数字不足以证明历史数据可用。

qqqsp-panel.service 是另一套面向固定生产布局的加固单元模板，默认指向 /var/lib/qqqsp/current、端口 8567 和 /etc/qqqsp/panel.env，不要与安装脚本生成的 qqqsp-v2.service 无意混用。回滚示例：

~~~bash
sudo bash ops/rollback.sh /opt/qqqsp-v2
sudo systemctl status qqqsp-v2.service --no-pager
~~~

### Cloudflare Tunnel / 反向代理

qqqsp-cloudflared.service 是单独维护的 Tunnel 示例，使用独立系统用户和外置 token 文件，目标形如 http://127.0.0.1:8567。请根据实际服务端口调整 unit；token 只能放在服务器受保护路径（例如 /etc/qqqsp-edge/tunnel.token），不得写进源码、.env.example 或提交历史。若通过 Nginx 转发 SSE，应至少确认：

~~~nginx
location /api/stream {
    proxy_pass http://127.0.0.1:8567;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 90s;
}
~~~

qqqsp-relay-tunnel.service 仅在确有需要时启用；SSH 私钥、known_hosts 和中继令牌必须位于服务器外部受保护路径。仓库中只保留 unit/脚本模板，不包含任何凭据。

## 配置

复制 .env.example 为本地 .env（systemd 部署使用 shared/.env），不要提交实际 .env。常用参数：

| 参数 | 默认值 | 作用 |
|---|---|---|
| HOST / PORT | 127.0.0.1 / 8567 | 监听地址和端口；安装器首次安装默认写入 8568 |
| SYMBOLS | QQQ,SPY | 默认关注证券列表 |
| POLL_PRIMARY / POLL_MS | sina / 1000 | 批量行情首选来源和最小轮询周期 |
| CACHE_MS / QUOTE_MAX_AGE | 2000 / 10000 | 行情缓存与新鲜度阈值 |
| PUBLIC_ORIGIN | 空 | 需要时限制跨源访问来源 |
| STATS_TOKEN | 空 | 保护 /api/stats；为空时只允许受限本机访问 |
| PUBLIC_SOURCE_REDUNDANCY | 1 | 启用恢复、参考汇率和官方公告冗余 |
| RECOVERY_PATH | ./state/quotes.json | 私有恢复快照路径；不是历史数据库或异地主备份 |
| FX_MODE | reference | reference 使用日度参考汇率；market 允许使用市场汇率路径 |
| UPSTREAM_TIMEOUT / Y_TASK_DEADLINE | 8000 / 20000 | 上游传输与 Yahoo 任务超时 |
| Y429_BASE / Y429_CAP | 30000 / 900000 | Yahoo 冷却起点和上限 |
| ALPACA_ENABLED | 0 | 是否启用 Alpaca 流式来源 |
| APCA_API_KEY_ID / APCA_API_SECRET_KEY | 空 | Alpaca 凭据，只能放在服务端环境 |
| FINNHUB_TOKEN | 空 | Finnhub 可选令牌，只能放在服务端环境 |
| LOG_FILE / LOG_MAX_BYTES / LOG_MAX_FILES | ./logs/panel.log / 10MiB / 3 | 本地结构化日志与轮转 |

恢复文件、日志目录和 token 文件应由服务用户拥有并使用最小权限。关闭 PUBLIC_SOURCE_REDUNDANCY 并重启会回到不读写恢复文件的路径；不要让生产和测试进程共享恢复路径。

## 测试与验证

~~~bash
node scripts/build.mjs
node scripts/verify.mjs
node tests/run.mjs
node scripts/secret-scan.mjs .

# 需要 Python Playwright/Chromium，仅用于开发验收
python3 tests/v2/browser_check.py
python3 tests/v2/chart_browser_check.py
~~~

等价 npm 命令见 package.json：npm run check、npm test、npm run verify、npm run test:browser 和 npm run test:charts。交付报告记录的 Node 22.16/Linux 受控上游回归结果为：91 个测试文件通过、62 个核心用例通过、294 个脚本检查通过、秘密扫描 0 项发现。该结果不等同于目标服务器的真实来源可达性；部署后仍需执行 ops/history-smoke.mjs，并分别验证页面、SSE、历史接口和实际域名。

为遵守发布边界，GitHub 上传副本不包含 docs/evidence 下的日志、截图和运行证据；完整证据只作为本地交付校验材料保留。

## 已知限制

- 公开网站来源没有实时性、完整性、持续可达性或永不 429 的保证；字段格式、证券覆盖和延迟可能随上游变化。
- 默认是单用户、单进程架构，没有用户认证、订单执行、交易风控、数据库或分布式锁；不应直接暴露为无限制公共服务。
- 历史数据保留受来源窗口、本地最多约 45 年范围、缓存预算和证券上市日期影响；复权口径、成交量单位及部分交易日覆盖可能标为 unknown/partial。
- 年线首次读取可能比日线慢；历史来源失败会冷却，旧缓存不会被无提示地升级为新数据。恢复快照有大小、条数和年龄上限，突然断电可能丢失尚未刷盘的最近观察。
- 交易日历以仓库中已核对的范围为准；未覆盖年份、未发布时段和突发停牌不会被推断为正常开市。
- 交付报告中的真实服务器 systemd 切换、Nginx/Cloudflare 配置、长期稳定性、Docker 构建、Node 24 本版重跑和真实 Alpaca/Finnhub 凭据联调不在本地回归结论内。

## 目录结构

~~~text
.
├── app.js / server.js        # 应用组合根与 HTTP 入口
├── config.js / VERSION       # 配置默认值与前端资源版本
├── lib/                      # 缓存、行情、历史、SSE、诊断和来源适配器
│   └── providers/            # Yahoo、Nasdaq、东方财富、Naver、腾讯、新浪等
├── public/                   # 静态前端、模块、构建 bundle 与预压缩资源
├── data/                     # 市场证券目录和交易日历
├── ops/                      # 安装、回滚、smoke、历史和容量检查
├── scripts/                  # 构建、版本、校验、压缩和秘密扫描
├── tests/                    # Node 单元/集成测试、浏览器测试与 fixtures
├── docs/                     # 来源说明、实现说明和运维文档
├── .env.example              # 不含凭据的配置模板
├── *.service / *.timer       # systemd / Tunnel 模板
└── package.json              # 脚本与 Node 引擎要求
~~~

## 版本信息

| 项目 | 值 |
|---|---|
| 应用版本 | 2.2.0 |
| 前端资源版本 | 75（文件 VERSION，例如 panel.bundle.js?v=75） |
| Node.js | >=22.16.0 |
| 运行时依赖 | 无 npm 运行时依赖 |
| 交付时间 | 2026-09 |

## 免责声明

本项目及其数据仅供技术验证、个人研究和信息展示，不构成投资、交易、税务或其他专业建议。行情、历史 K 线、汇率、资讯和交易日历可能延迟、缺失、错误、被限流或发生上游变更；页面出现“就绪”不代表报价实时，也不代表数据适合下单。任何投资或交易决策都应以交易所、经授权的数据供应商和专业顾问提供的最新信息为准。

项目不声明第三方网站接口的稳定性、授权、数据许可或商业可用性。部署者应自行遵守所在地法律、上游服务条款和数据使用限制，并负责保护服务端 token、SSH 私钥、Cloudflare 凭据、日志和恢复文件。
