# QQQSP 2.7 图表时间错位：复现、修复及边界

## 一、问题概况

用户截图的卡片时间为22:16，Nasdaq分时历史最后时刻却为18:16。原有要求是界面统一UTC+8、quoteAt与检查时间分离、不得伪造历史点。本轮以完整2.5源码与已交付2.6改动组成基线，增加真实形态样本、模块回归和浏览器验证，不重写其他行情功能。

本轮没有取得用户线上原始Nasdaq响应；因此可以确认的是：已在源代码和受控响应中复现与截图一致的四小时错误路径，不能从截图断言所有线上时间差都有同一个原因。

## 二、根因与修复

原parseNasdaqIntraday直接使用row.x作为UTC毫秒/秒，忽略row.z.dateTime。提供“美东墙钟编码”的图表横坐标时，美东10:16被当作UTC10:16，前端加北京时间偏移后得到18:16，而应先转换为UTC14:16再显示22:16。

| 输入/状态 | 2.7规则 |
|---|---|
| 带完整日期及来源标签 | 显式偏移或UTC/EDT/EST优先；普通ET按America/New_York和当天规则转换 |
| 标签仅有时间 | 用x提供的日期锚定；若x本身已是与美东时钟相符的UTC时间，保留，避免二次转换 |
| 数值x没有标签 | 保持原始epoch，标记epoch-unverified，不凭截图对全部数据加小时 |
| 标签非法、未来时间、无法消解的夏令时重复时刻 | 不生成虚构时间；对应无效点不进入有效分时 |
| 日/周/月/年K | 日线仍按来源交易日期，周期聚合逻辑不平移 |
| 已存旧Nasdaq分时 | 恢复时仅清除缺少新契约的Nasdaq分时数组，重新获取，不损坏其他数据 |
| 轴末刻度遗漏 | 采样刻度包含可见数据首尾，避免最后一个刻度停在较早时间 |
| 实际历史陈旧 | 保留原历史时间及陈旧提示，不“校正”为最新报价时间 |

新timeContract为nasdaq-label-et-v2，随源数据、慢字段和恢复文件保留。前端状态注明“北京时间 UTC+8”，日周月年注明“交易所交易日”。没有修改quoteAt、sourceCheckedAt或强制改变服务器系统时区。

## 三、测试反馈循环

第一轮13例包含4个原本正确的控制组；旧版9例失败，包括四小时截图路径、冬季五小时、跨午夜、时间标签校验与主机时区差异；修改后13例通过。随后加入慢字段契约传递、真实陈旧保护、夏令时跳转边界、时间秒数、最右时间刻度和恢复文件测试。

旧缓存组3例在修复前2例失败、1例控制通过；元信息传递与末端刻度也分别记录单个失败再通过。最终本轮新增22个核心用例全部通过，见time-targeted-final.log。旧失败日志保留，不修改为通过。

浏览器初次验证暴露的是测试夹具错误：批量快照返回了数组而不是{quotes}、冻结的测试时钟阻止请求门控前进、页面离屏绘制导致plot暂空，以及canvas选择器匹配两个画布。修复夹具为真实契约、单调前进的模拟时间、滚动到可见画布后验收；没有为使测试通过取消生产请求间隔或离屏优化。

## 四、浏览器与真实入口

新测试运行实际createApplication、真实本地HTTP/SSE、实际编译后的bundle，只有上游返回测试样本。Chromium策略阻止直接访问localhost，所以使用tests内的本地网络转接；不能称为原生Safari或真实Cloudflare端到端验收。浏览器时区设置为America/Los_Angeles，仍要求所有卡片及分时显示北京时间。

四个标的LITE、AAOI、ALAB、INTC的来源10:16 ET统一显示22:16；四档K线正常，六种宽度无页面横向溢出，画布确实绘出22:16末刻度。另运行股票图表、宏观、期货和独立年龄旧浏览器套件。

无样本的正式server.js、宏观持续采集和状态保存由最终ZIP解压后的packaged-boot.py --background验收，包外记录保留实际结果。公共接口在构建环境存在域名解析失败，不能以样本代替真实来源连通证明。

## 五、文件与来源

核心文件：lib/providers/nasdaq-time.js、public-history.js、lib/chart-enricher.js、recovery-store.js、public/modules/panel-chart-controller.js、panel-chart-engine.js。诊断：ops/chart-time-smoke.mjs。测试：tests/v2/chart-timezone.test.mjs、chart-time-cache.test.mjs、chart-time-browser-server.mjs、chart_time_browser_check.py。

外部核对仅用于理解字段与实现方法，不复制外部模型或代码：
- https://github.com/gialdetti/capon/blob/7773c451f7c9f85486ad15f5e270e559943a281c/capon/backends/nasdaq.py （可见其读取z.dateTime；不是Nasdaq官方时间契约）
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat （显式timeZone的标准接口）

本地Intl运行验证覆盖夏冬令时及转换边界；未将第三方实现本身当作真实行情时效证明。

## 六、结论

本轮定位并修复了解析、元数据、缓存和坐标刻度中的可复现缺陷，包含上一轮宏观修复。上线检查实际来源时刻；若历史确实比报价陈旧，应排查刷新/限流而不是强行移动时间。没有承诺公共来源永不失败或K线每秒都有新成交。
