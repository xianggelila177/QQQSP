# API 生命周期公告

## 一、当前状态

2.14.0保持v1与v2接口同时可用。本版没有宣布任何默认弃用日或停服日，schema_version维持原值；新增参数及数据段均为可选。

## 二、配置与语义

部署者可在自己的服务上设置API_V1_DEPRECATION_AT和可选API_V1_SUNSET_AT，格式为有效UTC时间（例如YYYY-MM-DDTHH:mm:ssZ），停服公告时间不得早于弃用时间。Deprecation按照RFC9745使用结构化日期`@<UTC秒>`；Sunset按照RFC8594使用HTTP日期。Link指向本说明。

这些头是部署者声明，不会自动删路由或终止进程；应先通知调用方、保留兼容窗口并实际迁移。v2不会继承v1弃用头。只改变应用版本不代表数据schema发生破坏性变化。

## 三、迁移与结论

只读客户端应读取公告及响应头，保持对新可选分区的容错，以columns解释时序。需要破坏性变更时应新增schema和迁移文档，不能在原默认形状中直接替换含义。

规范：https://www.rfc-editor.org/rfc/rfc9745.html 、https://www.rfc-editor.org/rfc/rfc8594.html。
