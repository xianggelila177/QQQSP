# QQQSP 2.5 实施说明

## 一、概况

本版从2.4完整源码与此前2.5修改合并构建，保留行情、历史、期货搜索、响应式图表和每秒报价年龄。重点为宏观后台生命周期、证据分类、持久化与推送。完整部署和最终验收分别见根目录部署说明.md、docs/TEST-REPORT.zh-CN.md。

## 二、模块与改动

app.js是唯一组装根。lib/macro-monitor.js拥有采集时钟和检查点；macro-sse.js负责读取快照后的在线广播；macro-notify.js为可选HTTPS通知接收端。lib/macro-semantics.js先识别地区和调查类型，macro-analysis.js再分析及归组，避免英国调查被误套美国CPI规则。

lib/providers/macro-quotes.js负责替代观察来源，macro-context.js区分来源成交时间与服务器观察时间，macro-calendar.js保留确实提前采集的一致预期。前端panel-macro-controller.js独立维护宏观事件流，不再由详情展开启动采集；index.html新增后台状态标识并更新方法说明。

发布补齐初始快照schema、缓存成功时间语义和通知重试耗尽去重。默认配置集中在config.js，.env.example由scripts/env-example.mjs生成。前端资源版本78，已拼接并预压缩。没有新增运行时依赖、数据库或多用户调度器。

## 三、结论

开发与运行路径分离：测试可注入上游，server.js正式入口不加载测试fixture；安装器仅复制运行文件。旧实施笔记和测试证据保存在archive/baseline中，仅用于历史审计，不替代本版说明。当前覆盖的是程序正确性及有边界的事件分析，不是所有来源永远可达或交易信号有效性的证明。
