# v88 修复与验收记录

已于 2026-09-14 发布到 https://qqqsp.digital-reality.shop。公网 HTTPS、真实推送和浏览器检查均通过。

## 修复内容

- 改成逐字段、逐来源补充；部分成功不会提前结束，空字段不覆盖其他来源的有效值。
- 腾讯、Naver、Yahoo、Nasdaq 分别缓存与退避；已有 Finnhub 授权可启用，目前没有配置额外收费来源。
- 公开基础字段每分钟检查，财报数据六小时检查；两个后台任务上限，慢财报不会占满公开数据通道。
- ETF 份额与换手率、全部 11 只证券的 52 周高低价已接入；境内股本和 52 周列号已用腾讯官网解析代码核验。
- 财报计算区分滚动盈利、年度盈利、预测值；采用已公布季度 EPS 或明确归属普通股股东的净利润。计算值显示 ≈ 并解释公式。
- 派息采用实际现金支付记录；不把预期年化股息冒充滚动股息。
- 保留完整的上一交易日统计，阻止未开盘空值覆盖。新交易日出现有效统计后整体切换，不混用不同交易日。
- 界面显示部分取得、补充中、缓存待更新、不适用和缺失原因；161128 的委比注明五档范围。

## 验证结果

- 333 项核心测试通过；91 个历史回归测试文件通过；新增 26 项回归测试，基础信息专项共 63 项通过。
- 新增多信源处理模块：行覆盖率 100%，分支覆盖率 91.28%；各新增模块分支覆盖率均超过 80%。
- 构建、脚本语法、版本引用、压缩资源一致性检查通过。
- 最终候选和生产服务各连续采样 18 轮（约三分钟），同时检查真实 HTTP 与 SSE。
- 浏览器确认全部 11 张卡片，16/24 项同步切换、币种换算、来源说明及缺失提示；未发现横向溢出。
- 已发布的 151 个运行文件逐一计算 SHA-256，与本地最终源码一致。

## 仍未取得的项目

以下项目没有使用猜测值替代，详情见逐项验收表：

- 量比：未取得满足五日同口径分钟基准的数据。
- 美股及韩股委比：未取得符合明确档位范围的盘口数据；境内五档委比已接入。
- 每手数量：缺少证券对应的可靠下单单位，未统一硬编码成 1 或 100。
- 部分基金流通份额、部分证券滚动股息等：当前可用来源未提供，或该来源不支持；已记录备用尝试及失败原因。

这些数据覆盖限制，和此前有数据但被解析、合并逻辑丢掉的问题分别呈现。

## 交付与复测

- v88-field-audit.md：264 格逐项验收表。
- v88-field-audit.json：相同结果的结构化版本。
- qqqsp-v88-source-tests.zip：源码、固定真实样本和回归测试。
- v88-test-evidence/：失败复现、回归和覆盖率日志。

源码解压后执行：

```sh
npm ci
npm test
npm run test:fundamentals
npm run check
node ops/verify-fundamentals.mjs http://127.0.0.1:8568 live-result.json
```

## 发布与回滚

运行目录：/opt/qqqsp-v2/releases/20260914-fundamentals-v88。
回滚目录：/opt/qqqsp-v2/releases/20260914-fundamentals-v87。
current 指向 v88，previous 指向 v87。此次未购买数据服务。

## 关键来源依据

- [腾讯官网解析代码](https://st.gtimg.com/quotes/hs-fund/bundle.13362df9.js)
- [Naver ETF 基础接口](https://api.stock.naver.com/stock/QQQ.O/basic)
- [Nasdaq 财报页面：金额单位为 USD Thousands](https://www.nasdaq.com/market-activity/stocks/amd/financials)
- [Naver 韩股公司资料及 EPS 口径](https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=000660)
