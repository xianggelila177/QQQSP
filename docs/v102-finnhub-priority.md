# v102 Finnhub 优先与区间成交量

- 美股报价先读取 Finnhub REST；实时 Finnhub 成交流仍可覆盖更新。报价时间、盘前盘后时段及前收盘独立标注。Finnhub 未提供累计成交量时不补造。
- 美股 K 线先尝试 Finnhub。无分钟 K 线权限时，先查 Nasdaq 公共历史；若分时只有价格点、没有区间量，继续使用 Naver 美股分钟 K 线的 `tradingVolume`。Yahoo 排在最后。各来源使用自己的标签，不拼接跨源 K 线。
- Naver 的 `accumulatedTradingVolume` 是累计量，不作为区间量。常规时段投影包含来源以 16:00 标记的收束桶；Yahoo 以 16:00 开始的桶仍排除。
- 2026-09-23 对现有服务器账户实测：Finnhub `/quote` 为 HTTP 200，`/stock/candle` 的 5 分钟与日线均为 HTTP 403。403 只使 K 线适配器冷却，不使同凭据的报价或财务指标冷却。Naver AAOI 5 分钟端点返回逐桶 `tradingVolume`，含常规收盘桶。
- 日/周/月/年历史使用同一来源的日线；Nasdaq 可用时优先于 Naver/Yahoo。数据状态与来源按响应显示，权限或覆盖缺失时保留缺失态。

发布沿用 `releases/current/previous/shared` 布局，不改共享 `.env`、API 密钥、状态目录、域名或代理端口。验收需分别检查服务、报价来源、常规图表 `volumeQuality` 和五日区间量。
