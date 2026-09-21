# QQQSP 2.16.2 / v98：指数批量查询与 SOXL 来源修复

## 实际复现的问题

| 问题 | v97 复现证据 | 修复 |
| --- | --- | --- |
| 混合批次被整单拒绝 | `AAPL + ^SOX`、`AAPL + ^GSPC` 返回200；`^SPX` 单查或加入批次返回400。并非所有 `^` 指数都不支持 | 搜索与 API 共用明确的别名规范；`SPX`、`^SPX` 转为 `^GSPC` 后再验证 |
| 搜索结果无法查询 | Yahoo 可返回 `^SPX`，但市场识别只接受 `^GSPC`；规范化后的类型与市场还使用旧代码计算 | 返回统一身份并去重；不展示无法识别市场的指数候选；不猜测其它指数别名 |
| SOXL 盘前停留旧价 | 腾讯返回 `SOXL.AM`，价格123.67，时间2026-09-18 16:00:01美东；现有映射仅处理 `.OQ`、`.N`，无法找到 Naver | 通过来源的证券身份确认真实路由 `SOXL.K`，取得盘前报价并按来源间隔轮询 |
| 未来时间压过真实盘前报价 | 实际09:28时，腾讯把旧收盘123.67标成当天09:30；异常时间被当作更新的数据，阻止备源选用 | 解析、选源和最终发布均拒绝超出5秒容差的未来时间；继续查询备源，允许正确但更早的真实时间恢复 |
| 标普500只有旧缓存 | `^GSPC` 参数有效，但线上 Yahoo 回退旧缓存，单查503 | 加入已核验的 Naver `.INX` 指数路由，严格检查代码、市场、时区、来源时间和指数身份 |

2026-09-21 的只读上游核验确认：Naver `SOXL.K` 在美东09:19:00已有盘前132.27，响应检查间隔7000毫秒；标普 `.INX` 返回 `symbolCode=SPX`、`NYS/EST5EDT/USA`，指数单位为点。以上只是复现时的记录，不是固定报价或实时行情承诺。

来源证据：[SOXL身份搜索](https://m.stock.naver.com/front-api/search/autoComplete?query=SOXL&target=stock)、[SOXL基本资料](https://api.stock.naver.com/stock/SOXL.K/basic)、[SOXL报价](https://polling.finance.naver.com/api/realtime/worldstock/stock/SOXL.K)、[标普500基本资料](https://api.stock.naver.com/index/.INX/basic)、[标普500报价](https://polling.finance.naver.com/api/realtime/worldstock/index/.INX)。

## 接口兼容

```json
{
  "symbols": ["NVDA", "^GSPC", "^SOX"],
  "include": ["quote"],
  "max_wait_ms": 5000
}
```

用于 `POST /api/v1/market-context`；同契约 GET 需正确 URL 编码 `^`。结果保持请求顺序，每项独立说明数据状态。输入 `^SPX` 时返回的证券身份为 `^GSPC`，两个 SDK 均按规范身份检查。未知代码、非法参数，以及规范后重复的 `^SPX + ^GSPC` 仍拒绝，不把无效输入当作可用证券。

v2 `market-detail` 保持单证券 POST 契约，接受相同别名。批量仍最多10只，仅支持 `quote`、`fundamentals`，按证券数消耗配额。

指数来源时间为 `provider-published`，不是逐笔成交时间；不将新获取时间冒充成交时间，也不把 SOX 特有发布时段套用于标普500。盘前没有当日指数分时就保持缺失，不把上一交易日分时伪装为今天。

## 验证和部署

针对三个报告先添加失败复现，再根据反馈修改。定向回归：`npm run test:v98`；相关旧用例覆盖指数身份、快照轮询和原接口约束。构建与静态校验后部署，不运行压力测试或整套浏览器测试。

线上连续观察又捕获腾讯09:30未来时间问题，因此补充失败复现并再次修改，而不是仅以接口200或来源检查时间变化判断修复成功。最终核验同时检查实际报价时间没有越过当前时间、当天报价已取得、来源轮询持续推进。

部署保留域名、端口、`.env`、Finnhub凭据、管理员及只读API密钥、自选、采样与日志。独立目录发布，切换前备份共享状态，保留v97目录及回滚脚本。GitHub只包含源码、构建资源、测试和说明，不包含线上配置、密钥或私人运行数据。
