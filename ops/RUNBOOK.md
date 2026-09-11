# QQQSP 运维手册

当前生产布局：`/var/lib/qqqsp/releases/<release-id>` 保存不可变版本，`/var/lib/qqqsp/current` 指向当前版本。运行时为 Linux Node 24（`/opt/dsh-node/bin/node`）。本文描述准备、检查、切换和回滚流程；测试命令只使用本机回环固定数据，绝不连接线上验收地址。

## 服务、文件与诊断

| 服务或文件 | 职责 / 位置 |
|---|---|
| `qqqsp-panel.service` | Node 面板，`127.0.0.1:8567`；独立 cgroup，仅故障时重启 |
| `qqqsp-relay-tunnel.service` | SSH Yahoo 中继隧道，回环 `8801`；独立维护连接 |
| `qqqsp-cloudflared.service` | Cloudflare 入口转发到面板；独立维护连接 |
| `qqqsp-capacity-check.service` / `.timer` | 每15分钟检查根分区：使用率须低于 85%，可用空间须至少 9 GiB；不执行删除或服务重启 |
| `/etc/qqqsp/panel.env` | 受保护的服务配置；凭据不得进入源码或发布包 |
| `/var/log/qqqsp/panel.log` | 结构化业务日志，默认 10 MiB × 3 份轮转 |
| journald | 各服务启动、SSH、Cloudflare、容量告警输出；用 `journalctl -u <unit>` 查阅 |
| `/etc/qqqsp/panel-relay.token` | 面板专用中继令牌；由 YAHOO_RELAY_TOKEN_FILE 指定，root:qqqsp 0440；拒绝符号链接及非普通文件 |
| `/etc/qqqsp-edge/tunnel.token` | 仅 qqqsp-edge 用户读取的 Cloudflare 凭据；值不得复制到包内 |
| `/etc/qqqsp-relay/relay_key` | 仅 qqqsp-relay 用户读取的 SSH 中继私钥；已核实 known_hosts 同目录保存 |

`GET /healthz` 只证明进程存活。`GET /readyz` 检查默认核心标的 QQQ、SPY 是否达到业务就绪，不受访问者自选列表影响。冷启动最多等待 120 秒；超过仍未就绪须回滚。`GET /api/stats` 为受保护诊断接口，包含上游能力、请求与错误统计、核心 readiness 和容量状态。仅受信的回环 Cloudflare 入口启用 `TRUST_PROXY_LOOPBACK=1`；不得把未经验证的转发头当作客户端身份。

公开 API 区分缓存读取与昂贵刷新预算；以当前 `lib/http-admission.js` 配置和 `Retry-After` 返回为准，不在运维脚本中硬编码旧的 120 次/分钟假设。`/api/news` 兼容 `{SYMBOL: items[]}`；`X-News-Meta` 是 base64url JSON，只有未完成或失败的标的标注旧数据，完成项应即时保留。宏观响应提供 `items/stale/error/updatedAt/sources`，故障时保留有效旧内容。

## 可重复安装与测试

在干净检出的源码根目录执行。Linux 使用 Node 24，PATH 首项应包含 `/opt/dsh-node/bin`；本地验证可以使用已安装的兼容 Node。锁文件规定精确依赖版本，禁止用未固定的临时浏览器包或机器专属可执行文件路径。

```bash
export PATH=/opt/dsh-node/bin:$PATH
node --version
npm ci
npx playwright install --with-deps chromium
npm run test:deterministic
npm run test:e2e
npm run test:coverage
npm run check:release
```

`check:release` 依次执行每一个 JS、shell 和 Python 文件的语法检查，版本与静态资源存在性检查，服务定义检查，安全凭据扫描，未来 90 天交易日历检查，全部确定性测试、真实 Chromium 测试、80% 覆盖率门槛及两次独立构建的包哈希一致性。任何失败均为非零退出码，禁止跳过浏览器测试作为上线依据。

每个确定性测试使用独立临时目录、白名单环境和本地日志，完成后清理；运行器同时通过受控 preload 阻止非回环网络，遗漏上游桩会失败。测试不得复制整个工作树、继承真实 token/代理/生产 URL 或读取真实凭据。浏览器套件通过随机回环端口提供固定 API 数据，并阻断外部请求。覆盖 DPR 1/1.25/1.5/2 × 宽 320/375/390/430、自选与币种持久化、v58 Service Worker 升级、离线资源、键盘 OHLC、焦点、错误恢复、宏观缓存和 12 卡长图交互。后台测试明确定义为浏览器中的可见性/计时节流模拟；实际操作系统暂停标签页不由这个测试证明。

