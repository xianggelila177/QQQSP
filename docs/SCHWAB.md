# Schwab 美股主源（v125）

在服务端私有配置中启用：

```dotenv
SCHWAB_ENABLED=1
SCHWAB_ENV_FILE=/opt/schwab/schwab.env
SCHWAB_TOKEN_FILE=/opt/schwab/token.json
```

`schwab.env` 保存 SCHWAB_CLIENT_ID 与 SCHWAB_CLIENT_SECRET；`token.json` 为首次 OAuth 授权兑换后的完整 token 响应，也接受 schwab-py 的 token 包装格式。目录权限 700、文件 600，由应用服务用户持有。不要提交、打印或公开这些文件。原文档的 quote.sh / refresh.sh 不作为运行依赖，也不要与应用同时轮换同一 token。

Schwab 开关开启后，普通美国股票与 ETF（当前仅纯字母数字代码）的批量报价和日线、1/5/15/30 分钟线优先使用 Schwab。各源有独立失败窗口，主源不可用时继续使用原有 Finnhub / Naver / Tencent / Sina 报价，以及原有历史备用源。其他市场、指数、期货、含分隔符的特殊代码保持既有来源。新闻保持原有来源。基本面目前接入可明确映射的 52 周区间，其余财务字段继续使用既有来源，避免混淆单位和报告期。

报价每 5 秒最多更新一次，同批共享结果；所有 Schwab REST 请求共享至少 750 毫秒启动间隔，最多 8 个请求，超时 10 秒。请求上限是本应用的保守预算，不是账户额度或实时性承诺。实时标记取自响应，成交时间和买卖价时间分别保存。价格历史保留原始 OHLCV，不在主备间拼接蜡烛，复权状态标为 source-default-unverified；收盘边界覆盖仍保守标记。

令牌按 expires_at / expires_in 提前 2 分钟刷新。仅有原始 token 响应而无绝对到期时间时，会先刷新来确定有效期，不依赖文件修改时间。并发请求共享刷新任务，跨进程使用文件锁；新令牌验证后在原目录原子替换。刷新失败保留旧文件。401 只刷新重试一次；429 尊重 Retry-After；403 只冷却该数据集。服务持续工作时会按需刷新，不运行“永久续期”定时器。

refresh token 可能失效或被撤销，不保证无限续期。Schwab / schwab-py 当前授权说明应以账户实测为准：
https://schwab-py.readthedocs.io/en/latest/auth.html

诊断 `schwab` 包含 status、retryAt、lastSuccessAt、expiresAt、reauthorizationRequired，不包含密钥或上游错误正文。SCHWAB_AUTH_REQUIRED 表示缺少有效 token 或需要重新授权；此时备用源仍工作。替换 token 后最多等待 5 分钟冷却，或重启服务立即恢复检查。

验收必须分别记录：代码与故障模拟通过、Schwab 真实授权与行情请求通过、公共接口实际 source 为 schwab、网页视觉检查。缺少 token 时不得宣称 Schwab 已实际供数。回滚可关闭 SCHWAB_ENABLED 或切回 previous 发布目录。

## v126 实测修正

真实授权刷新、NVDA/AAPL/QQQ/LITE 实时报价标记，以及 NVDA 日线和分钟线已通过服务器请求验证。配置主源切换允许同一交易日、同一时段的健康主源替换网站整秒/时段时间戳，保留真实毫秒成交时间；同一来源内仍严格拒绝倒退。休市确认周期与一分钟批量查询保持一致。完整业务与公共接口验收另记部署记录。
