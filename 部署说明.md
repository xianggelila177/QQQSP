# QQQSP 2.3 部署与升级说明

本包为完整源码与构建产物，升级现有2.2服务时使用同一安装路径与域名，保留配置和浏览器自选。包含 `lib/` 后端、`public/` 前端、`data/futures-products.json` 期货目录、安装脚本及测试代码；无需 `npm install`。

## 一、环境与解压

运行只需要 Node.js **22.16或更新版本**。持久服务安装使用 Linux、systemd 和管理员权限；本轮实际验证环境为Node22.16.0，不把未执行的Node版本写成测试通过。

```bash
node --version
unzip qqqsp-v2.3-source.zip
cd qqqsp-v2.3
sha256sum -c SHA256SUMS
```

不要先删除旧安装。Python、Playwright、Chromium仅用于开发复测，不是生产依赖。

## 二、安装或升级

安装器创建新的release，保留 `shared/.env`、状态和日志，切换服务；启动检查失败时恢复上一release。它只检查服务就绪，不能代替真实行情验收。

```bash
sudo env NODE_BIN="$(command -v node)" bash ops/install.sh /opt/qqqsp-v2 8568
sudo systemctl status qqqsp-v2 --no-pager
```

服务名仍为 `qqqsp-v2.service`。现有路径不是 `/opt/qqqsp-v2` 时替换为实际路径，避免无意装出第二份服务。已有配置时，8568参数不覆盖已有PORT；下面命令也应使用实际端口。

| 位置 | 作用 |
|---|---|
| `/opt/qqqsp-v2/shared/.env` | 持久配置，不会被升级覆盖 |
| `/opt/qqqsp-v2/shared/state/` | 原有行情恢复文件 |
| `/opt/qqqsp-v2/shared/logs/` | 应用日志 |
| `/opt/qqqsp-v2/current` | 当前release链接 |
| `/opt/qqqsp-v2/previous` | 上一release链接 |

Node在root个人目录且服务用户没有执行权限时，先使用服务用户可执行的系统Node路径，不要扩大root目录权限。安装器会重启同名服务，但不修改其他服务、隧道、Nginx和DNS。

## 三、分别验收搜索和真实行情

搜索命中不代表来源网络正常。先运行不依赖外部行情的检查，再单独验证新期货的真实报价和四档历史。

```bash
# 服务、资源和基础链路
node ops/smoke.mjs http://127.0.0.1:8568
# 本地检索、代码类型与国际期货目录；不请求实时价格
node ops/futures-smoke.mjs http://127.0.0.1:8568
# 目标服务器真实行情验证；来源失败时返回非零退出状态
node ops/futures-smoke.mjs http://127.0.0.1:8568 --live NQ00Y.FUT
# Yahoo是独立系列，可另行检查；被429时等待冷却再运行
node ops/futures-smoke.mjs http://127.0.0.1:8568 --live NQ=F
# 保留股票历史的检查
node ops/history-smoke.mjs http://127.0.0.1:8568 NVDA,MRVL
```

`--live` 会请求生产服务本身的真实报价及日、周、月、年历史，不注入测试数据；仅取得旧缓存不计通过。历史检查成功代表本次网络环境下能取得数据，不代表无延迟、全天候持续可用或连续换月口径完全一致。

来源限流时保留错误与等待时间，不连续重跑。所有来源失效时不会生成假价格、假K线。日志查看：

```bash
sudo journalctl -u qqqsp-v2 -n 100 --no-pager
```

## 四、页面使用与缓存更新

前端资源序号为 **76**；升级后接受更新提示或强制刷新，确认 `panel.bundle.js?v=76`。已安装应用窗口需要关闭后重新打开，不必清空localStorage。

搜索 `NQ0W` 会提示其标准身份尚未核实，列出 `NQ00Y.FUT` 与 `NQ=F` 相关候选。可直接搜索 `纳指夜盘`、`NQ00Y` 或 `NQ=F`；点击候选加入自选。它们属于期货，不能拿现货纳斯达克综合指数的代码替代。

“查询更多来源与具体合约”会按需查询远端。具体月份示例代码形如 `NQ26Z.FUT`，但实际可选月份以当时返回结果为准，文档示例不是预先保证该合约有行情。保留月份身份，不合并成连续合约。

股指期货显示“点”、禁用货币换算按钮；涨跌参考值显示“来源基准”或“前结算”，不误写成股票昨收。期货时段未核验时显示未知，仍继续按计划读取，不按股票夜间休市停止。

东方财富当前接入报价与历史日线，未接入专用历史分时。报价有真实时间时显示明确标记的“报价采样”；日/周/月/年显示来源开高低收数据。Yahoo分时使用其来源图表数据；来源失败时可能为空或显示采样，不承诺补全历史。

新增期货报价默认5秒采集，目录备源30秒；报价年龄独立每秒变化。原股票调度保持原设计。代码不绕过429，不声称获得CME授权实时数据。

## 五、域名与直接启动

同路径同端口升级一般不需要修改反向代理。首次并行部署时将现有隧道本地目标转到 `http://127.0.0.1:8568`；已有正常事件流配置不必重新配置。Nginx的 `/api/stream` 路由应禁用响应缓冲。

不使用systemd时：

```bash
cp .env.example .env
# 编辑HOST和PORT；示例默认PORT=8567
bash start.sh
```

应用默认监听回环地址。需要外网访问时由现有反向代理及访问控制保护；本程序没有用户认证体系，不应作为无限制公开数据服务。可选Alpaca/Finnhub凭据仍仅放服务端，新期货公共源不要求它们，但是否有权限使用、转发数据应遵守提供方条款。

## 六、回滚与边界

已存在上一release时，可保留共享配置回滚；首次部署没有上一release，应保留原服务或备份。

```bash
sudo bash ops/rollback.sh /opt/qqqsp-v2
sudo systemctl status qqqsp-v2 --no-pager
```

本次未登录你的服务器，未执行真实systemd安装、隧道切换或生产上游联调；本地解压启动与受控行情测试不代替目标服务器验证。运行时入口不会加载测试行情。

## 七、完成标准

安装、资源版本、本地搜索、真实期货报价与四档历史、原股票功能检查均通过后，再作为日常入口。保留上一版本，直到实际交易时段使用确认正常。