输出位于 `coverage/`、`test-results/` 和 `playwright-report/`。`coverage/gate.json` 包含完整维护源码列表、后端与浏览器分项，以及真实行/函数/分支比例；缺测文件保持零覆盖，不得为了过门槛删除范围。当前覆盖率复核可用 `node scripts/coverage.mjs --report-only`，但这不会重新执行测试，不能替代完整发布门槛。

在 Linux 主机上 `systemd-analyze verify` 必须成功。macOS 仅做便携结构检查并明确提示缺少原生验证，不声称已经验证 Linux unit。服务中引用的 Node、cloudflared、SSH 与部署目录须先存在。

## 版本、打包和交付

所有前端变更结束后修改 `VERSION`，再执行：

```bash
bash build_version.sh
npm run check:release
npm run build:release
sha256sum -c dist/qqqsp-v<version>.tar.gz.sha256
```

`build_version.sh --check` 只检查；正常同步先校验全部标记，再暂存并写入，失败恢复原内容。同步覆盖 HTML 资源查询串、Service Worker 缓存版本和 app 注册 URL；检查确认所有预缓存资源确实存在。

`dist/qqqsp-v<version>.tar.gz` 只含明确允许的源文件、日历数据、测试、文档、锁文件和发布脚本。`release-manifest.json` 逐文件列出相对路径、字节数、权限和 SHA-256；归档使用固定元数据，可重复构建。`.git`、`node_modules`、历史归档、开发输出、日志、临时文件、token、密钥和环境文件均不在包内。凭据扫描只输出文件/行号/规则，不输出匹配值。扫描通过不等于已撤销历史凭据；维护者必须单独确认历史泄露值的状态与 Git 历史处置。

## 暂存、切换、回滚

1. 在生产兼容 Linux Node 24 主机解包到唯一 release 目录，不覆盖当前目录。核验外部包 SHA-256 和包内逐文件 manifest；权限不允许服务用户改写应用源码。将运行必需的凭据链接指向原受保护持久位置，切勿将值写入命令或报告。
2. 在整个部署事务持有专用 `flock` 锁：检查 current 与预期基线一致，暂存、切换、120 秒观察和可能回滚期间都不释放。发现基线变化立即停止，重新核验其他发布者状态。
3. 用独立临时回环端口和单独日志启动暂存服务；先跑全套 Linux 确定性验证和 unit 校验，再低频检查真实上游 `/healthz`、`/readyz`、QQQ/SPY 行情、失败与备用源语义、静态资源和版本。临时服务不可接管现网端口或用户流量。
4. 保存旧 current 目标和精确回滚命令；在 current 同目录建立临时链接，用原子 rename 切换到新 release，仅 `systemctl restart qqqsp-panel.service`。未涉及配置的 SSH 与 Cloudflare 服务保持既有状态。
5. 120 秒内必须达到核心就绪；若核心失败、API/静态关键不变量失败、意外重启循环或关键 UI 错误，立即在同一锁内原子恢复旧链接并仅重启 panel。成功后检查公网版本、资源、QQQ/SPY、其他市场、日志和资源状态，再结束事务。

精确操作应由实际 release 路径生成并记录，不把示例占位符粘贴到线上。回滚只改变 current 链接，不删除失败版本、旧版本、备份或用户数据。

## 故障处理、保留与职责

```bash
systemctl --no-pager status qqqsp-panel.service
systemctl --no-pager status qqqsp-relay-tunnel.service
systemctl --no-pager status qqqsp-cloudflared.service
systemctl --no-pager status qqqsp-capacity-check.service
journalctl -u qqqsp-panel.service --since '30 minutes ago'
curl -fsS http://127.0.0.1:8567/healthz
curl -fsS http://127.0.0.1:8567/readyz
```

`cleanup.sh` 已安全退役，任何调用都不会清空日志或相邻监控 CSV。应用日志由 `log.mjs` 轮转；容量不足先定位占用、确认闲置，再使用经过校验的压缩备份或有明确保留策略的缓存/过期日志清理。不得对 CSV、备份或未知用户目录先截断后备份。journald 的保留须在系统管理员确认的容量预算内配置；容量告警服务只报告问题，不自动清理。

容量负责人为服务器管理员；阈值是根分区低于 85% 且至少 9 GiB 可用。日历负责人为发布维护者：`data/market-calendars.json` 记录年份、版本、来源；每年从各交易所官方交易日历核实下一年，补足各市场后运行日历测试与 90 天门槛。超过已核实覆盖期时发布失败，运行时应显示日历未知，禁止把未知日当作正常交易日。

