# 图表详情只读接口（v100）

`GET /api/chart/detail?symbol=AAOI&range=1d` 返回当前报价缓存、常规时段图表、真实一档盘口状态和服务器已接收的成交片段。`range=5d` 另外获取最近五个实际交易日的分钟 OHLCV。此浏览器接口使用现有请求队列、证券代码校验和超时预算，无需在前端放置供应商密钥。

字段口径：

- `quote.price` 与 `quote.change` 使用最新报价和其对应交易日的上一交易日常规收盘；盘前、盘后价仍可作为大价格。`quote.ext.pre` 相对上一交易日常规收盘，`quote.ext.post` 相对本日常规收盘。
- `chart.bars`、`fiveDay.bars` 只保留交易日历定义的常规会话。`regularSessions` 保存毫秒时间边界；`tradeDate` 是图表日，可能与最新报价交易日不同。Yahoo/Finnhub 的分钟 bar 使用起始时间，16:00 开始的桶不作为常规 bar；Naver 美股分时使用收束时间，16:00 收束的桶保留。
- `chart.previousCloseReference` 使用图表日的上一交易日常规收盘；五日使用第一日的前一交易日收盘。缺失时数值为空，不以首个价格点代替昨收百分比。
- `fiveDay.days` 恒列出五个交易日槽位，每日标明 `ready`、`partial` 或 `missing`。`coveredDays` 只计确实拿到价格数据的交易日。已配置 Alpaca 时可提供同源 1 分钟 OHLCV；否则依次尝试 Finnhub、Nasdaq、Naver 美股分时、Yahoo。IEX 是单交易所覆盖，SIP 是汇总覆盖；不同来源不拼接成同一五日曲线。
- `volumeQuality` 区分已核验区间成交量、部分覆盖和缺失。Nasdaq 价格点没有区间量时 `v=null`；`0` 是有效零成交量。Finnhub K 线、Naver 美股分时的 `tradingVolume`、Yahoo、Nasdaq 历史及 Alpaca IEX/SIP 的美股股票与 ETF 股数经过来源契约核验；Naver 的 `accumulatedTradingVolume` 不用作区间量。
- `book` 经证券、币种、事件时间、来源、覆盖范围与数量单位校验。`SOURCE_HAS_NO_BOOK` 明确表示来源没有盘口。单交易所行情不会标成全市场最优报价。
- `tape.events` 来自原始成交流的有界内存缓存，仅维护已订阅标的，并按目标图表日常规时段过滤。`status=partial` 与 `coverage.scope=received-stream-fragment` 表示已接收片段，不能当作全天全部成交。成交方向不可得时 `side=null`。无供应商唯一 ID 的事件注明重连去重限制；取消和更正事件保留报告状态。`tape.stream` 给出连接健康及故障码。

HTTP 200 可同时包含部分或缺失能力。请逐项检查 `chart.status`、`fiveDay.status`、`volumeQuality.status`、`book.status`、`tape.status`、时间戳和原因，不能把整体成功响应当作各字段都完整。来源限流后的五日请求会按冷却时间重试，缺日不补造。
