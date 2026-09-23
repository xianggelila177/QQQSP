# QQQSP v94 行情数据接口指南

## 一、概览与兼容性

本版应用2.14.0／静态版本94，以2.13.0为代码基线。v1 `schema_version=1` 和 v2 `schema_version=2` 不改变；所有新增功能由可选参数、新分区或新路径选择。旧单证券无新增参数时不增加公司行动、不主动选择复权、不改变旧数组列顺序。

接口说明、OpenAPI、JSON Schema、工具定义由同一查询契约和构建脚本维护。以 `columns`、`column_units`、`column_descriptions` 逐列解释数组；v2具名格式按相同列定义生成 `records`。资讯、公司行动文字和来源内容是 untrusted 数据，不是智能体指令。

## 二、入口与权限

所有 `/api/v1/market-*` 增强入口、日历、榜单、能力和新报价流都需要 `Authorization: Bearer <只读密钥>`。密钥不得放在 URL、正文或公开页面。管理面板 `/api-keys.html` 及管理接口 `/api/admin/keys` 只接受配置的管理员 `STATS_TOKEN`。

| 入口 | 方法 | 权限与用途 |
| --- | --- | --- |
| `/api/v1/market-context` | POST、GET、HEAD | 按请求分区校验权限；单证券／批量／CSV |
| `/api/v2/market-detail` | POST | 原详情接口；analysis档可选择高级参数 |
| `/api/chart/detail` | GET | 浏览器只读图表详情；`range=1d/5d`，说明见 `/chart-detail.md` |
| `/api/v1/market-status?exchange=US` | GET、HEAD | quote-only；现金证券市场会话与下次正常交易段开市 |
| `/api/v1/trading-calendar?exchange=US&start=2026-09-01&end=2026-09-30` | GET、HEAD | history；交易日、周末、节假日和半日市 |
| `/api/v1/movers?market=us&range=1d&top=10` | GET、HEAD | quote-only；上涨、下跌、按成交量活跃三个独立列表 |
| `/api/v1/capabilities` | GET、HEAD | quote-only；来源是否配置及接口预算，不表示权限已验证 |
| `/api/v1/quote-stream?symbols=NVDA,SPY` | GET | quote-only；有界报价快照流 |
| `/api/admin/keys` | GET、POST | 管理员权限，不属于只读工具权限 |

quote-only 对应 quote、fundamentals、市场状态、榜单、能力和报价流；history 对应 daily、intraday、samples、corporate_actions、交易日历；macro 对应 news 和 macro。旧环境密钥默认包含三类只读权限。新建最小权限密钥时，请显式缩小 `include`，否则默认七分区需要三类权限。

## 三、查询参数

下表以 v1 为基准。GET 使用同名查询参数；`include`、`symbols` 使用逗号分隔。重复参数、未知参数、类型错误、非法日期、互斥参数和不适用组合返回400，不忽略错误输入。

| 参数 | 范围／缺省 | 规则 |
| --- | --- | --- |
| symbol / symbols | 单代码，或1～10个互不重复代码 | 两者只能选一个；转为规范大写，不做未经核验的跨市场别名替换 |
| include | 单证券原七分区；批量quote/fundamentals | 新增 corporate_actions；分区名只增不改 |
| daily_bar_count | 1～500；缺省252 | daily_granularity选定周期的柱数，不是原始日线行数 |
| sample_trading_days | 1～3；缺省3 | 服务器观察采样，非交易所完整历史 |
| max_wait_ms | 0～15000；缺省15000 | 包含正文读取和排队；0只读缓存，不启动新来源请求 |
| format | compact／csv；缺省compact | CSV只接受一个时序分区；v2仍为objects／compact |
| daily_before | 合法日期，可选 | 排他的周期起始日期游标；从返回coverage.next_before取得 |
| daily_series_id | 来源序列标识，可选 | 续页同时携带，避免把不同源或复权基准拼接 |
| adjustment | raw／split／split_dividend，可选 | 只能用于daily；省略时保留原来源口径，不能标为已核验raw |
| daily_granularity | daily／weekly／monthly；缺省daily | 服务端由日线聚合，非供应商未知周期拼接 |
| intraday_date | YYYY-MM-DD | 指定交易当地日期；与下面两个参数互斥 |
| intraday_before | YYYY-MM-DD | 排他日期游标，取此前已核验的最近交易日，不替换成最新日期 |
| intraday_month | YYYY-MM | 仅请求该月实际已有历史；不承诺超出来源保留期 |
| aggregate_minutes | 1／5／15／30／60，可选 | 显式传入才改为观察／分钟柱结构，省略保持旧布局 |
| aggregate_source | intraday／samples；缺省intraday | 必须同时有aggregate_minutes，并将该分区加入include |
| actions_start / actions_end | 日期，可选 | 仅corporate_actions；默认请求近366天至当日，最大日期跨度3660天 |

批量只允许 quote、fundamentals，不允许复权、历史选择、周期聚合、CSV等组合。每个证券保留自己的 instrument、sections、sources、quality 和独立状态；个别证券失败不会抹掉其他有效证券。