Yahoo 429 看诊断退避时间和来源错误，等待自动恢复，避免连续手动刷新。中继问题只检查其专属 unit 与 journald；公网问题先对比 panel readiness 和 Cloudflare unit，不重启无关父服务，不使用宽泛 `pkill`。旧 `keepalive.sh/supervisor.sh/relay_tunnel.sh/tunnel_watchdog.sh` 仅为兼容入口，实际生命周期归独立 systemd 单元管理。

## 工具依据

- [Playwright 配置](https://playwright.dev/docs/test-configuration)
- [Playwright Chromium 原生覆盖率](https://playwright.dev/docs/api/class-coverage)
- [V8 到 Istanbul 格式转换](https://github.com/istanbuljs/v8-to-istanbul)


## v62 隔离、恢复与验收补充

面板、Cloudflare、SSH中继分别使用 qqqsp、qqqsp-edge、qqqsp-relay 三个禁止登录的系统用户。发布源码由root持有，仅面板组只读；面板只写 /var/log/qqqsp 与 /var/lib/qqqsp/recovery。容量任务以qqqsp写 /var/lib/qqqsp/health。面板单元隐藏另外两个凭据目录及旧 /var/lib/dsh，防止共享旧身份的读取范围残留。每次验收都应以实际服务用户检查拒绝读取私钥/token及拒绝写release，而不是只检查unit文字。

迁移必须保存旧current、三个服务unit及容量unit/timer、运行目录属主模式和启用状态。若就绪失败，先停止新服务，将这些内容整体恢复，再恢复旧current和旧服务；单独回切代码不构成迁移回滚。旧凭据位置和旧版本在验证完成前保持完整，新凭据不进入发布包。

每15分钟容量任务维护 capacity.json 与 capacity-history.json（最多1344条，约14天），含 warning/critical/ok 和前一次状态；发生告警以非零退出进入systemd失败状态和journal。默认责任人为本机管理员，检查 `systemctl status qqqsp-capacity-check.service` 和 `journalctl -u qqqsp-capacity-check.service`；任务不自动清理未知数据。不使用本轮未明确选择的外部邮件或聊天推送。

恢复文件若是受限尺寸内的损坏普通文件，可在新有效行情到来后原子重建。原始字节保存在同目录 `.corrupt` 单槽文件，后一次损坏覆盖前一次隔离证据，最多占额外maxBytes。权限错误、符号链接、管道、超限文件仍拒绝处理；隔离期间检测到其他有效写入时重新读取合并。

前端源文件维持独立模块，scripts/build-static.mjs生成单一panel.bundle.js及UTF-16来源布局，减少首屏请求；先同步版本并构建，再冻结源指纹。覆盖率归因到原始源码，生成副本不重复加入分母。完整门禁分为syntax/calendar/deterministic/browser/coverage/linux六阶段，证据位于.verification，24小时有效且同一源指纹；最终打包重新检查日期相关日历。

如果浏览器在macOS完成、原生服务在Linux验收，将精确相同源码和.verification传到Linux Node24，再运行 `node scripts/check.mjs --deterministic --record`、`node scripts/check.mjs --native --record` 与 `node scripts/release.mjs --check`；不手工填写通过状态。Linux阶段不通过就不能创建生产发布包。


## v63 冷启动补全验收

v62第一次正式切换时，SSH中继尚未监听导致Yahoo请求转直连并限流，健康快照与日K回退存在但分时缺失；此情况已执行完整回滚并验证v61恢复分时。v63把已知缺失/失败的图表补全与正常休市15分钟节奏分开，60/120/240秒逐步退避，最高回到正常周期，并保留上游等待期限。取到完整图表后清除重试状态；明确不支持或合法空结果不无限重试。

成功价格不能再抹掉恢复文件中的非空历史；仅缺失图表按原成功时间回填并明确标记旧数据，实时价格与已成功图表保留新值。完整恢复后替换旧图表。

生产切换先确认中继127.0.0.1:8801/healthz正常。全球市场版本除readyz外，必须执行 `node ops/chart-smoke.mjs http://127.0.0.1:18667 'QQQ,SPY,^FTSE'`（隔离实例）及 `node ops/chart-smoke.mjs http://127.0.0.1:8567 'QQQ,SPY,^FTSE'`（正式实例），两者均要求QQQ/SPY/富时100有效报价、非空且非陈旧分时/日K；不能仅凭价格就绪判定完整上线验收。省略第三参数仅保留旧版本QQQ/SPY检查兼容性，不满足全球市场版本的发布要求。
