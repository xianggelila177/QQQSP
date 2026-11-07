# Schwab 美股主源（v128）

在服务端私有配置中启用：

```dotenv
SCHWAB_ENABLED=1
SCHWAB_ENV_FILE=/opt/schwab/schwab.env
SCHWAB_TOKEN_FILE=/opt/schwab/token.json
```

`schwab.env` 保存 SCHWAB_CLIENT_ID 与 SCHWAB_CLIENT_SECRET；`token.json` 为首次 OAuth 授权兑换后的完整 token 响应，也接受 schwab-py 的 token 包装格式。目录权限 700、文件 600，由应用服务用户持有。不要提交、打印或公开这些文件。原文档的 quote.sh / refresh.sh 不作为运行依赖，也不要与应用同时轮换同一 token。

Schwab 开关开启后，普通美国股票与 ETF（当前仅纯字母数字代码）的批量报价和日线、1/5/15/30 分钟线优先使用 Schwab。各源有独立失败窗口，主源不可用时继续使用原有 Finnhub / Naver / Tencent / Sina 报价，以及原有历史备用源。其他市场、指数、期货、含分隔符的特殊代码保持既有来源。新闻保持原有来源。基本面目前接入可明确映射的 52 周区间，其余财务字段继续使用既有来源，避免混淆单位和报告期。

报价每 5 秒最多更新一次，同批共享结果；所有 Schwab REST 请求共享至少 750 毫秒启动间隔，最多 8 个请求，超时 10 秒。请求上限是本应用的保守预算，不是账户额度或实时性承诺。实时标记取自响应，成交时间和买卖价时间分别保存。价格历史保留原始 OHLCV，不在主备间拼接蜡烛，复权状态标为 source-default-unverified；收盘边界覆盖仍保守标记。

令牌按 expires_at / expires_in 提前 2 分钟刷新。仅有原始 token 响应而无绝对到期时间时，会先刷新来确定有效期，不依赖文件修改时间。并发请求共享刷新任务，跨进程使用文件锁；新令牌验证后在原目录原子替换。刷新失败保留旧文件。401 只刷新重试一次；429 尊重 Retry-After；403 只冷却该数据集。v128 定时器每十分钟检查令牌与授权状态，在完整授权成功六天后开始尝试浏览器重新授权。

refresh token 可能失效或被撤销，不保证无限续期。Schwab / schwab-py 当前授权说明应以账户实测为准：
https://schwab-py.readthedocs.io/en/latest/auth.html

诊断 `schwab` 包含 status、retryAt、lastSuccessAt、expiresAt、reauthorizationRequired，不包含密钥或上游错误正文。SCHWAB_AUTH_REQUIRED 表示缺少有效 token 或需要重新授权；此时备用源仍工作。替换 token 后最多等待 5 分钟冷却，或重启服务立即恢复检查。

验收必须分别记录：代码与故障模拟通过、Schwab 真实授权与行情请求通过、公共接口实际 source 为 schwab、网页视觉检查。缺少 token 时不得宣称 Schwab 已实际供数。回滚可关闭 SCHWAB_ENABLED 或切回 previous 发布目录。

## v126 实测修正

真实授权刷新、NVDA/AAPL/QQQ/LITE 实时报价标记，以及 NVDA 日线和分钟线已通过服务器请求验证。配置主源切换允许同一交易日、同一时段的健康主源替换网站整秒/时段时间戳，保留真实毫秒成交时间；同一来源内仍严格拒绝倒退。休市确认周期与一分钟批量查询保持一致。完整业务与公共接口验收另记部署记录。

## v127 每七天自动保活（已由 v128 替代）

服务器使用 `schwab-token-refresh.timer`，每周日北京时间 04:17（间隔七天）执行；开机五分钟后执行一次，离线错过日程时由 Persistent 补跑。它独立于网页、Codex 和行情进程，调用同一个 Node 令牌管理器，禁止再安装旧版 curl 刷新脚本并发改写 token。

在既定 `/opt/qqqsp-v2` / `qqqsp` 服务用户布局安装：

```sh
install -m 644 ops/schwab-token-refresh.service /etc/systemd/system/
install -m 644 ops/schwab-token-refresh.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now schwab-token-refresh.timer
systemctl start schwab-token-refresh.service
systemctl list-timers schwab-token-refresh.timer
journalctl -u schwab-token-refresh.service -n 10 --no-pager
```

