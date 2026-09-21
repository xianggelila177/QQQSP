# 证券搜索与日本股票数据（v95）

## 身份目录

科乐美支持 `科乐美`、`科樂美`、`Konami`、`コナミ`、`9766`、`9766.T`、`JPX:9766` 和 `TSE:9766`。全角字符及半角片假名先按 NFKC 归一。索尼、任天堂、丰田、卡普空等使用同一目录机制。

`data/jpx-equities.json` 来源为 JPX 官方英日上市名单，快照日期 **2026-08-31**，包含 **3,705** 条 Prime、Standard、Growth 普通股票。名单中的 7 条优先股及债券型类别股没有截断为普通股；ETF、ETN、基金和 PRO Market 也未混入该普通股目录。现有精选 ETF 目录照常保留。字母证券代码如 `130A.T` 可正常搜索。

- [JPX 英文名单](https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html)
- [JPX 日文名单](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html)
- [科乐美官方证券代码说明](https://www.konami.com/ir/en/baseinfo/)

来源文件哈希、目录日期和范围写在 JSON 元数据中。`scripts/import-jpx-directory.py` 可从新下载且日期一致的英日 XLSX 重建目录；开发环境需要 openpyxl，生产运行没有新增依赖。JPX 按月公布上月末目录，因此新上市证券仍可能需要来源搜索补充。目录确认上市身份，不代表每个行情供应商都覆盖该证券。

目录查询建立常驻索引。证券身份按 Map 精确读取，避免扩大目录后每次报价线性遍历数千只股票。市场导航保留精选示例，不把全部日股插入首页菜单。

## 搜索契约与故障

`GET /api/search?q=...` 保持原有数组响应。新增响应头：

- `X-Search-Status`：`available`、`partial`、`unavailable` 或 `empty`。
- `X-Search-Meta`：base64url 编码 JSON，包含每个已尝试来源的状态、结果数量及目录来源日期。
- `X-Search-Meta-Encoding`：`base64url-json`。

界面会区分“没有匹配证券”与“搜索来源不可用”，并提供重试。来源故障不抹掉目录命中。中文未知公司名会传给来源适配器；各来源是否支持该语言由响应决定。常用中文名通过经过确权的证券别名映射，未建立别名的公司仍可用官方英日名称或完整代码。

标准后缀代码未被搜索端点收录时，会查询 Yahoo 图表元数据确认证券。只有元数据的证券代码、证券类别和公司名称满足约束才返回候选，不凭输入拼出不存在的证券。代码参数按 URL 编码，例如 `M&M.NS`。

纯数字代码可能跨交易所重复，例如 `9766`。系统保留本地候选并继续查询来源以取得其他市场候选；完整 `9766.T` 指明东京。腾讯的 `BRK.B.N` 被保留为 `BRK-B`，不再截断为 `BRK`；`00700.HK` 归一为 `0700.HK`。

## 日本行情来源

新增 Naver 日本独立批量报价通路，使用网站公开端点 `https://polling.finance.naver.com/api/realtime/worldstock/stock/9766.T`。2026-09-21 已核验科乐美、索尼、任天堂、丰田及 `130A.T` 响应。

解析器必须同时确认完整 `reutersCode`、本地 `symbolCode`、`TYO` 交易所、`Asia/Tokyo` 时区、`JPN` 国家及 `JPY` 币种，才会接纳价格。成交时间来自 `localTradedAt`；来源检查时间单独记录。量、成交额与估值字段按供应商原始数值读取，不从本地显示字符串猜单位。

当前该来源公开声明延迟 **15 分钟**；示例响应建议轮询间隔 **70 秒**。输出保留 `feedDelayMinutes`、`feedDelaySource`、`isDelayed`，外层调度遵守 `pollingInterval`。节假日的最近收盘价保留真实成交日期，不把最新检查时间伪装成最新成交时间。

报价来源为 `naver-jp`，在 Yahoo 图表请求失败时仍能返回真实快照。日本历史日线与分时目前仍取决于 Yahoo 图表可用性；Naver 快照不会冒充历史曲线或盘口深度。此处是公开网站数据适配，并非已签约的交易所实时专线。

## 验证

`tests/v2/v95-search.test.mjs` 覆盖多语言/标准代码、全目录身份和来源日期、来源故障、未知中文路由、跨市场歧义、严格代码确权及美港代码归一。

`tests/v2/v95-japan-quotes.test.mjs` 覆盖日本代码与字母新股路由、原始时刻/延迟/币种、错证券/错市场/错币种拒绝、批量节奏及 Yahoo 失败时仍取得真实报价。

既有“无批量行情源”的测试示例从已新增支持的 `7203.T` 换为仍未支持批量源的 `VOD.L`，原断言保持，新增日本分组断言独立验证能力扩展。
