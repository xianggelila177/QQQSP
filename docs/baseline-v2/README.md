# QQQSP v2 · 单用户轻量重构版

## 一、交付概况

这份源码以 v72 为功能基线，按 REBUILD-PLAN 的目标清单实现关键链路，再按“只有一个用户”的要求收缩架构。包含可直接启动的后端、已构建并预压缩的前端、单进程部署脚本、测试与本次验证证据，不需要另交给编码工具补齐才能运行。

本版是 **单进程 + 原生 HTTP + 浏览器原生脚本 + 内存缓存 + 一个恢复文件**。不使用数据库、Redis、框架、用户系统、分布式队列，也没有 npm 运行时依赖。源代码、构建和核心测试均可仅使用 Node.js 24；历史回归涉及 Bash/Python，浏览器验证另需 Python Playwright 和 Chromium。

产品版本为 2.0.0；前端缓存序号继续递增为 **v73**，避免已安装 v72 的离线应用缓存回退。旧自选、名称、币种、列数等本地存储键保持兼容；切换到不同域名时，浏览器存储不会自动跨域迁移。

**验证边界：已完成本地模拟来源、真实 HTTP/SSE、离线真实浏览器验证。没有使用真实行情账户联调，没有在你的服务器安装，没有完成真实隧道、systemd、Docker 构建与长期稳定性验收。上游网站接口仍可能变化，不能承诺永不出现 429 或每秒必有新成交。**

## 二、直接启动与部署

概况：不需要安装依赖或重新构建。先在新端口启动，核对页面和来源状态，再切换现有域名；旧版继续保留。

### 2.1 最快试运行

解压后进入源码目录，要求 `node --version` 为 24 或更新版本：

```bash
cd qqqsp-v2
cp .env.example .env
# 首次使用建议改为 8568，避免占用旧版端口。
sed -i 's/^PORT=.*/PORT=8568/' .env
bash start.sh
```

另一个终端验证：

```bash
node ops/smoke.mjs http://127.0.0.1:8568
```

默认绑定回环地址，供同机 cloudflared 或反向代理访问。初次启动没有凭据也能使用公共网站来源；来源不可达时显示等待、失败或旧缓存，绝不生成模拟价格。`tests/v2/browser-fixture.js` 只用于测试，不由生产页面加载。

### 2.2 Linux 长期运行：推荐路径

安装器创建独立 `qqqsp-v2.service`，不停止原来的 v72 服务，不改动现有 cloudflared 配置：

```bash
cd qqqsp-v2
sudo bash ops/install.sh /opt/qqqsp-v2 8568
```

Node 必须位于服务用户也可访问的位置。如果 Node 仅装在 root 私有的版本管理目录，先安装系统级 Node，或显式指定已共享的路径：

```bash
sudo NODE_BIN=/usr/local/bin/node bash ops/install.sh /opt/qqqsp-v2 8568
```

安装后的目录：

```text
/opt/qqqsp-v2/
  current -> releases/本次版本
  previous -> releases/上次版本（升级后才有）
  releases/             每次部署一份代码
  shared/.env           配置与密钥；升级不覆盖
  shared/state/         恢复文件；升级不删除
  shared/logs/          按大小轮转的日志
```

日常管理：

```bash
sudo systemctl status qqqsp-v2 --no-pager
sudo journalctl -u qqqsp-v2 -n 50 --no-pager
sudo nano /opt/qqqsp-v2/shared/.env
sudo systemctl restart qqqsp-v2
```

每次从新的源码目录重新执行安装命令即可升级。首次安装的第二个参数指定端口；后续升级保留已有 `.env`，不会用命令参数覆盖你改好的端口。安装器以服务就绪检查判定进程可用，不以是否已有新成交判定行情质量。新服务不就绪会尝试恢复上一部署版本。

回退：

```bash
sudo bash ops/rollback.sh /opt/qqqsp-v2
```

首次由 v72 切换至 v2 时，`previous` 尚不存在；应将隧道目标重新指向旧版端口。不要删除旧版目录和恢复文件。

### 2.3 现有域名与推送

确认本机页面正常后，把现有 cloudflared 的服务目标改为 `http://127.0.0.1:8568`，保留原域名。不同用户的隧道配置位置不同，安装器不会猜测或覆盖它。

使用 nginx 时，对 `/api/stream` 关闭代理缓冲，读取超时长于心跳：

```nginx
location /api/stream {
    proxy_pass http://127.0.0.1:8568;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 75s;
}
```