定时器即使在 access token 尚有效时也尝试刷新；加锁后发现另一个进程已保存更新令牌则复用该结果。临时网络失败每五分钟重试，最多一小时四次；需要重新授权的错误不反复重试。日志只包含成功时间、计数、令牌是否轮转和固定错误码，不包含任何凭据。

token 中的 `qqqsp_refresh_audit` 持久化首次观察时间、最后成功时间和成功计数；公开诊断显示这些时间/计数。首次观察时间不等于首次登录时间，令牌轮转不证明授权期限重置，单元测试模拟七天不算真实跨七天验收。

每周自动执行已实现，但嘉信拒绝续期后仍需要新的浏览器授权。定时器不会绕过此限制，也不承诺永久免登录。数据服务会继续使用备用源。回滚到不含 keepalive 脚本的版本前，应先停用该定时器；删除定时器不删除凭据或行情数据。

## v128 复用服务器会话的滚动授权

此模式由用户选择：首次手动登录，后续只复用服务器专用浏览器的会话，不保存或自动填写网页登录密码。它通过完整 `authorization_code` 流程取得新的 token 对，不把普通 `refresh_token` 调用当成延长七天授权。只有完整授权成功才更新 `qqqsp_authorization.authorized_at_ms` 和六天后的 `renew_at_ms`。七天到期时间仅为估计；嘉信仍可使会话或凭证提前失效。

运行要求：Linux 已安装 Google Chrome，Node 24，`flock`；无需新增 npm 运行时依赖。浏览器由 qqqsp 用户运行，使用 `/opt/schwab/browser` 专用配置；保留会话 Cookie 和受信任设备状态，禁用密码管理器保存密码。Chrome 保持沙箱及 TLS 验证。DevTools 通过继承管道通信，不开放调试端口。

安装三个 unit 后运行：

```sh
install -m 644 ops/schwab-token-refresh.service ops/schwab-token-refresh.timer ops/schwab-auth-bootstrap.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now schwab-token-refresh.timer
systemctl start --no-block schwab-auth-bootstrap.service
```

在自己的电脑建立隧道，再打开 `http://127.0.0.1:18774`：

```sh
ssh -N -L 127.0.0.1:18774:127.0.0.1:18774 root@YOUR_SERVER
```

页面呈现服务器上的嘉信浏览器。用户亲自完成登录、验证、授权范围选择，并在嘉信提示时设置受信任设备。工具不自动扩大账户授权范围。页面仅绑定服务器回环地址，拒绝跨站请求，不记访问日志，十五分钟超时。输入经 SSH 隧道到服务器浏览器；不要通过公网反向代理暴露这个入口。

授权回调必须匹配私有配置中的 HTTPS redirect URI、随机 state 和单个有效 code；在浏览器发送回调之前拦截，无需修改开发者门户的现有回调。兑换与普通刷新共用短文件锁，浏览器操作另由 flock 串行化，不长期锁住行情刷新。旧刷新完成后才写入新授权，因此不会用旧结果覆盖新凭证。

定时器每十分钟检查一次，六天前只维护短期 access token，不启动浏览器；六天后复用会话尝试重新授权。网络或浏览器临时错误按 5 分钟、30 分钟、2 小时、6 小时退避（实际执行取下一次十分钟调度）。需要登录、二次验证、授权范围确认或浏览器被拒绝时持久化 `requiresUserAction`，停止自动登录重试；备用行情继续工作。再次启动 bootstrap 完成人工授权即可恢复。会话由嘉信决定是否继续有效，因此该模式不能保证永久无人值守。

检查：`journalctl -u schwab-token-refresh.service`、`systemctl list-timers schwab-token-refresh.timer`，以及网站“来源状态”中的嘉信授权行。公开 API 只显示授权时间、续期时间和状态，私有状态文件是 `/opt/schwab/token.json.renewal.json`。首次观察时间不作为授权起点；缺少可信授权时间时显示 `BOOTSTRAP_REQUIRED`。

验收要区分：代码模拟、服务器真实浏览器、一次真实人工授权、一次关闭再启动浏览器后的无人工重新授权，以及跨两个真实周期的连续运行。短期成功不证明永久免登录。回滚到 v127 时恢复 v127 的刷新 service/timer 并停用 bootstrap；保留最新 token 和浏览器配置，不恢复旧凭证。
