# QQQSP 2.4 部署说明

交付日期：2026-09-11。应用版本：2.4.0。静态资源序号：77。本包是包含前端构建产物的完整源码，不需要混合覆盖旧补丁。

## 一、运行要求与升级范围

本版继续使用单个 Node 进程和内存缓存。需要 Node.js 22.16 或更新版本（推荐24）；本轮实际验收使用22.16.0。不需要安装 npm 运行依赖，不要求数据库或外部模型。

宏观模块与全球市场目录调换位置，新增跨资产观察和条件影响说明；原股票、韩国股、期货搜索和各周期图表保留。持久化自选仍在浏览器本地，保留原域名可继续使用。安装器不会修改域名、隧道或反向代理。

## 二、推荐的 systemd 安装与升级

使用服务器上所有用户均可执行的 Node 路径。首次安装默认监听回环地址8568，不直接对公网开放。

```bash
node --version
unzip qqqsp-v2.4-source.zip
cd qqqsp-v2.4
sudo env NODE_BIN="$(command -v node)"   bash ops/install.sh /opt/qqqsp-v2 8568
node ops/macro-smoke.mjs http://127.0.0.1:8568
```

服务名始终为 `qqqsp-v2.service`。已有相同服务时，本操作是原位发布新版本，会重启该服务；不意味着另开一个同名服务并行运行。其他旧版独立服务不主动停止。安装目录已有 `shared/.env` 时保留它，包括旧端口；若端口不是8568，下文地址也要改为实际端口。

安装目录结构：

```text
/opt/qqqsp-v2/
  current -> releases/新版本目录
  previous -> releases/上一版本目录
  releases/...
  shared/.env
  shared/state/
  shared/logs/
```

安装器仅复制运行文件、`lib`、`public`、`data`，不安装测试样本、浏览器截图、历史运维工具。安装失败时尝试恢复已有上一版本，不删除共享数据。

检查状态：

```bash
sudo systemctl status qqqsp-v2 --no-pager
sudo journalctl -u qqqsp-v2 -n 60 --no-pager
```

最后将现有反向代理或隧道的本地目标设为 `http://127.0.0.1:实际端口`。刷新页面确认 `panel.bundle.js?v=77`；不必清空自选列表。

## 三、不使用 systemd 的直接启动

直接启动仅用于已有进程管理器或临时核验，不会自动配置开机启动。

```bash
cp .env.example .env
# 修改 .env 中 PORT，避免与旧服务冲突；默认值是8567
bash start.sh
```

程序默认仅监听127.0.0.1；服务器上的隧道或反向代理访问此地址。不要为了调试随意公开状态接口或密钥配置。

## 四、宏观功能配置

不配置新密钥即可使用宏观资讯和公共价格观察；来源不可达时标注错误，不能把“未配置日历”理解为部署失败。新增官方订阅使用原有 `PUBLIC_SOURCE_REDUNDANCY=1` 开关（默认开启）；已有共享配置若明确设为0，需要改为1后重启才能启用官方源。

使用自己的 Trading Economics 经济日历权限时，在以下文件追加配置；升级不会自动向旧共享配置写入新密钥。

```bash
sudoedit /opt/qqqsp-v2/shared/.env
```

```dotenv
TE_API_KEY=填写自己的接口凭据
```

```bash
sudo systemctl restart qqqsp-v2
```

密钥通过服务端 Authorization 请求头发送，不发送给浏览器，不写入请求 URL。401/403停止重复尝试，修正凭据后重启；429遵守返回等待时间。不附带公共凭据、不假定免费账户具有完整权限。

日历普通时段约5分钟读取；距离已知事件前后15分钟内约1分钟。只有宏观展开、前台检查驱动时采集。需要记录发布前预期时，应提前打开宏观模块；记录仅保存在该进程内存，重启后明确显示缺少发布前记录。

## 五、验收命令与状态解释

默认验收检查服务、版本和页面位置，不主动请求宏观来源。真实来源验收会额外请求真实资讯及五个观察来源，任一来源无有效价格或仍有错误时返回非零退出码，输出缺失来源，而不是掩盖失败。

```bash
node ops/macro-smoke.mjs http://127.0.0.1:8568
node ops/macro-smoke.mjs http://127.0.0.1:8568 --live
# 保留的期货与历史验收：
node ops/futures-smoke.mjs http://127.0.0.1:8568
node ops/history-smoke.mjs http://127.0.0.1:8568 NVDA,MRVL
```

`--live` 成功只表示取得来源价格和资讯，不表示所有价格无延迟。首次展开约15分钟内显示“采样积累中”正常；休市、已声明延迟、来源时间陈旧或不同序列切换时不强行形成同步比较。美债10年指标保留来源原值，不冒称已经完成收益率单位或基点换算。

若来源冷却，不要反复重启或提高并发绕过等待。先检查源状态、服务器 DNS 与网络。无密钥时结构化日历显示未配置，不影响默认模式验收。

## 六、回滚、复现和交付边界

已有上一部署版本时，在本次解压目录运行：

```bash
sudo bash ops/rollback.sh /opt/qqqsp-v2
```

首次从另一个独立旧站迁移时，没有该安装目录的上一版本；通过将隧道重新指向保留的旧站回退。

开发验证命令：

```bash
node scripts/verify.mjs
node tests/run.mjs
# 以下需要测试环境已装 Python Playwright 和 Chromium；生产运行不需要它们。
python3 tests/v2/macro_browser_check.py
python3 tests/v2/chart_browser_check.py
python3 tests/v2/futures_browser_check.py
python3 tests/v2/browser_check.py
```

本次已检验完整构建、受控故障回归、浏览器与压缩包解压启动。未在你的生产服务器执行 systemd 安装、隧道切换和长期观测，未使用真实 Trading Economics 账户验证权限。测试截图标有模拟数据说明，生产入口不会载入测试行情。
