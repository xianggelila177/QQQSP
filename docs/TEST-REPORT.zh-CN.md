# QQQSP 2.9 当前版本测试报告

版本：**2.9.0**；静态资源：**82**；日期：2026 年 9 月 12 日。

## 一、交付概况

本次在用户提供的 2.8 完整源码上实际修改并重建前端，按修复文档的 R01～R24 落地对应代码。保留单进程、零运行时第三方依赖，不把历史材料或尚未执行的验收当作本次通过结论。

原始压缩包 SHA256：`12ae3711b302350c0d8b6a61663c668fcdb3eb135bad450f3dcd19a5cc78a22f`。基线审计副本位于 `docs/QQQSP-2.8-完整审计与修复计划.md`；其中引用的外部审计证据不因复制报告而被视为已经随本次上传提供。

**代码修复与完整验收不是同一状态。** 本轮通过当前回归、受控故障注入、真实本地 Node HTTP/SSE 集成和浏览器交互检查；R10 的目标机器容量、R16 的干净依赖安装／实测覆盖率／支持矩阵、R18 的系统级实装仍存在明确验收缺口，不能将 24 项全部标记为“生产验收通过”。

## 二、逐项实现与证据

下表保留原文档问题编号，并把已实现内容与实际验证边界分开。文件路径未加目录的后端模块均位于 lib，前端模块位于 public/modules。

