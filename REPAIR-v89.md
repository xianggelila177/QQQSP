# v89 宏观报价刷新修复

本次针对宏观资讯中的纳指期货、WTI、布伦特、美债十年收益率和美元指数。基础信息 v88 保留。

## 已复现问题

- 东财期货目录 pageSize=1000 请求失败；pageSize=200 可返回有效油价。主报价超时时间还超过宏观候选等待时间，备用结果不能及时被采用。
- 一个缓慢因子阻塞整个宏观价格刷新任务；双层缓存的到期时间会造成额外空转周期。
- 成功取得的延迟备用报价会输给近期缓存的旧主源；网页也可能被较早发起的 HTTP 响应覆盖较新的推送。
- 上游偶发返回旧时间报价，保价逻辑却误报整个因子故障。

## 实现

各因子独立调度；东财目录采用有界分页、30 秒缓存，并在备用源成功后暂时优先刷新该源。增加 Naver 能源与 CNBC 公开报价备用，按来源合并批量请求、退避与限流。缓存保留原始检查时间，前端按进程启动时间与修订号防止旧快照回退。旧行情只记录诊断，不更新已保留价格的时间及有效期。

页面显示成功检查与下次检查的秒级时间，区分来源延迟、休市、服务器观察和真正过期。Naver 当前明确声明能源报价延迟 10 分钟；CNBC 只有时刻而无日期时不伪造成交日期。美债直接使用百分比收益率，不能用债券净价代替。跨来源或换合约会重建比较窗口。

## 重现与回归

需要 Node.js 22.16 或更新版本，生产使用 Node.js 24。

```sh
node --test tests/v2/macro-v89-*.test.mjs
node tests/run.mjs
node scripts/verify.mjs
node --experimental-test-coverage --test --test-coverage-include='lib/macro-*.js' --test-coverage-include='lib/providers/macro-*.js' --test-coverage-include='lib/providers/futures.js' tests/v2/macro*.test.mjs tests/v2/futures*.test.mjs
node ops/verify-macro-live.mjs http://127.0.0.1:8568 macro-validation.json
```

新增 18 项用例覆盖超大目录请求、慢因子、延迟标签、缓存到期、备用优先、旧响应/旧报价、证券身份、数值/单位/日期、空字段、429、停止恢复。真实验收脚本采样 18 轮，每轮间隔 10 秒，并验证 HTTP、后台任务和 SSE；价格是否变化单独统计，不把市场没有变价误判为系统故障。

发布版本保留 v88 回滚。详细线上测量见随交付的修复报告与验证 JSON。