应用本身已返回 `text/event-stream`、`no-transform`、`X-Accel-Buffering: no`，每 15 秒发送心跳。真实 cloudflared 链路尚未实测；上线后应确认开发者工具中 `/api/stream` 持续接收事件，正常情况下没有反复 `/api/market` 请求。

这是自用服务，不含登录系统。公开域名需要访问限制时，使用你现有的隧道访问控制或反向代理认证，不要直接暴露无认证公网端口。

### 2.4 可选 Docker

已提供 Dockerfile，但交付环境未进行镜像构建或容器运行验证。已有 Node 的服务器优先使用上述 systemd 路径。

```bash
docker build -t qqqsp-v2 .
docker run -d --name qqqsp-v2 --restart unless-stopped \
  --env-file .env -e HOST=0.0.0.0 -e PORT=8567 \
  -p 127.0.0.1:8568:8567 \
  -v qqqsp-v2-state:/app/state -v qqqsp-v2-logs:/app/logs qqqsp-v2
```

## 三、每秒显示与 429 的具体处理

概况：秒级显示不等于每秒向行情网站发请求。本版分别管理显示时钟、来源采集和浏览器传输。

```text
网站批量轮询 / 可选上游 WebSocket
                 ↓
         每来源共享请求入口
         间隔、429 冷却、失败等待
                 ↓
           一份行情快照
                 ↓
      SSE 推送变化 → 浏览器卡片

浏览器本地 1 秒时钟 → 只更新年龄文字
```

**报价年龄**始终使用成交时间 `quoteAt` 计算；检查成功、心跳、鉴权成功均不会把它清零。没有新成交时，它继续增大。页面定时器不依赖工作线程消息，也不触发网络或图表重绘。操作系统冻结、后台节流、休眠无法作为精确秒表保证；恢复后按实际时间重新计算。

**正常浏览器链路**采用 SSE，不再每两秒读取行情接口。断流后临时每两秒读取自有服务缓存，连接恢复后停止轮询。持续监控模式保持后台连接；省流模式在隐藏时暂停，恢复前台补读。

**上游采集**与页面数无关。只有活跃自选才进入调度，所有页面共享一次采集。取消自选后释放成员及对应快照状态；没有活跃消费者时不继续为固定 QQQ/SPY 自动轮询。存在有时限的 HTTP 活跃租约，用于短暂断流恢复。

**429 策略**：Yahoo 的报价、认证、搜索、历史等域名共用同一冷却状态；其他来源按真实主机隔离。请求之间遵守最小间隔；429 后解析 `Retry-After` 的秒数、日期及服务端重置时间。未提供等待时间时，初始 30 秒指数退避，内部退避上限 15 分钟；服务端给出更长等待时完整遵守，不提前探测。已排队请求在执行前再次检查冷却。等待期返回其他来源或旧缓存，来源恢复后才继续。

**不是规避限流**：没有 IP 轮换、代理中继或伪造请求头绕限制。新行情优先使用已授权推送，网站仍按它声明的节奏采集；Naver 返回 70 秒就不会伪称其每秒更新。折叠新闻、折叠宏观不轮询，汇率默认使用低频参考源，减少与历史数据争抢 Yahoo 请求机会。

手动刷新只读取自有服务的最新缓存，不绕过来源冷却。底部“数据源健康”展示来源请求、429、抑制次数和恢复时间，展开/手动检查时读取，不额外持续轮询。

## 四、行情源配置与诚实标注

概况：公共网站来源开箱可用但属于尽力服务。美国股票可配置授权流式来源；不把单一交易所或未知覆盖宣传为全市场实时行情。

Alpaca 配置示例，密钥仅放服务端 `.env`：

```dotenv
ALPACA_ENABLED=1
ALPACA_FEED=iex
APCA_API_KEY_ID=填写自己的密钥
APCA_API_SECRET_KEY=填写自己的密钥
```

收到鉴权成功不等于已订阅：本版等待各标的订阅确认后才显示推送状态。基础 IEX 来源不是全美交易所汇总；`sip` 需要对应权限，不能仅修改配置获得权限。进程共享连接，不给每张卡片单独建上游连接。盘前、盘后等覆盖取决于来源，不能因为连接存在就假设该时段有成交。

第二流式来源 Finnhub 可选：

```dotenv
FINNHUB_TOKEN=填写自己的令牌
```

已编写连接、订阅、成交解析、乱序丢弃、空闲退出和退避逻辑，默认关闭。它的账户覆盖和实时权限在本次交付中未验证，因此界面明确标为账户覆盖未知，而不是固定零延迟全市场。配置两个来源时优先 Alpaca，主流不可用时启用备流；不将两个来源的日统计混成同一口径。