| 编号 | 本版实现 | 主要文件 | 验证结果与限制 |
|---|---|---|---|
| R01 | 逐证券实时可用性、较新合法来源选择、过期流允许备用检查；不改造成交时间。 | lib/stream-policy.js；realtime-quote-service.js；stream-pair.js；app.js | 心跳无成交、流延迟、断线／恢复、闭市及较新备用的受控测试通过；未连接真实付费流。 |
| R02 | 排队在内总期限、独立执行期限、共享任务读者取消；前端统一响应头／正文超时并保留旧图。 | lib/shared-task.js；task-queue.js；history-service.js；http.js；panel-history-store.js；panel-network.js | 排队超时、单读者取消、正文挂起通过；浏览器 45 毫秒故障注入在约 45～47 毫秒终止并保留 79 根旧柱。默认值非每个压力场景的严格墙钟承诺。 |
| R03 | 真实 HTTP 接入有界队列和客户端限额；来源队列可取消；两类 SSE 共享连接／缓冲预算。 | lib/http-admission.js；host-gate.js；stream-budget.js；sse.js；macro-sse.js | 超额 503、配额 429、客户端断开取消、排队任务不启动；50 次流连接关闭回基线；背压返回 false 不会错误释放连接。公网入口认证仍由部署者配置。 |
| R04 | 安全取得本地存储，失败切换内存实现并非阻断提示。 | public/modules/panel-state.js；public/app.js | 存储 getter、读、写入配额失败和损坏 JSON 四组浏览器检查通过，仍能添加自选。 |
| R05 | 历史检查点字段、日期、身份、元信息和条目结构验证；坏项跳过并记原因。 | lib/history-service.js | 缺失／null／错误类型、非法日期、旧 schema 等输入被拒绝；合法同文件证券仍可读取。 |
| R06 | 恢复服务独立创建父目录；历史／宏观共用原子写入工具，报价保留原有替换保护。 | lib/atomic-file.js；recovery-store.js；history-prewarm.js；macro-monitor.js | 嵌套新目录、0600 文件、重启恢复、拒绝目标符号链接通过；父目录允许安装器配置的 shared 链接。未模拟全部真实文件系统故障。 |
| R07 | 行情兜底改为可重排的单次定时器，接入时段、可见性、模式及重试等待。 | public/modules/panel-live-store.js；public/app.js | 休市省流 6.7 秒仅首次读取；切换快策略恢复刷新；暂停后调用数不再增长。未覆盖全部真实休眠设备组合。 |
| R08 | 显示时钟只有一个所有者；网络心跳不重复写时钟；闪烁使用动画 API。 | public/app.js；public/modules/panel-card-view.js | 5.25 秒观察到 5 次时钟写入；源码已去除价格闪烁 offsetWidth 强制布局。未测 12 卡连续变价下完整布局／长任务曲线。 |
| R09 | 健康读取延迟构造恢复数据；不可变恢复条目复用 bars；条目级字节计数。 | lib/redundancy.js；lib/recovery-store.js | 健康 25 次读取恢复 get 调用为 0；同版本数组 identity 稳定且不能修改；另附原版／新版同进程微基准。 |
| R10 | 先近端、再空闲扩展长历史；来源公平有界；预算计入原始行及聚合预留。 | lib/history-service.js；history-prewarm.js；config.js；app.js | 两证券近端优先和长历史延后测试通过；四证券浏览器预备与切换通过。12 证券首图／搜索 P95、满缓存 RSS、目标机预算和一小时稳态未验收，不能标记容量验收完成。 |
| R11 | 持久自选与在线连接所有者合并；普通 GET 不改名单；新增显式保存接口。 | lib/history-prewarm.js；http.js；sse.js；public/app.js | 独立所有者释放、超额名单可见、读接口不缩减持久名单、显式保存校验、清空／恢复通过。采用连接生命周期租约，不是多账户隔离。 |
| R12 | 宏观日历及因子按稳定标识更新节点，保留展开与焦点；删除后选择邻近目标。 | public/modules/panel-macro-context.js | 真实 DOM 相同快照、变化快照、删除事件及因子焦点／展开检查通过。 |
| R13 | 相应 API 统一 CORS 响应头、Vary 和方法策略；SSE 复用同一策略。 | lib/http-response.js；http.js；sse.js；macro-sse.js | 真实 Node HTTP 验证允许／拒绝 Origin、GET／HEAD／OPTIONS 和 SSE；浏览器原生跨域持续流因环境策略未验收。 |
| R14 | 健康诊断主机／角色从来源注册表生成，纳入两类新浪主机。 | lib/source-registry.js；http-diagnostics.js | 注册表断言通过；来源身份不再由诊断模块重复维护。未对真实新浪故障做在线切换实验。 |
| R15 | 配置统一白名单、范围及预算校验，入口向实际服务传递；更正 retryMs 参数。 | config.js；app.js；lib/search.js；providers/korean-search.js；.env.example | 配置到服务、期限、来源补充、磁盘路径和预算校验通过。未完成全项目静态类型检查／格式化。 |
| R16 | SSE 测试增量解析；维护测试入口统一；覆盖范围纳入组合根／配置；开发依赖版本固定并增加支持矩阵。 | tests/run.mjs；tests/support/read-sse.mjs；scripts/coverage.mjs；package*.json；.github/workflows/quality.yml | 237 项当前用例与 91 份保留回归通过；逐 UTF-8 分块通过。npm 安装受 DNS 限制；锁文件仅离线闭包校验，无实际覆盖率或 Node 24 执行结果，因此完整质量门禁验收未完成。 |
| R17 | 有界日志队列、重复错误采样、异步轮转；暴露日志、队列、SSE 和事件循环指标。 | lib/bounded-writer.js；log.mjs；app.js | 慢写入器、64 字节限额／突发丢弃／排空、错误后继续写入通过；旧日志轮转回归通过。未完成真实慢磁盘错误风暴长时压测。 |
| R18 | 当前安装器统一资源限制、失败回收、发布目录保留；容器探针读取实际 PORT／ready。 | ops/install.sh；ops/prune-releases.mjs；ops/healthcheck.mjs；Dockerfile | 隔离文件系统保留／字节预算、保护回滚目标、自定义端口和 200 但未就绪探针通过；未在 Linux systemd 或 Docker 完整实装升级回滚。默认资源限制需目标机验证。 |
| R19 | 普通滚轮允许页面滚动，组合键缩放；拖动绘图按帧合并。 | public/modules/panel-chart-controller.js | 普通滚轮、实际页面滚动、组合键缩放检查通过；既有图表键盘回归通过。未做真实手机手势人工验收。 |
| R20 | 新闻内容与元数据按当前自选释放，不再累积已删除证券。 | public/modules/panel-news-controller.js；public/app.js | 100 个不同证券增删／读取循环，非当前缓存被释放；测试场景峰值 1、结束 0。 |
| R21 | 加载状态、aria-busy、结果数量／重试；首次向上选最后项、向下选首项。 | public/modules/panel-search-controller.js | 真实 DOM 四结果首次上下键、慢查询状态与失败重试通过；既有 IME、回车及乱序回归通过。 |
| R22 | 移动端／粗指针图表模式按钮触控区统一并可换行。 | public/style.css | 320／375 像素视口两按钮均为 66×44 像素，无整页横向溢出；未进行所有放大文字组合或真机误触测试。 |
| R23 | 提示显式分类、单条替换；导出成功 role=status；更新提示含手动刷新操作。 | public/app.js；public/modules/panel-chart-controller.js | 实际 PNG 导出、成功语义、连续提示单条替换及关闭回归通过。 |
| R24 | 删除自选后恢复焦点，空态添加入口；定位已有标的不重连；统一时间与布局文案。 | public/app.js；public/index.html；public/style.css | 键盘焦点、删除最后卡片、可操作空态、已有标的 SSE 建连数不增通过；更正历史交易日与 UTC+8 报价时间说明。 |

