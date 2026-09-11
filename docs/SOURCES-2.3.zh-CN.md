# QQQSP 2.3 期货身份与来源依据

本说明区分产品身份核实、公开适配格式与实际网络联调，三者不是同一项结论。核实日期为2026-09-11；未保存或分发网上的实时价格样本。

## 一、NQ0W与纳指夜盘

未找到可确认 `NQ0W` 为标准行情代码的可靠金融来源，所以代码仅将其作为“相关产品”检索提示，不生成同名证券。可核实的产品为CME的E-mini Nasdaq-100 futures，根代码NQ；它与纳斯达克综合现货指数、纳斯达克100现货指数不同。

- CME产品说明（根代码NQ、合约定义、近全天交易及网页延迟数据）：https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html
- Google Finance的 `NQW00:CME_EMINIS` 页面：https://www.google.com/finance/quote/NQW00:CME_EMINIS
- 东方财富“小型纳指当月连续(NQ00Y)”页面：https://quote.eastmoney.com/globalfuture/NQ00Y.html
- TradingView的 `CME_MINI:NQ1!` 页面：https://www.tradingview.com/symbols/CME_MINI-NQ1!/
- 新浪页面明确注明“纳斯达克指数期货CFD(NQ)”：https://finance.sina.com.cn/futures/quotes/NQ.shtml

Google和TradingView只用于检索别名与产品线索，不是本版价格采集源。新浪CFD没有被接入为CME期货备源。NQ00Y与NQ=F是不同提供方的连续序列，不作相同换月、相同价格的承诺。

## 二、实现来源

本版使用独立JavaScript适配器，没有增加AKShare运行依赖，也没有复制其全量抓取流程。公开接口字段与品种市场号参考AKShare项目自身代码：

https://raw.githubusercontent.com/akfamily/akshare/main/akshare/futures/futures_hf_em.py

参考文件将NQ/ES/YM归入东财市场号103，GC/SI/HG归入101，CL/NG归入102。`COBOT`是东财接口路径中的拼写，不能按常识改成CBOT再假定接口相同。代码内的 `PUBLIC_DIRECTORY_ID` 是该公开查询格式使用的固定请求标识，不是用户的账户凭据，也不提供交易权限。

历史接口使用 `push2his.eastmoney.com/api/qt/stock/kline/get`，期货请求带对应 `secid`、`iscca`、`forcect`及期货字段；价格不乘股票小数系数。目录使用 `futsseapi.eastmoney.com/list/…`，按需请求单页并缓存；不后台遍历所有月份和全市场。目录字段的 `zjsj` 是前结算，不能称作股票昨收。

即时报价尝试 `push2.eastmoney.com/api/qt/stock/get` 的同证券命名空间；接口报结构错误或一般故障时尝试同一代码的期货目录报价。即时接口返回429/403或正在冷却时，不改用另一域名逃避限制。目录没有可靠成交时间，故其 `quoteAt` 为null；不拿检查时间构造价格年龄或分时采样。

Yahoo使用现有图表接口获取 `NQ=F` 等登记代码，校验返回证券代码和FUTURE类型。它没有改走股票快照，不与东财或CFD拼接。Yahoo接口仍可能限流。

## 三、核验边界

产品网页与AKShare源码能支持代码识别和适配设计，不能证明接口在用户服务器当前可达。本构建环境对三个上游API的访问均在域名解析阶段失败，记录见 `evidence/v2.3/live-network.json`；测试中的价格和K线由测试专用上游样本提供。

本版不是CME官方授权行情通道。延迟、数据覆盖、使用和转发权限以提供方实际约定为准；公开可浏览不代表允许无限调用或再分发。展示请求会服从限流等待，不保证免费源持续可用或每秒产生新价格。

## 四、扩展原则

新增其他品种，应先核实交易所、代码、来源市场号、价格单位和历史数据，再加入 `data/futures-products.json` 与相应测试。不能把远端搜索的任何字符串直接发布为“可用期货”，也不能把缺失月份或历史价格补造出来。