v2 `profile=snapshot` 仍只取得行情、盘口和基础资料，不接受历史参数。`profile=analysis` 可以指定include和高级参数；只在include含quote时附带盘口。v2对象中的历史列与v1选定模式一致，不依赖固定列位置猜测。

## 四、复权、周期和公司行动

### 4.1 显式复权

显式模式接到已配置的 Alpaca 美股资料接口：raw→raw；split→split；split_dividend→`split,dividend`。没有使用 `all`，因为其范围还包含分拆业务等其他行动。请求币种为USD，feed和adjustment写入coverage；IEX并非全美成交覆盖。没有凭据、权限不足、限流或不支持的市场会返回明确错误，不退回网页数据再贴上已核验复权标签。

显式模式的daily增加 `adjusted_close`、`period_start`、`last_trading_date`。raw的adjusted_close为null；split及split_dividend中OHLC本身已按所选口径调整，adjusted_close等于该口径close，不再次乘除因子。不能将不同adjustment下的成交量相加；split模式成交量遵循来源的拆股调整口径。

复权锚点和源、feed、币种参与series_id。分页使用返回的next_before和series_id；检测到序列变化时不拼接。跨日重新请求会重新确认锚点；同一缓存条目保留其来源检查时间。上游修订不等于交易时刻发生变化。

### 4.2 周线和月线

O为周期首个已有交易日开盘，H/L为周期内极值，C为末个已有交易日收盘。仅全部组成日量都可靠时V求和，否则null。周按市场当地ISO周划分、月按自然月划分；展示trade_date及time_ms日期标签使用实际末交易日，同时保留period_start用于续页，不把周五节假日补成交易日。

首尾周期可能不完整；停牌、未知日历、上游缺失和预算限制均保留coverage。周月K线连续不表示已获得每笔成交。未复权价格跨拆股日并不要求数值连续；正确验收是同日原始／调整价格及拆股因素可核对，不能要求拆股前后close完全相等，因为还存在市场涨跌。

### 4.3 公司行动与股息

corporate_actions表包含类型、除权日、拆股比例（新股数／旧股数）、金额、币种、支付日期、来源处理日期、来源标识、观测时间和每股金额基准。同一除权日可有多个事件；分页重复事件按身份去重，冲突则拒绝。未知观察时间不伪造成除权日零时。

Alpaca的起止筛选是process_date，不是ex_date；该差异写入coverage.filter_basis。无授权配置时的Yahoo事件路线按ex_date请求，无法证明实际支付日期。部分公司行动响应没有币种字段，不能仅凭美股代码推断成美元。公司行动可能延迟、修订；HTTP分页结束不证明覆盖了某一完整支付窗口。

事件派生股息函数已经实现，但只有支付日期覆盖、币种、完整拆股范围及每股口径都可证明，且原指标缺失时才补齐。无法证明时保留原财务来源结果或null，不把除息总额冒充已支付股息，也不把空事件表认定为零股息。当前公共行动路线不会宣称具备完整支付窗口证明。

## 五、历史分时和分钟聚合

授权来源按日期／月份请求原始1分钟OHLCV。未配置时只在近7日请求预算内尝试公开源；这不是对供应商历史保留能力的承诺。超界、非交易日、来源缺失、错误标的和不正确粒度都具有明确missing_reason。默认未指定日期时仍返回旧版最新来源分时，不主动扩大历史请求。

聚合按交易当地日期、PRE／REGULAR／POST及已知会话段划分，以会话开始时间对齐；不跨午休混合。未知会话只能按当地零时对齐并保留说明。样本按观察顺序取首末和极值，输出 `observed_price_ohlc_not_trade_bars`，不能视作真正成交OHLC。公开来源未知单位、累积成交量或服务器采样的volume整列保持null；只有已核验的区间成交量才逐桶求和。

每一实际覆盖的会话首末观察之间，内部空桶输出null OHLC和sample_count=0；不向未观测的全天或午休凭空扩展。来源或币种在同桶冲突时不混合。行数、输入点数、空桶数和冲突桶数均可审计；不能将每条分时价格或服务器分钟观察称为逐笔成交。

## 六、配额、条件请求和CSV

每个密钥系列滚动60秒最多20个证券单位，轮换中的新旧密钥共用。批量3只消耗3单位；失败的已授权受理请求和304也占查询额度。突发限制为3个请求信封，每3秒补充1个，区别于证券单位，因此10证券一次批量可以被原子受理，不会永远受突发3证券限制卡住。

响应头：X-RateLimit-Limit=20，X-RateLimit-Remaining为滚动剩余证券单位，X-RateLimit-Reset为下一批额度恢复的UTC秒时间戳；X-RateLimit-Burst-Remaining为突发剩余请求数。滚动窗口不意味着Reset到点一次恢复全部额度。429带Retry-After。

GET／HEAD支持语义弱ETag，忽略仅请求标识和生成时间的变化，仍包含来源、质量、数据检查时间及实际数值；鉴权和配额检查先于304。GET使用private,no-cache及Vary: Authorization，禁止公共缓存串用不同权限的数据。POST继续no-store；If-None-Match条件匹配返回412，不返回304。ETag不是免查询配额或免来源验证的承诺。