## 三、实际执行结果

所有计数来自本轮最终通过日志。测试文件数与用例数不是同一计数单位，不把二者相加作为测试总数；43 个退役文件不计为通过。

| 项目 | 实际结果 | 证据路径（相对于 docs/evidence/v2.9-release） |
|---|---|---|
| 保留回归 | 91 份文件通过，0 失败；43 份明确退役 | tests.log |
| 当前核心 | 237 项通过，0 失败、0 取消、0 跳过 | tests.log |
| 2.9 新增专项 | 35 项，已包含在上述 237 项中 | tests.log、tests/v2/repair-v29-*.test.mjs |
| 语法／构建 | 350 个脚本语法通过；版本、构建产物、预压缩、配置及零运行时依赖一致 | check.log、build.log |
| 浏览器定向修复 | 17 组检查通过 | repair-browser.json |
| 四证券历史切换 | 16 次日／周／月／年切换成功，取源次数 8 → 8 | browser-final.json |
| 短时切换计时 | 14.2～30.8 毫秒，中位 29.5 毫秒 | browser-final.json |
| 页面尺寸 | 320、375、768、1024、1440、1730 像素无整页横向溢出 | browser-final.json |
| 页面 JavaScript 异常 | 已测试页面 0 项 | browser-final.json、repair-browser.json |
| 开发依赖锁文件 | npm Arborist 离线检查 18 个精确版本节点依赖闭包通过 | lock-validation.log |
| 干净开发依赖安装 | 未完成，registry.npmjs.org 解析失败 EAI_AGAIN | npm-install-failure.log |

环境：Linux x86_64、Node.js 22.16.0、Chromium 144.0.7559.96 built on Debian GNU/Linux 13 (trixie)、Python Playwright。历史切换计时包含点击处理及两次动画帧等待，前提是缓存已经准备好，不代表纯绘图 CPU、公网响应、首次冷启动或真实来源性能。本版近端＋长历史分层使合成四证券准备阶段各取源两次；点击四档没有再增加取源。

### 3.1 浏览器网络边界

浏览器测试执行真实构建产物及真实 DOM／canvas／输入行为，但该 Chromium 由管理策略禁止直接访问本地地址，原生导航报 `ERR_BLOCKED_BY_ADMINISTRATOR`。没有绕过浏览器策略。测试使用仅用于验收的本地 HTTP/SSE 转接器，把真实应用返回的合成上游结果送入页面；生产源文件不引入该转接器。

另有 Node 集成测试通过真实回环 socket 读取应用 HTTP/SSE，验证 CORS、容量、断开、正文超时、名单和流资源释放。两类证据互补，**不能合称原生浏览器网络端到端通过**。页面报告中的异常数组不包含转接器销毁阶段的 Playwright 宿主提示；原始日志保留便于复查。

### 3.2 恢复读取微基准

同一 Node 进程分别加载上传 ZIP 的原始恢复模块和新版模块，使用 12 证券、每证券两组各 1,500 根合成柱，预热 5 轮、测量 25 轮。每轮只测 12 次 `recovery.get` 同步调用。

| 模块 | 每轮中位值 | 每轮经验 P95 | bars 数组跨读取稳定 | bars 只读 |
|---|---:|---:|---|---|
| 上传的 2.8 | 34.521 毫秒 | 40.765 毫秒 | 否 | 否 |
| 2.9 | 0.0094 毫秒 | 0.0106 毫秒 | 是 | 是 |

新版不再每次复制整套图表，因此该非常窄的同步读取实验差异较大；**不将比例外推为网站整体速度、事件循环 P95、真实 CPU 或内存改善倍数**。独立测试还证明健康报价读取不会调用恢复 get。复现脚本为 `tests/v2/recovery_v29_benchmark.py`，需提供原始 2.8 ZIP；结果为 `recovery-benchmark.json`。

### 3.3 测试反馈记录

本轮先修正 SSE 测试只读取第一个网络块的错误假设；按新版真实交互更新内存存储、单条提示、显示时钟和分层历史相关测试样本，没有新增退役用例或取消真实业务断言。批量报价回归改为注入固定业务时钟，消除两次毫秒时钟读取恰好跨界对 90 秒冷却断言的干扰。