当前价格是来源的成交价格，不声称是全市场最优买卖报价、官方结算价或经过完整成交条件筛选的官方最新价。当前报价与历史图表可能来自不同来源，来源标识分别保留。海外历史仍主要依赖 Yahoo；A 股日线可回退新浪，但只提供来源实际返回的有限窗口，切换来源改变序列身份并通过既有 409 重载处理，不拼接成伪造的完整历史。

官方资料核对于 2026-09-10：
- Alpaca 订阅及覆盖：`https://docs.alpaca.markets/us/docs/about-market-data-api`
- Alpaca 连接及订阅确认：`https://docs.alpaca.markets/us/docs/streaming-market-data`
- Finnhub WebSocket 文档入口：`https://finnhub.io/docs/api/websocket-trades`（当前读取环境未获得完整正文；账户联调仍需验证）

## 五、保留功能与实现颗粒度

概况：保留成熟图表和业务口径，重写最影响响应、资源和维护成本的通路，不为了目录层数重写所有纯函数。

保留 20 个注册市场、12 个自选上限、每卡币种、盘前盘后行、市场日历、五档图表、均线和成交量、十字光标、键盘/平移/缩放、图片导出、分页、图表版本增量、官方资讯、离线缓存、恢复文件。数据资产维持原 schema。市场注册不意味着任一来源保证全覆盖；未验证日历状态仍显示未知。

已删除红框“空间不足时自动减少列数”提示；自动/2/3/4 列保留。顶栏按交易中数量汇总，区分推送、连接、回退；首屏显示等待骨架，而不是把没有数据伪装为连接错误。

核心代码入口：

| 位置 | 职责 |
|---|---|
| `app.js` | 唯一应用对象组装和启停，无模块级默认服务 |
| `config.js` | 配置默认值与校验，自动生成 `.env.example` |
| `lib/quote-engine.js` | 活跃自选、一份快照、变化通知 |
| `lib/host-gate.js` | 所有上游请求共用的按来源等待与冷却 |
| `lib/source-registry.js` | 来源覆盖、传输与最小间隔声明 |
| `lib/sse.js` | 事件流、心跳、图表版本增量 |
| `lib/cached-resource.js` | 简单 TTL、失败缓存、请求合并及后台刷新 |
| `lib/providers/*-stream.js` | 可选实时源连接和事件解析 |
| `public/modules/panel-live-store.js` | 浏览器推送连接、断流兜底、订阅变更 |
| `public/modules/panel-scheduler.js` | 独立计时及恢复，年龄不绑网络 |

没有照搬原计划的多用户配额、独立 SSE 连接配额、并发队列体系、10% 灰度流量、数据库或新框架。也没有强制把所有不同语义的缓存塞进一个万能对象，或机械搬到四层目录；历史分页、汇率和恢复文件继续保留专用实现。详见 `docs/IMPLEMENTATION-NOTES.zh-CN.md`。

## 六、验证与最终说明

概况：本版的验证结果与未验证项分开记录。不是把旧套件全部删除后声称全绿。

```bash
npm run check          # 脚本语法、版本、打包资源、预压缩、配置一致性
npm run test:core      # Node 原生测试：18 个核心用例
npm test               # 91 个保留旧回归文件 + 上述核心用例
npm run build          # 修改代码之后才需要；无 npm 安装步骤
```

`npm test` 中的旧回归使用 Bash/Python，因此需要对应系统命令；运行应用和核心测试不需要 Python。浏览器测试需另行准备 Python Playwright 与 Chromium，再运行 `npm run test:browser`。

43 个旧套件绑定已经删除的全局实例、轮询、准入/中继或旧工具链，列在 `tests/retired-v72.json`，不计入通过数。它们仍可用 `npm run test:legacy` 查看；此命令是旧架构诊断，不是本版验收门禁。新测试覆盖核心替代路径，但不声称每一个混合旧断言均已逐条迁移。

完整结果、短时浏览器验证条件和截图位于 `docs/TEST-REPORT.zh-CN.md`、`docs/evidence/`。原 v72 运维文件及旧发布工具仅作为迁移参考保留，**本版只使用 `start.sh`、`ops/install.sh`、`ops/rollback.sh`、`ops/smoke.mjs` 与当前 package.json 的命令**，不要启用旧 relay、supervisor 服务组。

最终使用方式：先部署到新端口，验证服务、事件流和来源状态，再切换现有域名。代码已经交付；真实上游权限、部署环境、跨隧道传输与长期稳定性仍必须以你的实际运行结果为准。