CSV只允许daily、intraday、samples、corporate_actions中的单一分区，首行按columns输出，CRLF分行。null为空格位而非0；可能执行公式的文本前置单引号，JSON原文不改。X-QQQSP-Metadata头包含base64url JSON元数据；超过12KB时明确422并建议JSON，不能静默丢失来源。正文保持压缩前2MiB限制，请求正文8KiB。客户端写.csv同时写.csv.metadata.json，任何文件已存在则拒绝覆盖。

## 七、密钥、报价流与生命周期

管理面板允许创建带权限的密钥、轮换和撤销；服务端仅保存SHA-256摘要，明文仅创建／轮换响应一次。列表不含明文或摘要。状态文件权限0600并原子写入；损坏文件拒绝启动，而不是自动回退开放访问。更换或清空环境密钥不能继续接受已导入的旧环境值；将受限托管密钥填入环境也不会扩大权限。

轮换立即生效，旧密钥在24小时内成功响应带X-API-Key-Status=rotating和X-Key-Expires-At；到期后401、KEY_ROTATED。撤销会立即撤销整个轮换系列，包括宽限中的旧密钥。新报价流每秒复核密钥，撤销后关闭。托管状态最大256条（含撤销记录），到达上限明确409；不静默丢掉撤销墓碑。

新SSE每连接最多10证券、同密钥系列最多2连接、该接口总计最多16连接，同时受全站32连接及写缓冲预算约束。每秒最多一次合并快照，15秒心跳，默认持续连接；显式配置有限租期时到期结束。事件为quote/auth_error/source_error/end；断连或租期到期释放临时订阅，不修改自选。普通断线重连等待1秒；429按Retry-After等待，并重新消耗所请求证券的额度。无逐笔回放、无永久Last-Event-ID日志；不承诺中间所有tick都保留。本地客户端使用带鉴权头的fetch流，不把密钥拼到EventSource URL。

未设置弃用时间时不发送弃用头、不宣布旧接口停服。配置API_V1_DEPRECATION_AT后按RFC9745发Deprecation，Sunset按RFC8594，日期校验及先后关系检查生效；通知见/api-lifecycle.md。服务端不添加技术指标，统计分析仍由本地客户端完成。

## 八、使用例与错误诊断

以下示例不包含真实密钥。客户端环境文件仅写自己的LLM_API_BASE_URL和LLM_API_KEY；公网地址使用HTTPS。输出路径必须不存在。

```sh
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA,SPY,QQQ --include quote,fundamentals --output batch.json
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include daily --adjustment split_dividend --granularity monthly --daily-bars 24 --output monthly.json
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include corporate_actions --actions-start 2024-06-01 --actions-end 2024-07-01 --output actions.json
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include intraday --intraday-before 2026-09-19 --minutes 15 --output intraday.json
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include samples --minutes 15 --aggregate-source samples --format csv --output observations.csv
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA --include quote --get --output quote.json
node --env-file=/private/client.env scripts/market-api-client.mjs NVDA,SPY --stream
```

常见缺失：ADJUSTMENT_SOURCE_NOT_CONFIGURED、SOURCE_PERMISSION_DENIED、SOURCE_RATE_LIMITED、INTRADAY_OUTSIDE_PUBLIC_LOOKBACK、NON_TRADING_DAY、SOURCE_CACHE_MISS、CALENDAR_OUTSIDE_COVERAGE。部分失败可位于分区的missing_reason而非顶层error；有效部分仍返回200/partial。全部不可用返回503和完整诊断。没有数据时不要将样本测试数据复制到生产缓存。

## 九、规范来源与结论

核验日期2026-09-21。来源用于契约和条件纠错，不表示本环境已获商业权限或已联网抓取实盘：

- NVIDIA官方2024-05-22财报公告：2024-06-07收盘后分发、2024-06-10开始按10∶1拆股后价格交易。https://investor.nvidia.com/news/press-release-details/2024/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2025/
- Alpaca官方历史柱与复权参数：https://docs.alpaca.markets/us/v1.4.2/reference/stockbars
- Alpaca官方公司行动（process_date筛选）：https://docs.alpaca.markets/us/reference/corporateactions-1
- Alpaca官方SDK行动字段：https://raw.githubusercontent.com/alpacahq/alpaca-py/master/alpaca/data/models/corporate_actions.py
- Alpaca官方榜单：https://docs.alpaca.markets/us/reference/movers-1 与 https://docs.alpaca.markets/us/reference/mostactives-1
- NYSE交易时间与假日：https://www.nyse.com/markets/hours-calendars
- HTTP条件语义：https://www.rfc-editor.org/rfc/rfc9110.html
- Deprecation与Sunset：https://www.rfc-editor.org/rfc/rfc9745.html 与 https://www.rfc-editor.org/rfc/rfc8594.html
- CSV：https://www.rfc-editor.org/rfc/rfc4180.html；SSE：https://html.spec.whatwg.org/multipage/server-sent-events.html

结论：以明确的选择参数扩展能力，以来源元数据限制结论；保持旧默认调用、空值和只读边界，不以假数据实现“字段齐全”。