同时启动多套浏览器与完整回归的一次运行曾触发中继请求期限和批量调用断言失败，保留于 `parallel-run-not-passing.log`；隔离运行后相关检查通过。该记录不被解释为高负载场景已经全面验收。固定时钟前的另一失败记录见 `clock-boundary-run-not-passing.log`。当前最终通过记录仅为 `tests.log`，其他失败日志不覆盖也不冒充最终结果。

## 四、部署和兼容性变化

本版使用完整源码包部署，已构建资源随包提供；生产启动不需要开发依赖。实际安装命令、备份及回滚步骤以根目录 `部署说明.md` 为准。

持久后台自选是明确语义调整：已有 2.8 状态名单恢复为持久名单；显式增删或 POST 保存会替换它。不同在线页面只合并连接订阅，不会通过普通行情 GET 覆盖持久名单。单页面仍最多 12 项；后台合并默认 24 项，超额在状态接口可见。只打开一个新页面并不永久保存它的默认列表。

默认历史总期限 20 秒、上游执行期限 25 秒；总期限从排队起算，两个期限不是叠加。前端历史期限 22 秒；故障时保留旧图，来源冷却继续生效。冷启动先准备近端，空闲后扩展长历史；较长周期可能先显示可用但不完整的覆盖范围。

安装器默认保留 current、previous 加 3 个其他版本，并设 512 MiB 发布预算；保护锚点本身超额时告警而非删除。默认进程 MemoryHigh 512M、MemoryMax 768M 是初始配置，尚未以用户目标机器压测确认。64 MiB 缓存预留总预算不是进程 RSS 硬上限。

## 五、尚未完成的验收

以下项目未在本轮取得成功执行证据，应继续作为环境验收，不标记通过；不影响源码已经包含的修复实现，但限制了可宣称的完成范围。

| 项目 | 本轮状态 |
|---|---|
| npm ci 与完整 npm Playwright 套件 | 因 DNS 网络错误未完成。锁文件精确版本由离线方式整理并检查闭包，没有伪造 registry integrity 哈希；尚未下载验证所有包体 |
| 完整实测覆盖率 | coverage 范围和当前测试入口已更新；保留 80% 判定代码，但没有生成本版有效覆盖率，不能宣称达到 80% |
| Node 支持矩阵 | 已写 Node 22.16.0／24 工作流；本轮仅本地 22.16.0 实跑，未实际运行远程工作流或 Node 24 |
| 系统部署 | 未在用户服务器执行 systemd、Docker、真实升级失败恢复或回滚演练；仅完成脚本检查和隔离文件系统／探针测试 |
| 长时容量 | 未完成 12 证券、10 页面、一小时稳态、满缓存 RSS、搜索 P95 或真实慢磁盘错误风暴压测 |
| 外部及设备 | 未验证真实授权行情、付费日历、Webhook、反向代理、原生跨域浏览器流、Safari、真实移动设备或人工屏幕阅读器 |
| 全面结构整理 | 请求边界、来源策略、原子写入及预算等按修复提取；未完成全项目格式化、静态类型检查或彻底的 CardState／ChartState／CardView 重构 |

开发依赖的失败不会成为生产依赖，因为 dependencies 仍为空。工作流提供可复测入口，但配置文件的存在不代表远程工作流已经通过。

## 六、复现与交付结论

当前可复现的无第三方运行依赖检查从项目根目录执行；浏览器和覆盖率工具有单独的开发环境前提。

```bash
node scripts/verify.mjs
node tests/run.mjs
node --test tests/v2/repair-v29-*.test.mjs
CHROMIUM_BIN=/path/to/chromium python3 tests/v2/history_v28_browser_check.py
CHROMIUM_BIN=/path/to/chromium python3 tests/v2/repair_v29_browser_check.py
python3 tests/v2/recovery_v29_benchmark.py /path/to/qqqsp-v2.8-source.zip
```

完整源码交付为 `qqqsp-v2.9-source.zip`，不是要求用户逐文件合并的补丁。包内 SHA256SUMS 校验全部交付文件；压缩包哈希、独立解压检查及正式入口启动结果在包外 `QQQSP-2.9-交付校验.json` 记录，以免压缩包引用自身哈希形成循环。最终下载文件以对话附件为准。

本轮完成实际代码修改、版本更新和上述明确列出的验证，没有向远程仓库推送，也没有操作用户生产服务器。真实上线依据部署文档和环境验收结果，不能由受控自动化检查替代。

> 本报告与根目录《修复与验证报告-2.9.md》保持同一数据。旧 2.8 报告存放于 docs/historical。
