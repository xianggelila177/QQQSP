# QQQSP 2.5 最终测试报告

测试环境：Linux x86_64；Node.js 22.16.0；应用2.5.0；静态资源78。日期：2026-09-11。

## 一、验收概况

本轮将2.4完整交付与上一轮2.5修复整合为独立源码树，补齐HTML后台状态入口、前端构建、配置示例、发布验收脚本和部署方案。没有将旧ZIP重命名冒充新实现，也没有将上一轮局部测试结果代替本轮完整回归。

本报告区分受控上游测试、真实本地HTTP及浏览器，以及无样本的生产入口启动。构建环境的公共源存在DNS失败和超时；没有声明目标服务器五个真实来源已全部联通。

## 二、测试结果

| 项目 | 最终结果及证据 |
|---|---|
| 保留回归 | 91个文件通过、0失败；docs/evidence/v2.5-release/full-final.log |
| 核心测试 | 132个用例通过、0失败、0取消、0跳过；同上 |
| 新增2.5核心用例 | 较2.4的107个增加25个：上一轮22个，本轮发布缺陷3个 |
| 语法与构建 | 321个脚本语法、版本、模块拼接、预压缩和配置一致性检查通过；check-final.log |
| Python脚本语法 | 9个脚本编译检查通过；运行浏览器测试另需Playwright |
| 秘密扫描 | 0项发现；secret-scan-final.log。启发式扫描不等于绝对保密保证 |
| 宏观浏览器 | 无客户端启动即采集、折叠推送、展开缓存、调查归组、预期保存、断流兜底、恢复连接、失败暂停、转义检查通过；macro-browser.json |
| 图表浏览器 | 主备失败、四档历史、分时及采样、冷却提示通过；chart-browser.json |
| 期货浏览器 | 检索、加入自选、具体合约、图表及报价采样通过；futures-browser-results.json |
| 报价年龄浏览器 | 正常、工作线程静默及报错三种场景通过；browser-results.json |
| 正式入口启动 | 直接执行server.js，无测试上游注入；ready、资源78、宏观流、初始快照、正常退出及持久化通过；production-boot.json |
| 无浏览器持续采集 | 生产入口实际观察65秒，新闻轮次1→2、因子轮次1→3；检查点写入及正常退出通过；production-background.json。上游DNS/超时被保留，不视为行情连通成功 |

报价年龄每种场景采样4.6秒：正常最大相邻文字变化间隔1005.7毫秒，工作线程静默999.9毫秒，工作线程报错1000.2毫秒。不是长时间后台精确计时保证。行情流健康时没有报价轮询，允许宏观初始快照读取，并非整页零HTTP请求。

布局检查宽度为320、375、768、1024、1440、1730像素，受控数据下无整体横向溢出。观察了输出截图；测试页显式标注模拟数据，真实生产入口不插入该提示或测试价格。

## 三、修复循环与测试口径

新增的三个发布回归先在已有2.5代码上失败，再修复通过，记录在release-repro-before.log和release-repro-after.log：初始宏观资讯快照缺少analysisVersion；来源失败只返回旧资讯时仍把成功时间写成现在；通知五次失败后，下次采集将同一事件重新入队。

构建过程中也纠正了旧测试仍要求“宏观折叠即停止采集”、未隔离状态文件、浏览器测试样本结构不完整等问题。现在后台默认开启的真实路径由宏观HTTP、监控生命周期、浏览器和生产入口专门覆盖；仅与宏观无关的旧报价测试关闭后台并隔离状态，避免网络及文件污染，未修改生产默认值。

一次全量过程出现原有relay测试中一秒本地子进程成功请求超时；未更改其生产逻辑、断言或超时阈值，单独原样复测和最后完整回归均通过。relay不是本版默认运行链路。该短时用例有环境调度敏感性，不能从最后通过推断长时间网络稳定。

现有43个旧套件按tests/retired-v72.json保留退役理由及替代路径，不计为通过；本轮未新增退役项。核心总数132与保留文件数91不能相加称为223个同类测试，因为计数单位不同。

## 四、浏览器验证边界

浏览器使用真实已构建页面代码。图表、期货和宏观测试由真实Node HTTP/SSE处理受控上游。当前管理环境的Chromium阻止直接导航localhost，因此使用仅存在于tests/v2/browser_bridge.py及旧浏览器测试脚本中的网络转接，把真实本地HTTP响应送入页面。

该转接不是生产代码，未替换生产服务数据，但也不是原生EventSource经过真实域名、Safari、Cloudflare或Nginx的完整端到端验收。Node验收脚本另外用原生fetch直接读取真实本地事件流。基本年龄测试为完全离线注入固定行情，不能用于证明真实供应商延迟。

## 五、可复现命令

```bash
node scripts/verify.mjs
node tests/run.mjs
node --test tests/v2/macro-v25-regression.test.mjs tests/v2/macro-v25-monitor.test.mjs tests/v2/macro-v25-sources.test.mjs tests/v2/macro-v25-release.test.mjs
python3 tests/v2/browser_check.py
python3 tests/v2/chart_browser_check.py
python3 tests/v2/futures_browser_check.py
python3 tests/v2/macro_browser_check.py
python3 tests/v2/packaged-boot.py
```

浏览器脚本需要开发环境安装Python Playwright且能找到Chromium；用CHROMIUM_BIN指定已有浏览器。它们不是生产运行依赖。packaged-boot.py只使用Python标准库，直接启动生产入口，隔离真实配置、日志和状态，没有注入上游样本；加--background可观察65秒无浏览器时的调度轮次。

部署后的node ops/macro-smoke.mjs --live属于真实来源验收，不在受控测试结果里替代执行。程序构造的测试价格、新闻和密钥占位符没有安装到运行目录，安装器不复制tests和docs。

## 六、发布结论

本版源码、构建和自动化回归已通过上述验收。最终ZIP的解压校验、正式启动、正常退出及SHA-256结果另记录在包外“qqqsp-v2.5-交付校验.json”，避免文件自身校验的循环依赖。

尚未在用户服务器进行systemd安装实操、真实付费日历与Webhook接收端联调、真实隧道/原生系统离线通知、Docker构建、长时间稳定性及交易收益验证。对于来源不可达、时间未知或日度数据，交付要求是保留真实错误与口径，不是补造同步行情。
