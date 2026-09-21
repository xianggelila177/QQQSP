> **v94更新**：应用2.14.0保留本文旧默认调用；可选高级参数、多密钥、配额、条件GET、CSV和报价流以[完整新版指南](market-api-guide.md)为准。旧文中单密钥及仅POST的描述仅对应此前能力，不表示新版缺失。

# 证券详情与本地智能体接口 v2

## 一、概况
该接口将成交、盘口、统计和财务证据分开返回，默认只请求详情快照。旧 `/api/v1/market-context` 保留；新增字段为兼容性扩展，使用严格自定义旧结构的客户端应同步更新字段定义。

生产代码不会使用测试样本填补缺失。`partial` 表示有效但不完整的返回，不是失败；不得据此自动补零或推算未知数据。

## 二、调用

```http
POST /api/v2/market-detail
Authorization: Bearer <LLM_API_KEY>
Content-Type: application/json

{"symbol":"NVDA","profile":"snapshot","format":"objects"}
```

`symbol` 必须是服务器支持的规范证券代码。同名公司在不同市场的证券不能自动替换，例如不能仅凭中文名称将截图中的 SKHY 等同于另一个市场的证券。

|参数|默认与范围|说明|
|---|---|---|
|profile|snapshot / analysis|snapshot 仅报价、独立盘口和财务；analysis 增加分时、日线、服务器采样、缓存资讯及宏观|
|format|objects / compact|objects 的序列位于 records，对象具名字段；compact 使用 columns 与 rows 对齐|
|daily_bar_count|252；1～500|仅分析档位的日线窗口；不是承诺返回足额历史|
|sample_trading_days|3；1～3|服务器已经保存的采样交易日，不是历史成交明细|
|max_wait_ms|快照5000，分析15000；0～15000|包含排队；0仅查询已缓存数据；不是源行情延迟保证|
|daily_before|可选日期|分析档位续页的排他性日期上界，采用前一页 coverage.next_before|
|daily_series_id|可选字符串|采用前一页 coverage.series_id，防止翻页混用来源口径|

两个接口共用原有每分钟20次、突发3次限额，以及全局1个执行、2个等待的队列。请求正文最多8 KiB，未压缩响应最多2 MiB；超出返回明确错误而非静默截断。`Retry-After` 必须被客户端尊重。

## 三、返回结构

顶层字段为 `schema_version:2`、请求标识、生成时间、状态、证券身份、分段数据、来源字典、质量报告和定义。证券身份包括市场、交易所、时区、原生币种和价格单位。接口不按网页的人民币或美元显示偏好换算原生价格。

分段包括：`quote` 最新成交及正常时段统计；`order_book` 买卖最优一档；`fundamentals` 固定24项财务及统计字段。分析档位另外包含 `intraday`、`daily`、`samples`、`news`、`macro`。分时保留最新来源交易日，日线是日期标签，服务器采样是观察值，三者不能互换。

每段都有状态、来源引用、资料时间、成功检查时间、声明延迟、覆盖范围及缺失原因。`generated_at_ms` 仅是响应生成时刻；不应当替代成交或财报时间。

### 财务字段
字段目录由 `/api/v2/field-catalog` 返回。每个字段都有中文标签、说明、单位及分组；数值缺失时字段仍存在。字段状态 `not-applicable` 表示当前证券类型不适用，不能计入缺失分母；明确亏损及非正净资产也不是普通的数值缺失。

计算依据包含公式、输入数值、输入来源、财务期间、股本分母及股本时间。供应商未提供某项依据时仍为 null；此次修改不会凭空产生缺失财报或股本日期。来源尝试和重试时间经过白名单投影，不透传内部请求对象或密钥。

`quality.missing_fields`、`stale_fields`、`conflicting_fields` 用于快速筛选，最终解释仍应读取对应字段的状态、时间和原因。

### 买卖盘口
买卖价格、数量、交易所代号、盘口时间与最新成交独立。当前新增路线为已配置的 Alpaca quote 消息/快照，以及腾讯沪深报价中已经使用的盘口字段布局。其他市场没有经验证的盘口时返回缺失。

Alpaca 数量保留 `round_lots`，不强行换算成股，更不能固定认为一手等于100股；腾讯沪深适配保留 `lots`。`single-exchange` 不等于综合市场最优报价。没有可用完整订单簿时不计算完整委比。

盘口时间倒退不覆盖较新的盘口；盘口更新也不刷新最新成交的时间。买价大于卖价时保留冲突标记，不输出伪正常价差。

## 四、客户端与错误处理

```sh
node --env-file=/private/client.env scripts/market-detail-client.mjs NVDA --output nvda-detail.json
node --env-file=/private/client.env scripts/market-detail-client.mjs NVDA --profile analysis --format compact --daily-bars 500 --output nvda-analysis.json
```

私有环境文件只需 `LLM_API_KEY` 和 `LLM_API_BASE_URL`。HTTPS 用于公网；HTTP 仅允许本机回环地址。客户端不跟随携带密钥的重定向，校验证券身份、响应版本及完整字节数；输出新文件使用0600权限且拒绝覆盖已有文件。输出文件必须完整交给智能体，不应从聊天界面截断片段计算。

退出码0表示完整或部分可用；2表示全部不可用但仍输出诊断数据；1表示请求或保存错误。鉴权失败、超额请求、格式错误不会被当成有效证券数据。

## 五、集成总结
工具定义见 `market-detail.tool.json`，OpenAPI 地址 `/api/v2/openapi.json`，JSON Schema 地址 `/api/v2/market-detail.schema.json`。工具定义仅描述参数，需要智能体的工具执行器实际调用 HTTP 或提供的 Node 客户端，不等于自动安装扩展。

网页“完整数据”窗口使用 `/api/detail?symbol=...` 读取缓存投影，绝不向浏览器分发 LLM_API_KEY。管理密钥只用于自选写入；只读智能体密钥不能修改服务器自选。
