# 2.1 来源与实现参考

## 概况

此处记录接口格式调研依据，不把阅读开源实现当作完成真实上游可用性验证。适配代码为本项目独立实现，未引入参考项目框架或依赖。

## 已阅读的实现

- go-stock 行情与批量读取源码：https://github.com/ArvinLovegood/go-stock/blob/dev/backend/data/stock_data_api.go
- go-stock 韩国历史源码：https://github.com/ArvinLovegood/go-stock/blob/dev/backend/data/korea_stock_api.go
- go-stock 应用调度：https://github.com/ArvinLovegood/go-stock/blob/dev/app.go

参考点为同源合并证券列表、Sina/Tencent 接口形态、Naver 分钟与日线 XML 的字段含义。来源仍属网站公共端点，而非项目购买的交易所专线。

## 实际运行端点类型

| 来源 | 地址前缀 | 用途 |
|---|---|---|
| 新浪 | https://hq.sinajs.cn/list= | 批量价格响应 |
| 腾讯 | https://qt.gtimg.cn/q= | 批量价格响应 |
| Naver | https://polling.finance.naver.com/api/realtime/ | 韩国/美国网站报价 |
| Naver fchart | https://fchart.stock.naver.com/sise.nhn | 韩国分时与日线 |

Alpaca/Finnhub 保留上版适配，默认关闭。使用前自行核实账户权限与授权范围；本次没有验证真实账户。

## 结论

网站接口可能变更、延迟、拒绝或限流。程序只按公开响应和实际观察展示，不将请求成功冒充新成交，不承诺无限调用或跨市场一致的秒级覆盖。
